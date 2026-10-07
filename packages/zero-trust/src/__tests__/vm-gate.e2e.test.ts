/** Feasibility gate 1 (#1009, scenario 4): runs the hostile fixtures in a real
 * local VM against freshly planted host canaries and requires the boundary to
 * hold. Needs QEMU and a baked profile, so it only runs with ZT_VM_E2E=1:
 *
 *   ZT_VM_E2E=1 ZT_PROFILE_DIR=<baked profile> [ZT_ACCEL=auto|kvm|tcg] \
 *   [ZT_EVIDENCE_OUT=evidence.json] npx vitest run src/__tests__/vm-gate.e2e.test.ts
 *
 * The verdict comes from host-side measurements (canary values in any guest
 * byte, connections on the planted listeners, broker rejections); fixture
 * reports are untrusted and can only add violations. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutputCollector } from '../controller/output-collector';
import type { AcceleratorRequest, ContainerProfile, VmHandle } from '../vm/adapter';
import {
  BOUNDARY_PHASES,
  boundaryBrokerChecks,
  finishBoundary,
  prepareBoundary,
  probeBoundary,
  runBoundaryVerdict,
  uploadBoundaryFixture,
} from '../vm/boundary-probe';
import {
  assertBoundaryHeld,
  type BoundaryEvidence,
  evaluateBoundary,
  type ProbeReport,
  parseReport,
  parseReports,
} from '../vm/evidence';
import { LocalQemuAdapter } from '../vm/local-qemu';
import {
  HOST_ENFORCED,
  hex,
  E2E_LIMITS as LIMITS,
  type PlantedCanaries,
  plantCanaries,
  rootProbeArgv,
  timer,
} from './vm-e2e-harness';

const ENABLED = process.env.ZT_VM_E2E === '1';
/** Every report the fixtures must produce, as results/<probe>-<phase>.json. */
const CONTAINER_PHASES = BOUNDARY_PHASES;

