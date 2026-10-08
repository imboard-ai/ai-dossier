/** Feasibility gate 2 (#1010, scenarios 6 and 7): npm, pip and uv fixtures provision
 * through the constrained package proxy inside the real VM, then verify with no
 * network against exact commits. Needs QEMU, a baked profile and the host proxy
 * stack (`scripts/zt-proxy.mjs up`), so it only runs with ZT_PROXY_E2E=1:
 *
 *   ZT_PROXY_E2E=1 ZT_PROFILE_DIR=<baked profile> ZT_PROXY_ENDPOINTS=<endpoints.json> \
 *   [ZT_ACCEL=auto|kvm|tcg] [ZT_PROXY_FIXTURES=npm,pip,uv] [ZT_PROXY_FULL=0|1] \
 *   [ZT_EVIDENCE_OUT=evidence.json] npx vitest run src/__tests__/vm-proxy.e2e.test.ts
 *
 * Since #1095 the fixture proofs, the tampered-lock case and the inconclusive cases call
 * the production evidence runner (`src/controller/evidence-runner.ts`) against the real
 * adapter, so this suite exercises that code; timings stay per VM label (bootMs,
 * provisionMs, phaseSwitchMs, verifyMs) through a timing wrapper around the adapter.
 *
 * ZT_PROXY_FULL=0 runs only the fixture proofs (the TCG timing job). Everything the
 * guest says about itself is untrusted; verdicts come from exit codes, supervisor-read
 * reports, Squid's own access log, the mirror caches and host-side measurements. */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSource, type SourceManifest, sha256 } from '../canonical/export';
import {
  baselineEvidence,
  type CommandRecord,
  ProvisioningFailedError,
  provisionWorkspace,
  regressionEvidence,
  releaseWorkspace,
  runPlanned,
  type WorkspaceEvidence,
  type WorkspaceOptions,
} from '../controller/evidence-runner';
import { OutputCollector } from '../controller/output-collector';
import { applyVerification, classifyRegression } from '../ecosystem/classify';
import { buildCommandPlan, type PlannedCommand, REPORT_PATH } from '../ecosystem/commands';
import {
  detectEcosystem,
  type PackageManager,
  type SupportedDetection,
  sourceFilesFromManifest,
} from '../ecosystem/detect';
import {
  PROFILE_MANIFEST,
  type ProfileRecord,
  profileManifestDigest,
  profileReceiptBinding,
  recordProfileSelection,
  selectProfile,
} from '../ecosystem/profiles';
import {
  buildLockIndex,
  checkArtifact,
  evaluateRequest,
  PROXY_POLICY,
  parseSquidAccessLog,
} from '../ecosystem/proxy';
import { issueReceipt } from '../receipt/issue';
import type { CommandStatus } from '../receipt/schema';
import { canonicalJson } from '../receipt/schema';
import { createRun, ReasonCode as R, type RunRecord, transitionRun } from '../state';
import type { AcceleratorRequest, ContainerProfile, VmAdapter, VmHandle } from '../vm/adapter';
import {
  assertBoundaryHeld,
  type BoundaryEvidence,
  evaluateBoundary,
  type ProbeReport,
  parseReports,
} from '../vm/evidence';
import { LocalQemuAdapter } from '../vm/local-qemu';
import { assertProfileBaked } from '../vm/profile';
import { WORKER_RELAY } from '../vm/qemu-args';
import {
  HOST_ENFORCED,
  hex,
  E2E_LIMITS as LIMITS,
  type PlantedCanaries,
  plantCanaries,
  rootProbeArgv,
  timer,
} from './vm-e2e-harness';

const ENABLED = process.env.ZT_PROXY_E2E === '1';
const FULL = process.env.ZT_PROXY_FULL !== '0';
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures', 'ecosystem');
const HOSTILE = path.join(ROOT, 'fixtures', 'hostile', 'npm-lifecycle');
const MANAGERS = (process.env.ZT_PROXY_FIXTURES ?? 'npm,pip,uv')
  .split(',')
  .filter(Boolean) as PackageManager[];
const REGRESSION: Record<PackageManager, string[]> = {
  npm: ['test/regression.test.js'],
  pip: ['tests/test_regression.py'],
  uv: ['tests/test_regression.py'],
};
/** The worker sees only the relay; the controller splices it to one mirror. */
const RELAY = `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/`;
const RELAY_ENDPOINTS = { npmRegistry: RELAY, pypiIndex: `${RELAY}index/` };
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ztfc-fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'ztfc-fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z',
};
const TIME = '2026-10-06T00:00:00.000Z';

interface Endpoints {
  npm: { host: string; port: number };
  pypi: { host: string; port: number };
  accessLog: string;
  verdaccioStorage: string;
  proxpiCache: string;
  images: Record<string, string>;
}

