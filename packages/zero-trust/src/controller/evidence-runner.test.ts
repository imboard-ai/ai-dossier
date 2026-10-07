import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeVm, FakeVmAdapter, junit } from '../__tests__/fake-vm';
import { exportSource, type SourceManifest, sha256 } from '../canonical/export';
import { buildCommandPlan, type CommandPlan, type PlannedCommand } from '../ecosystem/commands';
import {
  detectEcosystem,
  type SupportedDetection,
  sourceFilesFromManifest,
} from '../ecosystem/detect';
import { type ProfileRecord, recordProfileSelection, selectProfile } from '../ecosystem/profiles';
import { Journal } from '../journal';
import { SecretRedactionError } from '../redaction';
import { createRun, ReasonCode as R, type RunRecord, transitionRun } from '../state';
import { BrokerError, type ExecRequest, VmCleanupError } from '../vm/adapter';
import { WORKER_RELAY } from '../vm/qemu-args';
import {
  assertPlanNetworks,
  baselineEvidence,
  EvidencePlanError,
  logArtifact,
  MAX_LOG_EXCERPT_CHARS,
  ProvisioningFailedError,
  ProvisioningNotClosedError,
  provisionWorkspace,
  REDACTED_EXCERPT,
  type RunLifecycle,
  regressionEvidence,
  releaseWorkspace,
  reproductionManifest,
  runPlanned,
  type WorkspaceOptions,
  workspaceStatus,
} from './evidence-runner';
import { OutputCollector } from './output-collector';

const ROOT = path.join(__dirname, '..', '..');
const NPM = path.join(ROOT, 'fixtures', 'ecosystem', 'npm');
const RELAY = `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/`;
const ENDPOINTS = { npmRegistry: RELAY, pypiIndex: `${RELAY}index/` };
const TIME = '2026-10-07T00:00:00.000Z';
const REGRESSION_TEST = 'test/regression.test.js';
const PLAN = buildCommandPlan('npm', ENDPOINTS);

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The npm fixture after applying its patches, as a canonical manifest. */
function fixtureManifest(...patches: string[]): SourceManifest {
  const dir = tempDir('zt-runner-src-');
  fs.cpSync(path.join(NPM, 'base'), dir, { recursive: true });
  for (const patch of patches) {
    const applied = spawnSync('git', ['apply', path.join(NPM, patch)], { cwd: dir });
    if (applied.status !== 0) throw new Error(`git apply ${patch}: ${applied.stderr}`);
  }
  return exportSource(dir);
}
const BASE = fixtureManifest();
const CANDIDATE = fixtureManifest('regression.patch', 'fix.patch');

function profileRecord(): ProfileRecord {
  const detection = detectEcosystem(sourceFilesFromManifest(BASE));
  const selection = selectProfile(detection as SupportedDetection);
  if (!selection.ok) throw new Error('no profile');
  return recordProfileSelection(tempDir('zt-runner-profile-'), 'run-1095', selection);
}
const RECORD = profileRecord();

const fixed = (vm: FakeVm) =>
  vm.files.get('src/duration.js')?.bytes.toString('utf8').includes('millis / 1000') ?? false;

/** The fixture's behaviour, decided from what was uploaded: the regression test fails
 * until the source carries the fix; everything else passes. */
function fixtureScript(request: ExecRequest, vm: FakeVm) {
  if (!request.report) return { stdout: `ran ${request.argv.join(' ')}\n` };
  const failing = vm.files.has(REGRESSION_TEST) && !fixed(vm);
  return { exitCode: failing ? 1 : 0, report: junit(1, failing), stdout: 'tests\n' };
}

function implementingRun(): RunRecord {
  return [R.GatePassed, R.PlanApproved].reduce(
    (run, reason) => transitionRun(run, reason, TIME),
    createRun(
      { runId: 'run-1095', upstreamIssue: 'https://github.com/o/r/issues/1', contributor: 'c' },
      TIME
    )
  );
}

