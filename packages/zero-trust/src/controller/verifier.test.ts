import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importGraph } from '../__tests__/import-graph';
import {
  CANDIDATE,
  candidateInput,
  fixtureScript,
  harness,
  PROFILE,
  REGRESSION_TEST,
  RUN_ID,
  removeTemps,
  TIME,
  tempDir,
  VerifierFakeVm,
  verifyingRun,
} from '../__tests__/verifier-fixture';
import { createManifest, type SourceManifest } from '../canonical/export';
import { assertRepairAllowed, RepairCapExceededError } from '../ecosystem/classify';
import { Journal } from '../journal';
import { ReasonCode as R, transitionRun } from '../state';
import { VmCleanupError } from '../vm/adapter';
import { EvidencePlanError, ProvisioningFailedError } from './evidence-runner';
import {
  beginVerification,
  loadVerification,
  REGRESSION_COMMAND_SUFFIX,
  VERIFICATION_DIRECTORY,
} from './verification-record';
import { type VerificationOutcome, verificationPlan, verifyCandidate } from './verifier';

beforeEach(() => {
  // Boundary listeners use real local sockets but never the host's LAN identity.
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTemps();
});

function verified(outcome: VerificationOutcome) {
  if (outcome.kind !== 'verified') throw new Error(`expected verified, got ${outcome.kind}`);
  return outcome;
}

/** Every regular file the store holds, relative to it. */
function storeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
}

describe('verifyCandidate: verdicts and the repair cap (AC1, scenario 7)', () => {
  it('a passing candidate persists a VerificationRecord and moves the run to shipping', async () => {
    const h = harness();
    const input = candidateInput();
    const outcome = verified(await verifyCandidate(h.deps(), input));
    expect(outcome.verdict).toBe('passed');
    expect(outcome.run.state).toBe('shipping');
    expect(h.observed.at(-1)).toBe(outcome.run);
    const { record } = outcome;
    expect(record).toMatchObject({
      runId: RUN_ID,
      candidateSha: input.candidateSha,
      baseSha: input.record.baseSha,
      parentSha: input.record.baseSha,
      networkPolicy: { provisioning: 'package_proxy', verification: 'none' },
      regression: 'reproduced_and_fixed',
      verdict: 'passed',
      boundaryHeld: true,
      verifiedAt: TIME,
    });
    expect(record.profile.accelerator).toBe('tcg');
    expect(record.commands.map((c) => [c.id, c.status, c.suites])).toEqual([
      ['npm-test', 'passed', 1],
      [`npm-test${REGRESSION_COMMAND_SUFFIX}`, 'passed', 1],
    ]);
    expect(record.commands[1]?.command).toContain(REGRESSION_TEST);
    // Provisioning, setup and test logs: every digest names a persisted log artifact.
    expect(record.logsDigests.length).toBeGreaterThanOrEqual(3);
    expect(
      loadVerification(h.artifactsDir, input.candidateSha, {
        runId: RUN_ID,
        expectedDigest: record.recordDigest,
      })
    ).toEqual(record);
    expect(storeFiles(h.artifactsDir)).toContain(`verification/${input.candidateSha}.json`);
    expect(h.adapter.liveVms()).toEqual([]);
    // Verification commands never had a network; only provisioning used the proxy.
    for (const call of h.adapter.execs())
      if (call.request.argv.join(' ') !== 'true')
        expect(call.request.network ?? 'none').toBe(
          call.phase === 'provisioning' ? 'package_proxy' : 'none'
        );
  });

  it('a failure repairs twice, the third failure fails the run and no further repair is allowed', async () => {
    const failing = new VerifierFakeVm((request) =>
      request.report ? { exitCode: 1, report: Buffer.from(junitFailing()) } : {}
    );
    const h = harness(failing);
    let run = verifyingRun();
    const states: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = verified(await verifyCandidate(h.deps(run), candidateInput(attempt)));
      expect(outcome.verdict).toBe('failed');
      run = outcome.run;
      states.push(run.state);
      if (run.state === 'implementing') run = transitionRun(run, R.CandidateReady, TIME);
    }
    expect(states).toEqual(['implementing', 'implementing', 'failed']);
    expect(() => assertRepairAllowed(run)).toThrow(RepairCapExceededError);
  });
});