/** A production command record plus which fixture commit it ran on. */
type FixtureRecord = CommandRecord & { fixture: string; commit: string; sha: string };

function git(args: string[], cwd: string): Buffer {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

/** base, base + regression test, base + regression test + fix: three exact commits. */
function buildCommits(manager: PackageManager): { dir: string; shas: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ztfc-${manager}-repo-`));
  fs.cpSync(path.join(FIXTURES, manager, 'base'), dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  const commit = (message: string) => {
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', message], dir);
    return git(['rev-parse', 'HEAD'], dir).toString().trim();
  };
  const shas: Record<string, string> = { base: commit('base') };
  git(['apply', path.join(FIXTURES, manager, 'regression.patch')], dir);
  shas.regression = commit('test: add regression test');
  git(['apply', path.join(FIXTURES, manager, 'fix.patch')], dir);
  shas.fix = commit('fix: known bug');
  return { dir, shas };
}

/** Every blob of one commit, exactly: the workspace is that tree and nothing else. */
function commitTree(dir: string, sha: string): { path: string; bytes: Buffer; exec: boolean }[] {
  const listing = git(['ls-tree', '-r', '-z', '--full-tree', sha], dir).toString('utf8');
  return listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const [mode, type, object] = meta.split(' ');
      if (type !== 'blob') throw new Error(`unexpected tree entry ${type}`);
      return { path: file, bytes: git(['cat-file', 'blob', object], dir), exec: mode === '100755' };
    });
}

/** One exact commit as the canonical manifest the runner provisions from: the commit's
 * tree, extracted by git itself, exported like any source. */
function commitManifest(dir: string, sha: string): SourceManifest {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ztfc-commit-'));
  try {
    const extracted = spawnSync('tar', ['-x', '-C', tree], {
      input: git(['archive', '--format=tar', sha], dir),
    });
    if (extracted.status !== 0) throw new Error(`tar -x failed: ${extracted.stderr}`);
    return exportSource(tree);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

/** Files the regression commit added or changed: the test files only. */
function testFilesOf(repo: { dir: string; shas: Record<string, string> }): string[] {
  return git(['diff', '--name-only', repo.shas.base, repo.shas.regression], repo.dir)
    .toString()
    .split('\n')
    .filter(Boolean);
}

/** What detection and profile selection say about a fixture: its lockfile, the worker
 * image ecosystem, and the selection the receipt binds. Detection is the source. */
function fixtureInfo(manager: PackageManager) {
  const detection = detectEcosystem(
    sourceFilesFromManifest(exportSource(path.join(FIXTURES, manager, 'base')))
  );
  if (!detection.supported) throw new Error(`fixture rejected: ${detection.reason}`);
  if (detection.manager !== manager) throw new Error(`fixture detected as ${detection.manager}`);
  const selection = selectProfile(detection as SupportedDetection);
  if (!selection.ok) throw new Error(`no profile: ${selection.reason}`);
  const profile: ContainerProfile = selection.profile.ecosystem;
  assertProfileBaked(profile, selection.profile.id);
  return { lockfile: detection.lockfile, profile, selection };
}

describe.skipIf(!ENABLED)('package proxy gate (real VM)', () => {
  const timings: Record<string, number> = {};
  const commands: FixtureRecord[] = [];
  const fixtures: Record<string, unknown> = {};
  const tamper: Record<string, unknown>[] = [];
  const inconclusive: Record<string, unknown>[] = [];
  const unsupported: Record<string, unknown>[] = [];
  const reports: ProbeReport[] = [];
  const guestOutputs: string[] = [];
  const brokerChecks: { attempt: string; rejected: boolean }[] = [];
  const indexes: ReturnType<typeof buildLockIndex>[] = [];
  let uvSyncFrozen: Record<string, unknown> | null = null;
  let cacheAudit: Record<string, unknown> | null = null;
  let squidAudit: Record<string, unknown> | null = null;
  let repairCap: Record<string, unknown> | null = null;
  let boundary: BoundaryEvidence | undefined;
  let malformedReports = 0;
  let adapter: LocalQemuAdapter;
  let endpoints: Endpoints;
  let stateDir: string;
  let runtimeDir: string;
  let recordDir: string;
  let keyDir: string;
  let signer: Ed25519Signer;
  let planted: PlantedCanaries;
  const timed = timer(timings);

  beforeAll(async () => {
    const profileDir = process.env.ZT_PROFILE_DIR;
    if (!profileDir || !path.isAbsolute(profileDir))
      throw new Error('ZT_PROFILE_DIR must be the absolute path of a baked profile');
    const endpointsFile = process.env.ZT_PROXY_ENDPOINTS;
    if (!endpointsFile) throw new Error('ZT_PROXY_ENDPOINTS must name the zt-proxy endpoints file');
    endpoints = JSON.parse(fs.readFileSync(endpointsFile, 'utf8')) as Endpoints;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-proxy-state-'));
    recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-proxy-records-'));
    runtimeDir = fs.mkdtempSync('/tmp/ztp-');
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-proxy-key-'));
    const keys = generateKeyPairSync('ed25519');
    const keyFile = path.join(keyDir, 'controller.pem');
    fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    signer = new Ed25519Signer(keyFile);
    // Canaries for the boundary probes, planted fresh (same design as gate 1).
    planted = await plantCanaries();
    adapter = new LocalQemuAdapter({
      profileDir,
      stateDir,
      runtimeDir,
      accelerator: (process.env.ZT_ACCEL ?? 'auto') as AcceleratorRequest,
    });
  });

  afterAll(() => {
    planted?.cleanup();
    const out = process.env.ZT_EVIDENCE_OUT;
    if (out && adapter)
      fs.writeFileSync(
        out,
        `${JSON.stringify(
          {
            accelerator: adapter.accelerator,
            proxy: { images: endpoints?.images, policy: PROXY_POLICY.version },
            profiles: {
              manifestVersion: PROFILE_MANIFEST.manifestVersion,
              workerHardening: PROFILE_MANIFEST.workerHardening,
              workerImages: adapter.manifest.containerImages,
              workerProfiles: adapter.manifest.workerProfiles,
            },
            timings,
            fixtures,
            commands,
            tamper,
            uvSyncFrozen,
            cacheAudit,
            squidAudit,
            inconclusive,
            repairCap,
            unsupported,
            boundary: boundary ?? null,
            listenerConnections: planted?.connections() ?? 0,
            collected: { bytes: collector.bytes, truncated: collector.truncated },
            brokerChecks,
          },
          null,
          2
        )}\n`
      );
    // Keep the VM journal-free diagnostics (QEMU's own stderr per VM and phase) next
    // to the evidence: they are host-side output and the only boot trace a run VM has.
    if (out && stateDir && fs.existsSync(path.join(stateDir, 'diagnostics')))
      fs.cpSync(path.join(stateDir, 'diagnostics'), `${out}.diagnostics`, { recursive: true });
    for (const dir of [stateDir, runtimeDir, recordDir, keyDir])
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const mirrorOf = (manager: PackageManager) =>
    manager === 'npm' ? endpoints.npm : endpoints.pypi;

  async function provisioningVm(manager: PackageManager, label: string): Promise<VmHandle> {
    return timed(`${label}.bootMs`, () =>
      adapter.create({
        runId: `proxy-${hex(4)}`,
        limits: LIMITS,
        scope: 'container',
        phase: 'provisioning',
        proxyTarget: mirrorOf(manager),
      })
    );
  }

  async function upload(vm: VmHandle, files: ReturnType<typeof commitTree>): Promise<void> {
    for (const file of files) await adapter.putFile(vm, file.path, file.bytes, file.exec);
  }

  const collector = new OutputCollector();
  const profileRecords = new Map<PackageManager, ProfileRecord>();
  function profileRecordOf(manager: PackageManager): ProfileRecord {
    let record = profileRecords.get(manager);
    if (!record) {
      record = recordProfileSelection(
        recordDir,
        `profile-${manager}`,
        fixtureInfo(manager).selection
      );
      profileRecords.set(manager, record);
    }
    return record;
  }
  function implementingRun(runId: string): RunRecord {
    return [R.GatePassed, R.PlanApproved].reduce(
      (r, reason) => transitionRun(r, reason, TIME),
      createRun(
        { runId, upstreamIssue: 'https://github.com/o/r/issues/1', contributor: 'ztfc' },
        TIME
      )
    );
  }
  /** The real adapter, timing each VM it creates under the next of `labels`: boot,
   * provisioning (upload and commands), phase switch, and verification up to destroy. */
  function timedAdapter(labels: string[]): VmAdapter {
    const marks = new Map<string, { label: string; at: number }>();
    const since = (vmId: string, key: string) => {
      const mark = marks.get(vmId);
      if (!mark) return undefined;
      timings[`${mark.label}.${key}`] = Date.now() - mark.at;
      return mark;
    };
    return {
      create: async (spec) => {
        const label = labels.shift() ?? `vm-${hex(2)}`;
        const vm = await timed(`${label}.bootMs`, () => adapter.create(spec));
        marks.set(vm.vmId, { label, at: Date.now() });
        return vm;
      },
      exec: (vm, request) => adapter.exec(vm, request),
      putFile: (vm, file, bytes, executable) => adapter.putFile(vm, file, bytes, executable),
      getFile: (vm, file) => adapter.getFile(vm, file),
      endProvisioning: async (vm) => {
        const mark = since(vm.vmId, 'provisionMs');
        await timed(`${mark?.label ?? vm.vmId}.phaseSwitchMs`, () => adapter.endProvisioning(vm));
        if (mark) mark.at = Date.now();
      },
      destroy: async (vm) => {
        since(vm.vmId, 'verifyMs');
        marks.delete(vm.vmId);
        await adapter.destroy(vm);
      },
      listByRun: (runId) => adapter.listByRun(runId),
    };
  }

  /** The production runner's inputs for one fixture: the real adapter (timed per VM
   * label), the fixture's mirror, its recorded profile and a run to fail into. */
  function workspaceOptions(manager: PackageManager, labels: string[]): WorkspaceOptions {
    const runId = `proxy-${hex(4)}`;
    const label = labels.join('+');
    return {
      adapter: timedAdapter([...labels]),
      runId,
      limits: LIMITS,
      profileRecord: profileRecordOf(manager),
      proxyTarget: mirrorOf(manager),
      collector,
      lifecycle: {
        run: implementingRun(runId),
        now: () => new Date(),
        observeRun: (run) => {
          if (process.env.ZT_PROXY_DEBUG === '1') console.error(`${label}: run ${run.state}`);
        },
      },
    };
  }

  /** Records the runner's evidence for one fixture commit, with its phase-switch check. */
  function keep(
    meta: { fixture: string; commit: string; sha: string },
    evidence: WorkspaceEvidence
  ): FixtureRecord[] {
    brokerChecks.push({
      attempt: `${meta.fixture}.${meta.commit}:${evidence.phaseSwitch.attempt}`,
      rejected: evidence.phaseSwitch.refusedWith === 'network_not_allowed',
    });
    const records = [...evidence.provisioning, ...evidence.records].map((r) => ({ ...meta, ...r }));
    commands.push(...records);
    for (const r of records)
      if (r.status !== 'passed' && process.env.ZT_PROXY_DEBUG === '1')
        console.error(`${meta.fixture}/${meta.commit}/${r.id}:\n${r.log.excerpt}`);
    return records.filter((r) => r.phase === 'verification');
  }

  /** The supervised test commands (the ones classified from a report). */
  const testStatus = (records: FixtureRecord[]) => records.filter((r) => r.captureReport);

  for (const manager of MANAGERS)
    it(
      `${manager}: provisions through the proxy, reproduces the bug offline and verifies the fix`,
      async () => {
        const { lockfile, selection } = fixtureInfo(manager);
        const repo = buildCommits(manager);
        indexes.push(
          buildLockIndex(manager, fs.readFileSync(path.join(repo.dir, lockfile), 'utf8'))
        );
        try {
          const plan = buildCommandPlan(manager, RELAY_ENDPOINTS);
          const manifests = {
            base: commitManifest(repo.dir, repo.shas.base),
            fix: commitManifest(repo.dir, repo.shas.fix),
          };
          const meta = (commit: string) => ({ fixture: manager, commit, sha: repo.shas[commit] });
          const baseline = keep(
            meta('base'),
            await timed(`${manager}.baseMs`, () =>
              baselineEvidence({
                ...workspaceOptions(manager, [`${manager}.base`]),
                manifest: manifests.base,
                plan,
              })
            )
          );
          // Base plus only the regression commit's test files, then the candidate.
          const regression = await timed(`${manager}.regressionMs`, () =>
            regressionEvidence({
              ...workspaceOptions(manager, [`${manager}.regression`, `${manager}.fix`]),
              baseManifest: manifests.base,
              testFiles: testFilesOf(repo),
              candidateManifest: manifests.fix,
              regressionTargets: REGRESSION[manager],
              endpoints: RELAY_ENDPOINTS,
            })
          );
          const onBase = keep(meta('regression'), regression.base);
          if (!regression.candidate) throw new Error(`regression proof ${regression.proof}`);
          const onFix = keep(meta('fix'), regression.candidate);
          const fixSuite = keep(
            meta('fix'),
            await timed(`${manager}.fixSuiteMs`, () =>
              baselineEvidence({
                ...workspaceOptions(manager, [`${manager}.fixSuite`]),
                manifest: manifests.fix,
                plan,
              })
            )
          );
          const status = (records: FixtureRecord[]): CommandStatus => {
            const [test] = testStatus(records);
            if (!test) throw new Error('no supervised test command ran');
            return test.status;
          };
          // Setup steps of verification (npm rebuild) must succeed on every commit.
          for (const r of [...baseline, ...onBase, ...onFix, ...fixSuite])
            if (!testStatus([r]).length) expect(r.status, `${r.commit} ${r.id}`).toBe('passed');
          expect(status(baseline), 'baseline suite on base').toBe('passed');
          expect(status(onBase), 'regression test on base').toBe('failed');
          expect(status(onFix), 'regression test on fix').toBe('passed');
          expect(status(fixSuite), 'suite on fix').toBe('passed');
          const proof = classifyRegression(status(onBase), status(onFix));
          expect(proof).toBe('reproduced_and_fixed');
          expect(regression.proof).toBe(proof);
          // Receipt (#1008) for the candidate: the supervised test commands, with the
          // runner's evidence (log digests included).
          const runId = `proxy-${manager}-${hex(4)}`;
          const record = recordProfileSelection(recordDir, runId, selection);
          const binding = profileReceiptBinding(record, adapter.accelerator);
          const evidence = (
            [
              ['regression', testStatus(onFix)[0]],
              ['suite', testStatus(fixSuite)[0]],
            ] as const
          ).map(([label, r]) => ({ ...r.evidence, id: `${r.id}-${label}` }));
          const signed = await issueReceipt(
            {
              contributionId: runId,
              runId,
              sessionId: runId,
              contributor: 'ztfc-fixture',
              upstreamRepositoryId: 1,
              issue: 1010,
              defaultBranch: 'main',
              forkRepositoryId: 2,
              // The candidate is the fix commit; its parent (the receipt's base) is the
              // regression commit the bug was reproduced on.
              baseSha: repo.shas.regression,
              parentSha: repo.shas.regression,
              candidateSha: repo.shas.fix,
              ...binding,
              policyDigest: sha256(canonicalJson(PROXY_POLICY)),
              commands: evidence,
              networkPolicy: {
                acquisition: 'none',
                provisioning: `package-proxy:${PROXY_POLICY.version}`,
                verification: 'none',
                shipping: 'none',
              },
              permittedShippingOperations: [],
            },
            signer,
            () => Date.now()
          );
          expect(signed.receipt.verified).toBe(true);
          fixtures[manager] = {
            profile: selection.profile.id,
            manifestDigest: profileManifestDigest(PROFILE_MANIFEST),
            shas: repo.shas,
            trees: Object.fromEntries(
              Object.entries(repo.shas).map(([k, sha]) => [
                k,
                git(['rev-parse', `${sha}^{tree}`], repo.dir)
                  .toString()
                  .trim(),
              ])
            ),
            regression: proof,
            receipt: { digest: signed.digest, verified: signed.receipt.verified },
          };
        } finally {
          fs.rmSync(repo.dir, { recursive: true, force: true });
        }
      },
      3 * 3600_000
    );

  it.runIf(FULL)(
    'rejects a lockfile hash mismatch: provisioning fails and is unsupported_environment',
    async () => {
      for (const manager of MANAGERS) {
        const repo = buildCommits(manager);
        try {
          const lockPath = path.join(repo.dir, fixtureInfo(manager).lockfile);
          const text = fs.readFileSync(lockPath, 'utf8');
          // Flip one digest the package manager will check: an ordinary data change.
          const tampered =
            manager === 'npm'
              ? text.replace(
                  /"integrity": "sha512-([A-Za-z0-9+/])/,
                  (_m, c: string) => `"integrity": "sha512-${c === 'A' ? 'B' : 'A'}`
                )
              : text.replace(
                  /sha256:([0-9a-f])/g,
                  (_m, c: string) => `sha256:${c === '0' ? '1' : '0'}`
                );
          expect(tampered).not.toBe(text);
          fs.writeFileSync(lockPath, tampered);
          git(['commit', '-q', '-am', 'tamper lockfile'], repo.dir);
          const sha = git(['rev-parse', 'HEAD'], repo.dir).toString().trim();
          const plan = buildCommandPlan(manager, RELAY_ENDPOINTS);
          const options = workspaceOptions(manager, [`${manager}.tamper`]);
          let failedAt: string | null = null;
          let after: RunRecord = options.lifecycle.run;
          try {
            // Provisioning must fail; a workspace that comes back is released at once.
            const workspace = await provisionWorkspace({
              ...options,
              manifest: commitManifest(repo.dir, sha),
              plan,
            });
            await releaseWorkspace(adapter, workspace, options.lifecycle);
          } catch (error) {
            if (!(error instanceof ProvisioningFailedError)) throw error;
            failedAt = error.failedAt;
            after = error.run;
            commands.push(
              ...error.records.map((r) => ({
                fixture: manager,
                commit: 'tampered-lock',
                sha,
                ...r,
              }))
            );
          }
          expect(failedAt, `${manager} provisioning with a tampered lock must fail`).not.toBeNull();
          // The controller-side check flags the same bytes against the tampered lock.
          const index = buildLockIndex(manager, tampered);
          const audit = cachedArtifacts(manager).map((a) => checkArtifact(index, a.url, a.bytes));
          tamper.push({
            fixture: manager,
            failedAt,
            runState: after.state,
            reason: after.history.at(-1)?.reasonCode,
            cacheCheck: audit.map((d) => (d.allowed ? 'allowed' : d.reason)),
          });
          expect(after.history.at(-1)?.reasonCode).toBe(R.UnsupportedEnvironment);
          expect(audit.some((d) => !d.allowed && d.reason === 'hash_mismatch')).toBe(true);
        } finally {
          fs.rmSync(repo.dir, { recursive: true, force: true });
        }
      }
    },
    3 * 3600_000
  );

  it.runIf(FULL && MANAGERS.includes('uv'))(
    'uv sync --frozen cannot reach the lockfile URLs: it is blocked, and the plan does not use it',
    async () => {
      const repo = buildCommits('uv');
      const vm = await provisioningVm('uv', 'uv.syncFrozen');
      try {
        await upload(vm, commitTree(repo.dir, repo.shas.base));
        const result = await adapter.exec(vm, {
          profile: 'python',
          argv: [
            'uv',
            'sync',
            '--frozen',
            '--no-config',
            '--no-python-downloads',
            '--python',
            '/usr/local/bin/python',
            '--no-build',
          ],
          env: { UV_DEFAULT_INDEX: `${RELAY}index/`, UV_PROJECT_ENVIRONMENT: '/opt/ztfc/sync-env' },
          network: 'package_proxy',
          timeoutMs: 5 * 60_000,
        });
        const plan = buildCommandPlan('uv', RELAY_ENDPOINTS);
        uvSyncFrozen = {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          // uv names the host it tried; the mirror is never asked for these files.
          triedLockfileHost: /files\.pythonhosted\.org/.test(result.stderr),
          planUsesSync: plan.provisioning.some((c) => c.argv[1] === 'sync'),
        };
        expect(result.exitCode).not.toBe(0);
        expect(uvSyncFrozen.triedLockfileHost).toBe(true);
        expect(uvSyncFrozen.planUsesSync).toBe(false);
      } finally {
        await adapter.destroy(vm);
        fs.rmSync(repo.dir, { recursive: true, force: true });
      }
    },
    3600_000
  );

  /** Artifacts in the mirror caches, keyed by the upstream URL they were fetched from. */
  function cachedArtifacts(manager: PackageManager): { url: string; bytes: Buffer }[] {
    const out: { url: string; bytes: Buffer }[] = [];
    const walk = (dir: string, rel: string[] = []): string[][] =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((e) =>
              e.isDirectory()
                ? walk(path.join(dir, e.name), [...rel, e.name])
                : e.isFile()
                  ? [[...rel, e.name]]
                  : []
            )
        : [];
    if (manager === 'npm') {
      for (const parts of walk(endpoints.verdaccioStorage)) {
        const file = parts.at(-1) as string;
        if (!file.endsWith('.tgz')) continue;
        const name = parts.slice(0, -1).join('/');
        out.push({
          url: `https://registry.npmjs.org/${name}/-/${file}`,
          bytes: fs.readFileSync(path.join(endpoints.verdaccioStorage, ...parts)),
        });
      }
    } else {
      for (const parts of walk(path.join(endpoints.proxpiCache, 'files-pythonhosted-org')))
        if (/\.(whl|tar\.gz|zip)$/.test(parts.at(-1) as string))
          out.push({
            url: `https://files.pythonhosted.org/${parts.join('/')}`,
            bytes: fs.readFileSync(
              path.join(endpoints.proxpiCache, 'files-pythonhosted-org', ...parts)
            ),
          });
    }
    return out;
  }

  it.runIf(FULL)('audits the mirror caches against the lockfiles with checkArtifact', () => {
    const results: Record<string, unknown>[] = [];
    for (const manager of new Set(MANAGERS.map((m) => (m === 'npm' ? 'npm' : 'python')))) {
      const relevant = indexes.filter((i) =>
        manager === 'npm' ? i.manager === 'npm' : i.manager !== 'npm'
      );
      for (const artifact of cachedArtifacts(manager === 'npm' ? 'npm' : 'uv')) {
        const decisions = relevant.map((i) => checkArtifact(i, artifact.url, artifact.bytes));
        const allowed = decisions.some((d) => d.allowed);
        results.push({ url: artifact.url, bytes: artifact.bytes.length, allowed });
      }
    }
    cacheAudit = { artifacts: results.length, rejected: results.filter((r) => !r.allowed) };
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.allowed)).toEqual([]);
  });

  it.runIf(FULL)(
    'Squid saw only policy-admitted package requests from the mirrors, with no redirects',
    () => {
      const { entries, malformed } = parseSquidAccessLog(
        fs.readFileSync(endpoints.accessLog, 'utf8')
      );
      const mirrors = new Set([endpoints.npm.host, endpoints.pypi.host]);
      const traffic = entries.filter((e) => mirrors.has(e.client));
      const requests = traffic.filter((e) => e.method !== 'CONNECT');
      const notAdmitted = requests.filter(
        (e) => !evaluateRequest({ method: e.method, url: e.url }).allowed
      );
      const denied = traffic.filter((e) => e.result.startsWith('TCP_DENIED'));
      const redirects = requests.filter(
        (e) => e.status >= 300 && e.status < 400 && e.status !== 304
      );
      const hosts = [...new Set(requests.map((e) => new URL(e.url).hostname))].sort();
      squidAudit = {
        malformedLines: malformed,
        connects: traffic.length - requests.length,
        requests: requests.length,
        hosts,
        notAdmitted: notAdmitted.map((e) => `${e.method} ${e.url}`),
        denied: denied.map((e) => `${e.method} ${e.url} ${e.result}`),
        redirects: redirects.length,
      };
      expect(malformed).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      expect(notAdmitted).toEqual([]);
      expect(denied).toEqual([]);
      expect(redirects).toEqual([]);
    }
  );

  it.runIf(FULL && MANAGERS.includes('npm'))(
    'classifies a timeout and a missing or unreadable report as inconclusive; the repair cap holds',
    async () => {
      const repo = buildCommits('npm');
      const options = workspaceOptions('npm', ['inconclusive']);
      const meta = { fixture: 'npm', commit: 'fix', sha: repo.shas.fix };
      const plan = buildCommandPlan('npm', RELAY_ENDPOINTS);
      const workspace = await provisionWorkspace({
        ...options,
        manifest: commitManifest(repo.dir, repo.shas.fix),
        plan,
      });
      try {
        commands.push(...workspace.provisioning.map((r) => ({ ...meta, ...r })));
        const base = plan.verification.find((c) => c.id === 'npm-test') as PlannedCommand;
        const cases: [string, PlannedCommand][] = [
          [
            'timeout',
            { ...base, argv: ['node', '-e', 'setTimeout(() => {}, 600000)'], timeoutMs: 2000 },
          ],
          ['no-report', { ...base, env: { ...base.env, NODE_OPTIONS: '' } }],
          [
            'unreadable-report',
            {
              ...base,
              argv: ['sh', '-c', `echo "<testsuites><testcase" > ${REPORT_PATH}`],
            },
          ],
        ];
        for (const [label, command] of cases) {
          const record = await runPlanned(
            options.adapter,
            workspace,
            { ...command, id: `npm-test-${label}` },
            collector
          );
          commands.push({ ...meta, ...record });
          inconclusive.push({
            case: label,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            status: record.status,
          });
          expect(record.status, label).toBe('inconclusive');
        }
      } finally {
        await releaseWorkspace(options.adapter, workspace, options.lifecycle);
        fs.rmSync(repo.dir, { recursive: true, force: true });
      }
      // Scenario 7: the inconclusive verdicts feed the cap: two repairs, then failed.
      let run: RunRecord = [R.GatePassed, R.PlanApproved, R.CandidateReady].reduce(
        (r, reason) => transitionRun(r, reason, TIME),
        createRun(
          {
            runId: 'repair-cap',
            upstreamIssue: 'https://github.com/o/r/issues/1',
            contributor: 'ztfc',
          },
          TIME
        )
      );
      const states: string[] = [];
      for (let i = 0; i < 3; i++) {
        run = applyVerification(run, 'inconclusive', TIME);
        states.push(run.state);
        if (run.state === 'implementing') run = transitionRun(run, R.CandidateReady, TIME);
      }
      repairCap = { states };
      expect(states).toEqual(['implementing', 'implementing', 'failed']);
    },
    3600_000
  );

  it.runIf(FULL)('refuses unpinned requirements, pnpm and Yarn as unsupported_environment', () => {
    const cases: [string, Record<string, string>][] = [
      [
        'unpinned-requirements',
        {
          'requirements.txt': 'pytest\n',
          'pyproject.toml': '[project]\nname = "x"\nversion = "1"\nrequires-python = ">=3.11"\n',
        },
      ],
      [
        'pnpm',
        {
          'package.json': '{"name":"x","scripts":{"test":"node --test"}}',
          'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        },
      ],
      [
        'yarn',
        {
          'package.json': '{"name":"x","scripts":{"test":"node --test"}}',
          'yarn.lock': '# yarn lockfile v1\n',
        },
      ],
    ];
    for (const [label, files] of cases) {
      const detection = detectEcosystem(new Map(Object.entries(files)));
      unsupported.push({ case: label, ...detection });
      expect(detection.supported, label).toBe(false);
      if (!detection.supported) expect(detection.reasonCode).toBe(R.UnsupportedEnvironment);
    }
  });

  it.runIf(FULL)(
    'during provisioning the worker reaches only the proxy; after it, nothing',
    async () => {
      const probeFiles = fs.readdirSync(HOSTILE).map((name) => ({
        path: `npm-lifecycle/${name}`,
        bytes: fs.readFileSync(path.join(HOSTILE, name)),
        exec: false,
      }));
      probeFiles.push({
        path: 'npm-lifecycle/targets.json',
        bytes: Buffer.from(JSON.stringify(planted.targets)),
        exec: false,
      });
      const collect = (label: string, stdout: string, keep?: (c: string) => boolean) => {
        guestOutputs.push(stdout);
        const parsed = parseReports(stdout);
        malformedReports += parsed.malformed;
        expect(parsed.reports, label).toHaveLength(1);
        for (const report of parsed.reports)
          reports.push({
            ...report,
            phase: label,
            records: keep ? report.records.filter((r) => keep(r.category)) : report.records,
          });
      };
      // Worker container on the provisioning network, forward live, then the same VM
      // after the phase switch with no forward at all.
      const vm = await provisioningVm('npm', 'probe');
      try {
        await upload(vm, probeFiles);
        const during = await timed('probe.provisioningMs', () =>
          adapter.exec(vm, {
            profile: 'node',
            argv: ['node', 'probe.js', 'provisioning'],
            cwd: 'npm-lifecycle',
            network: 'package_proxy',
          })
        );
        guestOutputs.push(during.stderr);
        collect('provisioning-container', during.stdout);
        // The relay itself still answers: the one path that exists is the proxy.
        // An ordinary package-document request to the relay: 0 = answered, 2 = no route.
        const fetchMirror = [
          'node',
          '-e',
          `fetch(${JSON.stringify(`${RELAY}ms`)}, { signal: AbortSignal.timeout(20000) }).then(r => { console.log('status', r.status); process.exit(r.ok ? 0 : 1) }, e => { console.log('error', e.cause?.code ?? e.name); process.exit(2) })`,
        ];
        const relay = await adapter.exec(vm, {
          profile: 'node',
          argv: fetchMirror,
          network: 'package_proxy',
        });
        guestOutputs.push(relay.stdout, relay.stderr);
        expect(relay.exitCode, 'the package mirror is reachable during provisioning').toBe(0);
        await adapter.endProvisioning(vm);
        const noRelay = await adapter.exec(vm, { profile: 'node', argv: fetchMirror });
        guestOutputs.push(noRelay.stdout, noRelay.stderr);
        expect(noRelay.exitCode, 'nothing answers after provisioning').toBe(2);
        const after = await timed('probe.verificationMs', () =>
          adapter.exec(vm, {
            profile: 'node',
            argv: ['node', 'probe.js', 'verification'],
            cwd: 'npm-lifecycle',
          })
        );
        guestOutputs.push(after.stderr);
        collect('verification-container', after.stdout);
      } finally {
        await adapter.destroy(vm);
      }
      // Root on the VM's own network stack while the forward is live (assumed escape):
      // only the host-enforced categories are judged.
      const root = await timed('probe.vmRootBootMs', () =>
        adapter.create({
          runId: `proxy-root-${hex(4)}`,
          limits: LIMITS,
          scope: 'vm-root',
          phase: 'provisioning',
          proxyTarget: endpoints.npm,
        })
      );
      try {
        await upload(root, probeFiles);
        const result = await timed('probe.vmRootMs', () =>
          adapter.exec(root, {
            profile: 'node',
            argv: rootProbeArgv('provisioning-root'),
          })
        );
        guestOutputs.push(result.stderr);
        collect('provisioning-vm-root', result.stdout, (c) => HOST_ENFORCED.has(c));
      } finally {
        await adapter.destroy(root);
      }
      boundary = evaluateBoundary({
        reports,
        // The probes' own output plus everything the runner collected from the fixture
        // runs; a collection past its cap throws here rather than scan partially.
        guestOutputs: [...guestOutputs, ...collector.outputs()],
        canaries: planted.canaries,
        listenerConnections: planted.connections(),
        brokerChecks,
        malformedReports,
      });
      expect(boundary.violations).toEqual([]);
      assertBoundaryHeld(boundary);
    },
    3 * 3600_000
  );
});