function setup(adapter = new FakeVmAdapter(fixtureScript)) {
  const observed: RunRecord[] = [];
  const lifecycle: RunLifecycle = {
    run: implementingRun(),
    now: () => new Date(TIME),
    observeRun: (run) => observed.push(run),
    sleep: async () => {},
  };
  const collector = new OutputCollector();
  const options: WorkspaceOptions = {
    adapter,
    runId: 'run-1095',
    limits: { vcpus: 1, memoryMiB: 512, diskGiB: 1, commandTimeoutMs: 1000 },
    profileRecord: RECORD,
    proxyTarget: { host: '10.0.0.2', port: 4873 },
    collector,
    lifecycle,
  };
  return { adapter, observed, collector, options };
}

const testCommand = (plan: CommandPlan = PLAN) =>
  plan.verification.find((c) => c.captureReport) as PlannedCommand;

describe('baselineEvidence and regressionEvidence (scenario 6)', () => {
  it('baseline passes on the base, provisioning on the proxy and verification offline', async () => {
    const { adapter, options } = setup();
    const result = await baselineEvidence({ ...options, manifest: BASE, plan: PLAN });
    expect(result.status).toBe('passed');
    expect(result.records.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(result.phaseSwitch).toEqual({
      attempt: 'package-proxy-after-provisioning',
      refusedWith: 'network_not_allowed',
    });
    for (const call of adapter.execs()) {
      const network = call.request.network ?? 'none';
      if (call.request.argv.join(' ') === 'true') {
        expect(call.phase).toBe('verification');
        expect(network).toBe('package_proxy');
      } else expect(network).toBe(call.phase === 'provisioning' ? 'package_proxy' : 'none');
    }
    const provisioning = adapter.execs().filter((c) => c.phase === 'provisioning');
    expect(provisioning.map((c) => c.request.argv)).toEqual(PLAN.provisioning.map((c) => c.argv));
    expect(adapter.liveVms()).toEqual([]);
    const [vm] = adapter.vms.values();
    expect([...vm.files.keys()].sort()).toEqual(
      BASE.entries
        .filter((e) => e.mode !== '040000')
        .map((e) => e.path)
        .sort()
    );
  });

  it('reproduces on base plus tests and passes on the candidate: reproduced_and_fixed', async () => {
    const { adapter, options } = setup();
    const result = await regressionEvidence({
      ...options,
      baseManifest: BASE,
      testFiles: [REGRESSION_TEST],
      candidateManifest: CANDIDATE,
      regressionTargets: [REGRESSION_TEST],
      endpoints: ENDPOINTS,
    });
    expect(result.base.status).toBe('failed');
    expect(result.candidate?.status).toBe('passed');
    expect(result.proof).toBe('reproduced_and_fixed');
    const vms = [...adapter.vms.values()];
    expect(vms).toHaveLength(2);
    expect(vms[0].files.has(REGRESSION_TEST)).toBe(true);
    expect(fixed(vms[0])).toBe(false);
    expect(fixed(vms[1])).toBe(true);
    expect(adapter.liveVms()).toEqual([]);
    expect(testCommand(buildCommandPlan('npm', ENDPOINTS)).argv).not.toContain(REGRESSION_TEST);
    expect(adapter.execs().some((c) => c.request.argv.includes(REGRESSION_TEST))).toBe(true);
  });

  it('a base that passes is not_reproduced and never boots the candidate', async () => {
    const { adapter, options } = setup(
      new FakeVmAdapter((request) => (request.report ? { report: junit(1) } : {}))
    );
    const result = await regressionEvidence({
      ...options,
      baseManifest: BASE,
      testFiles: [REGRESSION_TEST],
      candidateManifest: CANDIDATE,
      regressionTargets: [REGRESSION_TEST],
      endpoints: ENDPOINTS,
    });
    expect(result.proof).toBe('not_reproduced');
    expect(result.candidate).toBeNull();
    expect(adapter.vms.size).toBe(1);
  });

  it('an inconclusive base is inconclusive, and a candidate that still fails is still_failing', async () => {
    const inconclusive = setup(new FakeVmAdapter((r) => (r.report ? { exitCode: 1 } : {})));
    const args = {
      baseManifest: BASE,
      testFiles: [REGRESSION_TEST],
      candidateManifest: CANDIDATE,
      regressionTargets: [REGRESSION_TEST],
      endpoints: ENDPOINTS,
    };
    expect((await regressionEvidence({ ...inconclusive.options, ...args })).proof).toBe(
      'inconclusive'
    );
    const failing = setup(
      new FakeVmAdapter((r) => (r.report ? { exitCode: 1, report: junit(1, true) } : {}))
    );
    const result = await regressionEvidence({ ...failing.options, ...args });
    expect(result.proof).toBe('still_failing');
    expect(failing.adapter.liveVms()).toEqual([]);
  });

  it('a setup step that does not pass makes the workspace inconclusive', async () => {
    const { adapter, options } = setup();
    const setupStep = PLAN.verification.find((c) => !c.captureReport) as PlannedCommand;
    adapter.on(setupStep.argv, { exitCode: 1 });
    const result = await baselineEvidence({ ...options, manifest: BASE, plan: PLAN });
    expect(result.records.find((r) => r.id === setupStep.id)?.status).toBe('failed');
    expect(result.status).toBe('inconclusive');
  });

  it('a workspace with no test command record is inconclusive', () => {
    expect(workspaceStatus([])).toBe('inconclusive');
  });
});

describe('runPlanned classification (scenario 7)', () => {
  async function classify(script: Parameters<FakeVmAdapter['on']>[1]) {
    const { adapter, options, collector } = setup();
    adapter.on(testCommand().argv, script);
    const workspace = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN });
    try {
      return await runPlanned(adapter, workspace, testCommand(), collector);
    } finally {
      await releaseWorkspace(adapter, workspace, options.lifecycle);
    }
  }

  it('passes and fails only with a readable report of at least one suite', async () => {
    const pass = await classify({ report: junit(2) });
    expect(pass).toMatchObject({ status: 'passed', exitCode: 0, suites: 2, tests: 2, failures: 0 });
    expect(pass.evidence).toMatchObject({ status: 'passed', exitStatus: 0, suites: 2 });
    expect(pass.evidence.sanitizedLogDigest).toBe(pass.log.digest);
    const fail = await classify({ exitCode: 1, report: junit(1, true) });
    expect(fail).toMatchObject({ status: 'failed', failures: 1 });
  });

  it.each([
    ['timeout', { timedOut: true, exitCode: null, report: junit(1) }],
    ['signal', { exitCode: null, report: junit(1) }],
    ['missing report', { exitCode: 0, report: null }],
    ['zero suites', { exitCode: 0, report: '<testsuites></testsuites>' }],
    ['unreadable report', { exitCode: 0, report: '<testsuites><testcase' }],
    ['exit 0 with a failing case', { exitCode: 0, report: junit(1, true) }],
    ['a failure exit with no failing case', { exitCode: 1, report: junit(1) }],
    [
      'exit 0 with every case skipped',
      {
        exitCode: 0,
        report: '<testsuites><testsuite><testcase><skipped/></testcase></testsuite></testsuites>',
      },
    ],
  ])('%s is inconclusive, never passed', async (_label, script) => {
    const record = await classify(script);
    expect(record.status).toBe('inconclusive');
    expect(record.evidence.status).toBe('inconclusive');
  });

  it('a setup command that times out is inconclusive', async () => {
    const { adapter, options, collector } = setup();
    const setupStep = PLAN.verification.find((c) => !c.captureReport) as PlannedCommand;
    adapter.on(setupStep.argv, { timedOut: true, exitCode: null });
    const workspace = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN });
    const record = await runPlanned(adapter, workspace, setupStep, collector);
    await releaseWorkspace(adapter, workspace, options.lifecycle);
    expect(record.status).toBe('inconclusive');
    expect(record.evidence.exitStatus).toBe('unknown');
  });
});