function junitFailing(): string {
  return '<testsuites><testsuite name="s"><testcase name="t"><failure/></testcase></testsuite></testsuites>';
}

describe('verifyCandidate: inconclusive is never a pass (AC2)', () => {
  it.each([
    ['a timeout', { timedOut: true, exitCode: null, report: null }],
    ['an unreadable report', { exitCode: 0, report: 'not a junit report' }],
    ['zero suites', { exitCode: 0, report: '<testsuites></testsuites>' }],
    ['no report at all', { exitCode: 0, report: null }],
  ] as const)('%s gives inconclusive and the run does not reach shipping', async (_, script) => {
    const h = harness(
      new VerifierFakeVm((request, vm) =>
        request.report && request.argv.includes(REGRESSION_TEST)
          ? fixtureScript(request, vm)
          : request.report
            ? script
            : {}
      )
    );
    const outcome = verified(await verifyCandidate(h.deps(), candidateInput()));
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.record.verdict).toBe('inconclusive');
    expect(outcome.run.state).toBe('implementing');
    expect(h.observed.map((r) => r.state)).not.toContain('shipping');
  });

  it('an unproven regression on a passing suite is inconclusive', async () => {
    const h = harness(
      new VerifierFakeVm((request, vm) =>
        request.argv.includes(REGRESSION_TEST)
          ? { exitCode: 0, report: '<testsuites></testsuites>' }
          : fixtureScript(request, vm)
      )
    );
    const outcome = verified(await verifyCandidate(h.deps(), candidateInput()));
    expect(outcome.record.regression).toBe('inconclusive');
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.run.state).toBe('implementing');
  });

  it('a failing setup step is inconclusive even when the tests pass', async () => {
    const adapter = new VerifierFakeVm(fixtureScript);
    adapter.on(['npm', 'rebuild'], { exitCode: 1 });
    const h = harness(adapter);
    const outcome = verified(await verifyCandidate(h.deps(), candidateInput()));
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.run.state).toBe('implementing');
  });
});

function tamperOneByte(manifest: SourceManifest): SourceManifest {
  const entries = manifest.entries.map((entry) => {
    if (entry.path !== 'src/duration.js') return entry;
    const bytes = Buffer.from(entry.bytes, 'base64');
    bytes[0] = (bytes[0] as number) ^ 1;
    return { ...entry, bytes: bytes.toString('base64') };
  });
  return { ...manifest, entries };
}

describe('verifyCandidate: identity before any VM (AC3, scenarios 10 and 17)', () => {
  it.each([
    ['one byte changed', () => ({ ...candidateInput(), manifest: tamperOneByte(CANDIDATE) })],
    [
      'one byte changed with a recomputed digest',
      () => {
        const tampered = tamperOneByte(CANDIDATE);
        const entries = tampered.entries.map((entry) => ({
          ...entry,
          sha256: createHash('sha256').update(Buffer.from(entry.bytes, 'base64')).digest('hex'),
        }));
        return { ...candidateInput(), manifest: createManifest(entries) };
      },
    ],
    [
      'a wrong parent',
      () => {
        const input = candidateInput();
        return { ...input, authority: { ...input.authority, baseSha: 'a'.repeat(40) } };
      },
    ],
    [
      'a different authorized SHA',
      () => ({ ...candidateInput(), candidateSha: candidateInput(2).candidateSha }),
    ],
  ])('%s gives identity_mismatch and blocks the run', async (_, build) => {
    const h = harness();
    const outcome = await verifyCandidate(h.deps(), build());
    expect(outcome.kind).toBe('identity_mismatch');
    expect(outcome.run.state).toBe('blocked');
    expect(outcome.run.reasonCode).toBe(R.PolicyBlocked);
    expect(h.observed).toEqual([outcome.run]);
    expect(h.adapter.calls).toEqual([]);
    // No boundary session was prepared and nothing was written.
    expect(storeFiles(h.artifactsDir)).toEqual([]);
  });

  it('reports the canonical reason', async () => {
    const h = harness();
    const input = candidateInput();
    const outcome = await verifyCandidate(h.deps(), {
      ...input,
      authority: { ...input.authority, baseSha: 'b'.repeat(40) },
    });
    expect(outcome).toMatchObject({ kind: 'identity_mismatch', reason: 'wrong_parent' });
  });
});