describe.skipIf(!ENABLED)('execution profile gate (real VM)', () => {
  const guestOutputs: string[] = [];
  const reports: ProbeReport[] = [];
  const brokerChecks: { attempt: string; rejected: boolean }[] = [];
  const timings: Record<string, number> = {};
  let malformedReports = 0;
  let adapter: LocalQemuAdapter;
  let stateDir: string;
  let runtimeDir: string;
  let planted: PlantedCanaries;
  let evidence: BoundaryEvidence | undefined;
  const timed = timer(timings);

  beforeAll(async () => {
    const profileDir = process.env.ZT_PROFILE_DIR;
    if (!profileDir || !path.isAbsolute(profileDir))
      throw new Error('ZT_PROFILE_DIR must be the absolute path of a baked profile');
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-gate-state-'));
    // Short on purpose: broker socket paths must fit in sun_path.
    runtimeDir = fs.mkdtempSync('/tmp/ztr-');
    planted = await plantCanaries();
    adapter = new LocalQemuAdapter({
      profileDir,
      stateDir,
      runtimeDir,
      accelerator: (process.env.ZT_ACCEL ?? 'auto') as AcceleratorRequest,
    });
  });

  afterAll(async () => {
    planted?.cleanup();
    const out = process.env.ZT_EVIDENCE_OUT;
    if (out && adapter)
      fs.writeFileSync(
        out,
        `${JSON.stringify(
          {
            accelerator: adapter.accelerator,
            timings,
            held: evidence?.held ?? false,
            violations: evidence?.violations ?? ['evaluation did not run'],
            coverage: evidence?.coverage ?? {},
            attempts: evidence?.attempts ?? 0,
            listenerConnections: planted?.connections() ?? 0,
            brokerChecks,
            reports: reports.map((r) => ({ probe: r.probe, phase: r.phase, records: r.records })),
          },
          null,
          2
        )}\n`
      );
    for (const dir of [stateDir, runtimeDir])
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function upload(vm: VmHandle, fixture: string): Promise<void> {
    await uploadBoundaryFixture(adapter, vm, fixture, planted.targets);
  }

  async function run(
    label: string,
    vm: VmHandle,
    profile: ContainerProfile,
    argv: string[],
    cwd: string
  ): Promise<void> {
    const result = await timed(label, () => adapter.exec(vm, { profile, argv, cwd }));
    guestOutputs.push(result.stdout, result.stderr);
    malformedReports += parseReports(`${result.stdout}\n${result.stderr}`).malformed;
    expect(result.timedOut, `${label} timed out`).toBe(false);
    expect(result.exitCode, `${label} failed:\n${result.stderr.slice(-2000)}`).toBe(0);
  }

  /** Report files are read back through the broker; their bytes are guest output too. */
  async function collect(vm: VmHandle, fixture: string, keep?: (category: string) => boolean) {
    for (const phase of CONTAINER_PHASES[fixture]) {
      const bytes = (await adapter.getFile(vm, `${fixture}/results/${phase}.json`)).toString(
        'utf8'
      );
      guestOutputs.push(bytes);
      let report: ProbeReport;
      try {
        report = parseReport(JSON.parse(bytes));
      } catch {
        malformedReports++;
        continue;
      }
      reports.push(
        keep ? { ...report, records: report.records.filter((r) => keep(r.category)) } : report
      );
    }
  }

  it(
    'denies every attack category in the worker container',
    async () => {
      const runId = `gate-${hex(4)}`;
      const vm = await timed('containerBootMs', () =>
        adapter.create({ runId, limits: LIMITS, scope: 'container' })
      );
      try {
        // Broker abuse from the controller side: nothing outside the fixed
        // operation set or the size caps may reach the guest.
        brokerChecks.push(...(await boundaryBrokerChecks(adapter, vm)));
        await upload(vm, 'npm-lifecycle');
        await upload(vm, 'pip-setup');
        await run(
          'npmInstallMs',
          vm,
          'node',
          ['npm', 'install', '--offline', '--no-audit', '--no-fund', '--foreground-scripts'],
          'npm-lifecycle'
        );
        await run('npmTestMs', vm, 'node', ['npm', 'test'], 'npm-lifecycle');
        await run(
          'pipInstallMs',
          vm,
          'python',
          [
            'sh',
            '-c',
            'python3 -m venv --system-site-packages /tmp/venv && /tmp/venv/bin/pip install -v --no-index --no-deps --no-build-isolation .',
          ],
          'pip-setup'
        );
        await run(
          'pipTestMs',
          vm,
          'python',
          ['python3', '-m', 'unittest', '-v', 'test_witness'],
          'pip-setup'
        );
        await collect(vm, 'npm-lifecycle');
        await collect(vm, 'pip-setup');
      } finally {
        await timed('containerDestroyMs', () => adapter.destroy(vm));
      }
      expect(await adapter.listByRun(runId)).toEqual([]);
    },
    3 * 3600_000
  );

  it(
    'holds the host-side boundary for root inside the VM (assumed container escape)',
    async () => {
      const runId = `gate-root-${hex(4)}`;
      const vm = await timed('vmRootBootMs', () =>
        adapter.create({ runId, limits: LIMITS, scope: 'vm-root' })
      );
      try {
        await upload(vm, 'npm-lifecycle');
        // vm-root runs argv as root on the VM itself, on the VM's own network stack.
        const result = await timed('vmRootProbeMs', () =>
          adapter.exec(vm, { profile: 'node', argv: rootProbeArgv('vm-root') })
        );
        guestOutputs.push(result.stdout, result.stderr);
        const parsed = parseReports(result.stdout);
        malformedReports += parsed.malformed;
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(0);
        expect(parsed.reports).toHaveLength(1);
        // Root in the VM is root by design: only host-enforced categories are judged here.
        for (const report of parsed.reports)
          reports.push({
            ...report,
            phase: 'vm-root',
            records: report.records.filter((r) => HOST_ENFORCED.has(r.category)),
          });
      } finally {
        await timed('vmRootDestroyMs', () => adapter.destroy(vm));
      }
    },
    3 * 3600_000
  );

  it('evaluates the evidence on the host and requires the boundary to hold', () => {
    evidence = evaluateBoundary({
      reports,
      guestOutputs,
      canaries: planted.canaries,
      listenerConnections: planted.connections(),
      brokerChecks,
      malformedReports,
    });
    expect(reports.map((r) => `${r.probe}-${r.phase}`).sort()).toEqual([
      'node-postinstall',
      'node-preinstall',
      'node-test',
      'node-vm-root',
      'python-install',
      'python-test',
    ]);
    expect(evidence.violations).toEqual([]);
    assertBoundaryHeld(evidence);
  });

  it(
    'gathers the production session after provisioning ends',
    async () => {
      const runId = `production-${hex(4)}`;
      const session = await prepareBoundary(stateDir);
      let vm: VmHandle | undefined;
      try {
        vm = await adapter.create({
          runId,
          limits: LIMITS,
          scope: 'container',
          phase: 'provisioning',
          proxyTarget: { host: '127.0.0.1', port: 9 },
        });
        await adapter.endProvisioning(vm);
        await probeBoundary(session, adapter, vm, 'python');
        const input = await finishBoundary(session, new OutputCollector(), runId);
        const verdict = runBoundaryVerdict([input], runId);
        expect(verdict.runId).toBe(runId);
        assertBoundaryHeld(verdict);
        expect(
          runBoundaryVerdict([JSON.parse(fs.readFileSync(session.artifactPath, 'utf8'))], runId)
        ).toEqual(verdict);
      } finally {
        try {
          session.cleanup();
        } finally {
          if (vm) await adapter.destroy(vm);
        }
      }
    },
    3 * 3600_000
  );
});