describe('network by phase (PRD §5.5)', () => {
  const withVerification = (patch: Partial<PlannedCommand>): CommandPlan => ({
    ...PLAN,
    verification: [{ ...testCommand(), ...patch }],
  });

  it.each([
    ['verification on the proxy', withVerification({ network: 'package_proxy' })],
    [
      'provisioning with no network',
      { ...PLAN, provisioning: [{ ...PLAN.provisioning[0], network: 'none' as const }] },
    ],
    ['a provisioning command in verification', withVerification({ phase: 'provisioning' })],
  ])('refuses %s before any VM or exec', async (_label, plan) => {
    const { adapter, options } = setup();
    expect(() => assertPlanNetworks(plan)).toThrow(EvidencePlanError);
    await expect(baselineEvidence({ ...options, manifest: BASE, plan })).rejects.toMatchObject({
      code: 'network_mismatch',
    });
    await expect(provisionWorkspace({ ...options, manifest: BASE, plan })).rejects.toThrow(
      EvidencePlanError
    );
    expect(adapter.calls).toEqual([]);
  });

  it('runPlanned refuses a provisioning command before exec', async () => {
    const { adapter, options, collector } = setup();
    const workspace = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN });
    const before = adapter.execs().length;
    await expect(
      runPlanned(adapter, workspace, PLAN.provisioning[0], collector)
    ).rejects.toMatchObject({ code: 'network_mismatch' });
    expect(adapter.execs()).toHaveLength(before);
    await releaseWorkspace(adapter, workspace, options.lifecycle);
  });

  it('refuses a plan for another manager and a plan without a test command', async () => {
    const { adapter, options } = setup();
    const pip = buildCommandPlan('pip', ENDPOINTS);
    await expect(
      provisionWorkspace({ ...options, manifest: BASE, plan: pip })
    ).rejects.toMatchObject({ code: 'manager_mismatch' });
    await expect(
      baselineEvidence({
        ...options,
        manifest: BASE,
        plan: { ...PLAN, verification: PLAN.verification.filter((c) => !c.captureReport) },
      })
    ).rejects.toMatchObject({ code: 'no_test_command' });
    expect(adapter.calls).toEqual([]);
  });

  it('aborts and destroys the VM when the proxy network is still accepted after the switch', async () => {
    class LeakyAdapter extends FakeVmAdapter {
      override async exec(handle: Parameters<FakeVmAdapter['exec']>[0], request: ExecRequest) {
        return super.exec(handle, { ...request, network: 'none' });
      }
    }
    const { adapter, options } = setup(new LeakyAdapter(fixtureScript));
    await expect(
      provisionWorkspace({ ...options, manifest: BASE, plan: PLAN })
    ).rejects.toBeInstanceOf(ProvisioningNotClosedError);
    expect(adapter.liveVms()).toEqual([]);
  });

  it('rethrows a broker error other than the network refusal after teardown', async () => {
    class BrokenAdapter extends FakeVmAdapter {
      override async exec(handle: Parameters<FakeVmAdapter['exec']>[0], request: ExecRequest) {
        if (request.argv.join(' ') === 'true') throw new BrokerError('guest_protocol');
        return super.exec(handle, request);
      }
    }
    const { adapter, options } = setup(new BrokenAdapter(fixtureScript));
    await expect(
      provisionWorkspace({ ...options, manifest: BASE, plan: PLAN })
    ).rejects.toMatchObject({ code: 'guest_protocol' });
    expect(adapter.liveVms()).toEqual([]);
  });
});