describe('verifyCandidate: a fresh VM from reconstructed blobs only (AC4)', () => {
  it('creates a new VM per verification and uploads exactly the reconstructed manifest', async () => {
    const h = harness();
    const first = candidateInput(1);
    const second = candidateInput(2);
    await verifyCandidate(h.deps(), first);
    await verifyCandidate(h.deps(), second);
    const creates = h.adapter.calls.filter((c) => c.op === 'create');
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((c) => c.vmId)).size).toBe(2);
    const files = CANDIDATE.entries.filter((e) => e.mode !== '040000');
    for (const { vmId } of creates) {
      const uploads = h.adapter.sourceUploads(vmId);
      expect([...uploads.keys()].sort()).toEqual(files.map((e) => e.path).sort());
      for (const entry of files)
        expect(uploads.get(entry.path)?.equals(Buffer.from(entry.bytes, 'base64'))).toBe(true);
    }
    expect(h.adapter.liveVms()).toEqual([]);
  });

  it('uploads its own validated copy: later caller mutation cannot change the bytes', async () => {
    const h = harness();
    const input = candidateInput();
    const entries = input.manifest.entries.map((e) => ({ ...e }));
    const manifest = { ...input.manifest, entries };
    const pending = verifyCandidate(h.deps(), { ...input, manifest });
    (entries[0] as { bytes: string }).bytes = Buffer.from('mutated').toString('base64');
    verified(await pending);
    const [create] = h.adapter.calls.filter((c) => c.op === 'create');
    const uploads = h.adapter.sourceUploads(create?.vmId as string);
    for (const entry of CANDIDATE.entries.filter((e) => e.mode !== '040000'))
      expect(uploads.get(entry.path)?.equals(Buffer.from(entry.bytes, 'base64'))).toBe(true);
  });
});

describe('verifyCandidate: boundary evidence', () => {
  it('a boundary that does not hold persists the record and blocks the run', async () => {
    const adapter = new VerifierFakeVm(fixtureScript);
    adapter.acceptAbuse = true;
    const h = harness(adapter);
    const input = candidateInput();
    const outcome = verified(await verifyCandidate(h.deps(), input));
    expect(outcome.record.boundaryHeld).toBe(false);
    expect(outcome.verdict).toBe('passed');
    expect(outcome.run.state).toBe('blocked');
    expect(h.observed.map((r) => r.state)).toEqual(['blocked']);
    expect(
      loadVerification(h.artifactsDir, input.candidateSha, { runId: RUN_ID }).boundaryHeld
    ).toBe(false);
  });

  it('a probe that fails is recorded as failed boundary evidence, not thrown', async () => {
    const adapter = new VerifierFakeVm(fixtureScript);
    adapter.boundaryReports = null;
    const h = harness(adapter);
    const outcome = verified(await verifyCandidate(h.deps(), candidateInput()));
    expect(outcome.record.boundaryHeld).toBe(false);
    expect(outcome.run.state).toBe('blocked');
    expect(adapter.liveVms()).toEqual([]);
  });

  it('boundary evidence that cannot be produced blocks the run with no record', async () => {
    const leak = `ghp_${'a'.repeat(36)}`;
    const h = harness(
      new VerifierFakeVm((request, vm) =>
        request.report ? fixtureScript(request, vm) : { stdout: leak }
      )
    );
    const input = candidateInput();
    const outcome = await verifyCandidate(h.deps(), input);
    expect(outcome).toMatchObject({ kind: 'boundary_unavailable', reason: 'finalize_failed' });
    expect(outcome.run.state).toBe('blocked');
    expect(storeFiles(h.artifactsDir)).not.toContain(`verification/${input.candidateSha}.json`);
    expect(h.adapter.liveVms()).toEqual([]);
  });
});