describe('teardown on every path (PRD §5.9)', () => {
  it('a provisioning failure destroys the VM, then makes the run unsupported_environment', async () => {
    const { adapter, options, observed } = setup();
    adapter.on(PLAN.provisioning[0].argv, { exitCode: 1, stderr: 'integrity mismatch' });
    const error = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(ProvisioningFailedError);
    expect(error.failedAt).toBe(PLAN.provisioning[0].id);
    expect(error.records).toHaveLength(1);
    expect(error.run.state).toBe('unsupported');
    expect(error.run.history.at(-1)?.reasonCode).toBe(R.UnsupportedEnvironment);
    expect(observed.map((r) => r.state)).toEqual(['unsupported']);
    expect(adapter.liveVms()).toEqual([]);
    expect(adapter.calls.some((c) => c.op === 'endProvisioning')).toBe(false);
  });

  it.each([
    ['putFile', 'putFile'],
    ['endProvisioning', 'endProvisioning'],
  ] as const)('a throwing %s still destroys the VM', async (_label, op) => {
    class Throwing extends FakeVmAdapter {
      override async putFile(...args: Parameters<FakeVmAdapter['putFile']>) {
        if (op === 'putFile') throw new Error('upload failed');
        return super.putFile(...args);
      }
      override async endProvisioning(handle: Parameters<FakeVmAdapter['endProvisioning']>[0]) {
        if (op === 'endProvisioning') throw new Error('phase change failed');
        return super.endProvisioning(handle);
      }
    }
    const { adapter, options } = setup(new Throwing(fixtureScript));
    await expect(provisionWorkspace({ ...options, manifest: BASE, plan: PLAN })).rejects.toThrow(
      /failed/
    );
    expect(adapter.vms.size).toBe(1);
    expect(adapter.liveVms()).toEqual([]);
  });

  it('a verification command that throws still destroys the VM', async () => {
    const { adapter, options } = setup(
      new FakeVmAdapter((request, vm) => {
        if (request.report) throw new BrokerError('guest_error');
        return fixtureScript(request, vm);
      })
    );
    await expect(
      baselineEvidence({ ...options, manifest: BASE, plan: PLAN })
    ).rejects.toBeInstanceOf(BrokerError);
    expect(adapter.liveVms()).toEqual([]);
  });

  it('three destroy failures surface VmCleanupError and a blocked_cleanup run', async () => {
    const { adapter, options, observed } = setup();
    adapter.failDestroy = 3;
    await expect(
      baselineEvidence({ ...options, manifest: BASE, plan: PLAN })
    ).rejects.toBeInstanceOf(VmCleanupError);
    expect(observed.map((r) => r.state)).toEqual(['blocked_cleanup']);
    expect(adapter.calls.filter((c) => c.op === 'destroy')).toHaveLength(3);
  });

  it('a blocked cleanup wins over a provisioning failure', async () => {
    const { adapter, options, observed } = setup();
    adapter.on(PLAN.provisioning[0].argv, { exitCode: 1 });
    adapter.failDestroy = 3;
    await expect(
      provisionWorkspace({ ...options, manifest: BASE, plan: PLAN })
    ).rejects.toBeInstanceOf(VmCleanupError);
    expect(observed.map((r) => r.state)).toEqual(['blocked_cleanup']);
  });

  it('two destroy failures then success is a clean teardown', async () => {
    const { adapter, options, observed } = setup();
    adapter.failDestroy = 2;
    const result = await baselineEvidence({ ...options, manifest: BASE, plan: PLAN });
    expect(result.status).toBe('passed');
    expect(observed).toEqual([]);
    expect(adapter.liveVms()).toEqual([]);
  });
});

describe('sanitized evidence', () => {
  const TOKEN = `ghp_${'a'.repeat(36)}`;

  it('redacts an excerpt with a credential and keeps only the digest', () => {
    const artifact = logArtifact(`token ${TOKEN}\n`, '', false);
    expect(artifact.excerpt).toBe(REDACTED_EXCERPT);
    expect(artifact.redacted).toBe(true);
    expect(artifact.digest).toBe(sha256(Buffer.from(`token ${TOKEN}\n\n--- stderr ---\n`)));
  });

  it('redacts when the credential is in the log but outside the excerpt', () => {
    const artifact = logArtifact(`${TOKEN}${'x'.repeat(MAX_LOG_EXCERPT_CHARS * 2)}`, '', false);
    expect(artifact.excerptTruncated).toBe(true);
    expect(artifact.excerpt).toBe(REDACTED_EXCERPT);
  });

  it('bounds the excerpt to the log tail', () => {
    const artifact = logArtifact('a'.repeat(100_000), 'tail-marker', true);
    expect(artifact.excerpt.length).toBe(MAX_LOG_EXCERPT_CHARS);
    expect(artifact.excerpt.endsWith('tail-marker')).toBe(true);
    expect(artifact).toMatchObject({
      excerptTruncated: true,
      redacted: false,
      outputTruncated: true,
    });
    expect(logArtifact('short', '', false)).toMatchObject({ excerptTruncated: false });
  });

  it('records, persists and collects guest output without raw secrets', async () => {
    const { adapter, options, collector } = setup();
    const artifactsDir = path.join(tempDir('zt-runner-artifacts-'), 'artifacts');
    adapter.on(testCommand().argv, {
      stdout: `leak ${TOKEN}\n`,
      stderr: 'y'.repeat(20_000),
      report: junit(1),
    });
    const result = await baselineEvidence({
      ...options,
      artifactsDir,
      manifest: BASE,
      plan: PLAN,
    });
    const record = result.records.find((r) => r.captureReport);
    expect(record?.log.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const r of [...result.provisioning, ...result.records])
      expect(r.log.excerpt.length).toBeLessThanOrEqual(MAX_LOG_EXCERPT_CHARS);
    const file = path.join(artifactsDir, `${record?.log.digest}.complete.log.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(record?.log);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
    // The collector keeps every guest byte (for canary scanning), the report included.
    expect(collector.outputs().join('')).toContain(TOKEN);
    expect(collector.outputs().some((o) => o.includes('<testsuites>'))).toBe(true);
  });

  it('refuses a record whose command carries a credential, and destroys the VM', async () => {
    const { adapter, options, collector } = setup();
    const workspace = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN });
    await expect(
      runPlanned(adapter, workspace, { ...testCommand(), argv: ['echo', TOKEN] }, collector)
    ).rejects.toBeInstanceOf(SecretRedactionError);
    await releaseWorkspace(adapter, workspace, options.lifecycle);
    expect(adapter.liveVms()).toEqual([]);
  });
});

describe('workspace guard, causes and journal', () => {
  it('runPlanned refuses a workspace provisionWorkspace did not return, or one already released', async () => {
    const { adapter, options, collector } = setup();
    const workspace = await provisionWorkspace({ ...options, manifest: BASE, plan: PLAN });
    const forged = { ...workspace };
    const before = adapter.execs().length;
    await expect(runPlanned(adapter, forged, testCommand(), collector)).rejects.toMatchObject({
      code: 'workspace_unproven',
    });
    await releaseWorkspace(adapter, workspace, options.lifecycle);
    await expect(runPlanned(adapter, workspace, testCommand(), collector)).rejects.toMatchObject({
      code: 'workspace_unproven',
    });
    expect(adapter.execs()).toHaveLength(before);
  });

  it('a blocked cleanup keeps the failure that led to it as its cause', async () => {
    const thrown = setup(
      new FakeVmAdapter((request, vm) => {
        if (request.report) throw new BrokerError('guest_error');
        return fixtureScript(request, vm);
      })
    );
    thrown.adapter.failDestroy = 3;
    const error = await baselineEvidence({ ...thrown.options, manifest: BASE, plan: PLAN }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(VmCleanupError);
    expect(error.cause).toBeInstanceOf(BrokerError);
    const failed = setup();
    failed.adapter.on(PLAN.provisioning[0].argv, { exitCode: 1 });
    failed.adapter.failDestroy = 3;
    const blocked = await provisionWorkspace({
      ...failed.options,
      manifest: BASE,
      plan: PLAN,
    }).catch((e) => e);
    expect(blocked.cause).toMatchObject({ failedAt: PLAN.provisioning[0].id });
    expect(blocked.cause.records).toHaveLength(1);
  });

  it('journals the stage, command and error class of an aborted workspace', async () => {
    const journal = new Journal(tempDir('zt-runner-journal-'));
    const { options } = setup(
      new FakeVmAdapter((request, vm) => {
        if (request.report) throw new BrokerError('guest_error');
        return fixtureScript(request, vm);
      })
    );
    await expect(
      baselineEvidence({
        ...options,
        lifecycle: { ...options.lifecycle, journal },
        manifest: BASE,
        plan: PLAN,
      })
    ).rejects.toBeInstanceOf(BrokerError);
    expect(journal.read()).toContainEqual(
      expect.objectContaining({
        type: 'evidence_workspace_aborted',
        stage: 'verification',
        commandId: testCommand().id,
        cause: 'BrokerError',
      })
    );
  });

  it('names the offending command, never repository text, in a plan refusal', () => {
    const plan = {
      ...PLAN,
      verification: [{ ...testCommand(), network: 'package_proxy' as const }],
    };
    expect(() => assertPlanNetworks(plan)).toThrow(`${testCommand().id} in verification`);
    expect(() => reproductionManifest(BASE, CANDIDATE, ['test/secret-name.js'])).toThrow(
      'test file #0'
    );
  });

  it('keeps one artifact per log and truncation flag', async () => {
    const { adapter, options } = setup();
    const artifactsDir = tempDir('zt-runner-artifacts-');
    adapter.on(PLAN.provisioning[0].argv, { stdout: 'same', truncated: true });
    const setupStep = PLAN.verification.find((c) => !c.captureReport) as PlannedCommand;
    adapter.on(setupStep.argv, { stdout: 'same' });
    await baselineEvidence({ ...options, artifactsDir, manifest: BASE, plan: PLAN });
    const names = fs.readdirSync(artifactsDir);
    const digest = logArtifact('same', '', false).digest;
    expect(names).toEqual(
      expect.arrayContaining([`${digest}.truncated.log.json`, `${digest}.complete.log.json`])
    );
  });
});

describe('reproductionManifest', () => {
  it('overlays only the test files (and their missing parents) on the base', () => {
    const manifest = reproductionManifest(BASE, CANDIDATE, [REGRESSION_TEST]);
    const paths = manifest.entries.map((e) => e.path);
    expect(paths).toContain(REGRESSION_TEST);
    const source = manifest.entries.find((e) => e.path === 'src/duration.js');
    const baseSource = BASE.entries.find((e) => e.path === 'src/duration.js');
    expect(source?.sha256).toBe(baseSource?.sha256);
  });

  it('adds parent directories the base lacks', () => {
    const dir = tempDir('zt-runner-nested-');
    fs.mkdirSync(path.join(dir, 'test', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'deep', 'x.test.js'), 'x');
    const withDeep = exportSource(dir);
    const manifest = reproductionManifest(BASE, withDeep, ['test/deep/x.test.js']);
    expect(manifest.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(['test/deep', 'test/deep/x.test.js'])
    );
  });

  it('refuses missing, directory or no test files, and no regression targets', async () => {
    expect(() => reproductionManifest(BASE, CANDIDATE, [])).toThrow(/no_test_files/);
    expect(() => reproductionManifest(BASE, CANDIDATE, ['test/none.js'])).toThrow(
      /test_file_missing/
    );
    expect(() => reproductionManifest(BASE, CANDIDATE, ['test'])).toThrow(/test_file_missing/);
    const { adapter, options } = setup();
    await expect(
      regressionEvidence({
        ...options,
        baseManifest: BASE,
        testFiles: [REGRESSION_TEST],
        candidateManifest: CANDIDATE,
        regressionTargets: [],
        endpoints: ENDPOINTS,
      })
    ).rejects.toMatchObject({ code: 'no_regression_targets' });
    expect(adapter.calls).toEqual([]);
  });
});