describe('verifyCandidate: refusals and failures', () => {
  it.each([
    [
      'a run that is not verifying',
      { run: transitionRun(verifyingRun(), R.UserPaused, TIME) },
      'run_not_verifying',
    ],
    ['another run id', { runId: 'run-other' }, 'run_mismatch'],
    ['an unreproduced regression', { regressionBase: 'passed' }, 'regression_not_reproduced'],
  ] as const)('refuses %s before any work', async (_, change, code) => {
    const h = harness();
    const deps = { ...h.deps('run' in change ? change.run : undefined) };
    const input = { ...candidateInput() };
    if ('runId' in change) Object.assign(deps, { runId: change.runId });
    if ('regressionBase' in change) Object.assign(input, { regressionBase: change.regressionBase });
    await expect(verifyCandidate(deps, input)).rejects.toMatchObject({
      name: 'VerifierInputError',
      code,
    });
    expect(h.adapter.calls).toEqual([]);
    expect(h.observed).toEqual([]);
  });

  it('refuses missing regression targets before any work', async () => {
    const h = harness();
    await expect(
      verifyCandidate(h.deps(), { ...candidateInput(), regressionTargets: [] })
    ).rejects.toBeInstanceOf(EvidencePlanError);
    expect(h.adapter.calls).toEqual([]);
  });

  it('never verifies the same candidate twice: an existing record is replayed, no VM', async () => {
    const h = harness();
    const input = candidateInput();
    const first = verified(await verifyCandidate(h.deps(), input));
    expect(first.replayed).toBe(false);
    await expect(verifyCandidate(h.deps(first.run), input)).rejects.toMatchObject({
      code: 'run_not_verifying',
    });
    // A crash after the record was written left the saved run in `verifying`.
    const again = verified(await verifyCandidate(h.deps(), input));
    expect(again).toMatchObject({ replayed: true, verdict: 'passed' });
    expect(again.record).toEqual(first.record);
    expect(again.run.state).toBe('shipping');
    expect(h.adapter.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('an attempt that left no record is never re-run: the run is blocked', async () => {
    const h = harness();
    const input = candidateInput();
    beginVerification(h.artifactsDir, input.candidateSha);
    const outcome = await verifyCandidate(h.deps(), input);
    expect(outcome).toMatchObject({ kind: 'interrupted', reason: 'attempt_without_record' });
    expect(outcome.run.state).toBe('blocked');
    expect(h.adapter.calls).toEqual([]);
  });

  it('a record that no longer loads is never replayed: the run is blocked', async () => {
    const h = harness();
    const input = candidateInput();
    verified(await verifyCandidate(h.deps(), input));
    const file = path.join(h.artifactsDir, VERIFICATION_DIRECTORY, `${input.candidateSha}.json`);
    fs.chmodSync(file, 0o644);
    const outcome = await verifyCandidate(h.deps(), input);
    expect(outcome).toMatchObject({ kind: 'interrupted', reason: 'record_unusable' });
    expect(outcome.run.state).toBe('blocked');
    expect(h.adapter.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('refuses a malformed candidate SHA before any work', async () => {
    const h = harness();
    await expect(
      verifyCandidate(h.deps(), { ...candidateInput(), candidateSha: '../x' })
    ).rejects.toMatchObject({ code: 'invalid_candidate' });
    expect(h.adapter.calls).toEqual([]);
  });

  it('journals identity mismatches, completions and aborts', async () => {
    const journal = new Journal(tempDir('zt-verifier-journal-'));
    const h = harness();
    const withJournal = (deps = h.deps()) => ({
      ...deps,
      lifecycle: { ...deps.lifecycle, journal },
    });
    const input = candidateInput();
    await verifyCandidate(withJournal(), {
      ...input,
      authority: { ...input.authority, baseSha: 'a'.repeat(40) },
    });
    const passing = candidateInput(2);
    verified(await verifyCandidate(withJournal(), passing));
    const events = journal.read() as Record<string, unknown>[];
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'verification_identity_mismatch',
        runId: RUN_ID,
        candidateSha: input.candidateSha,
        reason: 'wrong_parent',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'verification_completed',
        candidateSha: passing.candidateSha,
        verdict: 'passed',
        boundaryHeld: true,
      })
    );
  });

  it('a provisioning failure makes the run unsupported, after teardown', async () => {
    const adapter = new VerifierFakeVm(fixtureScript);
    adapter.on(['npm', 'ci', '--ignore-scripts', '--no-fund'], { exitCode: 1 });
    const h = harness(adapter);
    await expect(verifyCandidate(h.deps(), candidateInput())).rejects.toBeInstanceOf(
      ProvisioningFailedError
    );
    expect(h.observed.map((r) => r.state)).toEqual(['unsupported']);
    expect(adapter.liveVms()).toEqual([]);
  });

  it('an adapter error during verification tears down, blocks the run and propagates', async () => {
    const h = harness(
      new VerifierFakeVm((request, vm) => {
        if (request.report) throw new Error('transport lost');
        return fixtureScript(request, vm);
      })
    );
    const input = candidateInput();
    await expect(verifyCandidate(h.deps(), input)).rejects.toThrow('transport lost');
    expect(h.observed.map((r) => r.state)).toEqual(['blocked']);
    expect(h.adapter.liveVms()).toEqual([]);
    // The interrupted attempt is never re-run.
    const retry = await verifyCandidate(h.deps(), input);
    expect(retry).toMatchObject({ kind: 'interrupted', reason: 'attempt_without_record' });
    expect(h.adapter.calls.filter((c) => c.op === 'create')).toHaveLength(1);
  });

  it('a teardown that cannot complete blocks cleanup and never reaches shipping', async () => {
    const adapter = new VerifierFakeVm(fixtureScript);
    const h = harness(adapter);
    const deps = h.deps();
    const pending = verifyCandidate(deps, candidateInput());
    adapter.failDestroy = 4;
    await expect(pending).rejects.toBeInstanceOf(VmCleanupError);
    expect(h.observed.map((r) => r.state)).toEqual(['blocked_cleanup']);
  });
});

describe('verificationPlan', () => {
  it('runs the suite, then only the regression targets, all with no network', () => {
    const plan = verificationPlan(PROFILE, harness().deps().endpoints, [REGRESSION_TEST]);
    expect(plan.verification.map((c) => c.id)).toEqual([
      'npm-rebuild',
      'npm-test',
      `npm-test${REGRESSION_COMMAND_SUFFIX}`,
    ]);
    expect(plan.verification.every((c) => c.network === 'none')).toBe(true);
    expect(plan.verification.at(-1)?.argv).toContain(REGRESSION_TEST);
  });
});

describe('independence (AC6)', () => {
  const SRC = path.join(__dirname, '..');
  it.each([
    'controller/verifier.ts',
    'controller/verification-record.ts',
  ])('%s reaches nothing under src/github/ and no receipt signing', (file) => {
    const reached = importGraph(SRC).reaches(path.join(SRC, file));
    expect(reached.filter((f) => f.startsWith(path.join(SRC, 'github')))).toEqual([]);
    expect(reached).not.toContain(path.join(SRC, 'receipt', 'issue.ts'));
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    expect(text).not.toMatch(/@ai-dossier\/core|issueReceipt|Signer|\.sign\(/u);
  });
});
