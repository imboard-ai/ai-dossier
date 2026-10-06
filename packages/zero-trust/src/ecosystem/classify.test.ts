import { describe, expect, it } from 'vitest';
import { evidenceVerified } from '../receipt/schema';
import {
  createRun,
  deserializeRun,
  IllegalTransitionError,
  ReasonCode as R,
  type RunRecord,
  serializeRun,
  transitionRun,
} from '../state';
import {
  applyProvisioning,
  applyVerification,
  assertRepairAllowed,
  type CommandOutcome,
  classifyOutcome,
  classifyRegression,
  commandEvidence,
  MAX_REPAIR_ATTEMPTS,
  overallStatus,
  RepairCapExceededError,
  repairsUsed,
} from './classify';
import { buildCommandPlan } from './commands';

const time = '2026-10-06T00:00:00.000Z';
const move = (run: RunRecord, ...reasons: R[]) =>
  reasons.reduce((r, reason) => transitionRun(r, reason, time), run);
const verifying = () =>
  move(
    createRun(
      { runId: 'run-1', upstreamIssue: 'https://github.com/o/r/issues/1', contributor: 'alice' },
      time
    ),
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady
  );
const exited = (exitCode: number, suites: number | null): CommandOutcome => ({
  kind: 'exited',
  exitCode,
  report: suites === null ? null : { suites },
});

describe('classifyOutcome', () => {
  it.each<[string, CommandOutcome, string]>([
    ['timeout is inconclusive, never a pass', { kind: 'timeout' }, 'inconclusive'],
    ['killed by a signal', { kind: 'signal', signal: 'SIGKILL' }, 'inconclusive'],
    ['exit 0 with a missing or unreadable report', exited(0, null), 'inconclusive'],
    ['non-zero exit with no report (runner crash?)', exited(1, null), 'inconclusive'],
    ['exit 0 but zero suites discovered', exited(0, 0), 'inconclusive'],
    ['non-zero exit with zero suites discovered', exited(1, 0), 'inconclusive'],
    ['negative suite count', exited(1, -1), 'inconclusive'],
    [
      'corrupt suite count',
      { kind: 'exited', exitCode: 0, report: { suites: Number.NaN } },
      'inconclusive',
    ],
    ['failing tests with a readable report', exited(1, 3), 'failed'],
    ['passing tests with a readable report', exited(0, 3), 'passed'],
  ])('%s', (_name, outcome, status) => {
    expect(classifyOutcome(outcome)).toBe(status);
  });
});

describe('commandEvidence', () => {
  const [command] = buildCommandPlan('pip', {
    npmRegistry: 'http://npm-proxy:4873/',
    pypiIndex: 'http://pypi-proxy:5000/index/',
  }).verification;
  const digest = 'a'.repeat(64);

  it('records a timeout with unknown exit status and suites; it cannot verify', () => {
    const evidence = commandEvidence(command, { kind: 'timeout' }, digest);
    expect(evidence).toEqual({
      id: 'pytest',
      command: '/opt/ztfc/env/bin/python -m pytest',
      required: true,
      status: 'inconclusive',
      exitStatus: 'unknown',
      suites: 'unknown',
      sanitizedLogDigest: digest,
    });
    expect(evidenceVerified([evidence])).toBe(false);
  });

  it('records an unreadable report as inconclusive with the real exit code', () => {
    const evidence = commandEvidence(command, exited(0, null), digest);
    expect(evidence).toMatchObject({ status: 'inconclusive', exitStatus: 0, suites: 'unknown' });
    expect(evidenceVerified([evidence])).toBe(false);
  });

  it('never copies an invalid suite count into the receipt', () => {
    expect(commandEvidence(command, exited(0, -3), digest).suites).toBe('unknown');
    expect(commandEvidence(command, exited(0, 1.5), digest).suites).toBe('unknown');
  });

  it('keeps out-of-range exit codes unknown and passes only on full evidence', () => {
    expect(commandEvidence(command, exited(300, 1), digest).exitStatus).toBe('unknown');
    const passed = commandEvidence(command, exited(0, 4), digest);
    expect(passed).toMatchObject({ status: 'passed', exitStatus: 0, suites: 4 });
    expect(evidenceVerified([passed])).toBe(true);
  });
});

describe('overallStatus', () => {
  it.each<[string[], string]>([
    [[], 'inconclusive'],
    [['passed', 'passed'], 'passed'],
    [['passed', 'failed'], 'failed'],
    [['failed', 'inconclusive'], 'inconclusive'],
    [['passed', 'skipped'], 'inconclusive'],
  ])('%j → %s', (statuses, expected) => {
    expect(overallStatus(statuses as never)).toBe(expected);
  });
});

describe('classifyRegression (scenario 6)', () => {
  it.each([
    ['failed', 'passed', 'reproduced_and_fixed'],
    ['passed', 'passed', 'not_reproduced'],
    ['failed', 'failed', 'still_failing'],
    ['failed', 'inconclusive', 'inconclusive'],
    ['inconclusive', 'passed', 'inconclusive'],
    ['skipped', 'passed', 'inconclusive'],
  ])('base %s, candidate %s → %s', (base, candidate, proof) => {
    expect(classifyRegression(base as never, candidate as never)).toBe(proof);
  });
});

describe('applyProvisioning', () => {
  it.each([
    'failed',
    'inconclusive',
    'skipped',
  ] as const)('a %s provisioning (e.g. an sdist-only dependency) is unsupported_environment', (verdict) => {
    const run = applyProvisioning(verifying(), verdict, time);
    expect(run.state).toBe('unsupported');
    expect(run.history.at(-1)?.reasonCode).toBe(R.UnsupportedEnvironment);
  });

  it('a passing provisioning leaves the run unchanged', () => {
    const run = verifying();
    expect(applyProvisioning(run, 'passed', time)).toBe(run);
  });
});

describe('two-repair cap (scenario 7)', () => {
  it('allows two repairs, then refuses the third and fails the run', () => {
    let run = verifying();
    expect(MAX_REPAIR_ATTEMPTS).toBe(2);
    run = applyVerification(run, 'failed', time);
    expect(run.state).toBe('implementing');
    run = applyVerification(move(run, R.CandidateReady), 'inconclusive', time);
    expect(run.state).toBe('implementing');
    expect(repairsUsed(run)).toBe(2);
    expect(() => assertRepairAllowed(run)).toThrow(RepairCapExceededError);
    run = applyVerification(move(run, R.CandidateReady), 'failed', time);
    expect(run.state).toBe('failed');
    expect(run.history.at(-1)?.reasonCode).toBe(R.ExecutionFailed);
  });

  it('a timeout after the cap fails rather than passing', () => {
    const run = move(
      verifying(),
      R.RepairRequired,
      R.CandidateReady,
      R.RepairRequired,
      R.CandidateReady
    );
    expect(applyVerification(run, 'inconclusive', time).state).toBe('failed');
  });

  it('derives the cap from immutable history, so a restored run keeps it', () => {
    const run = deserializeRun(
      serializeRun(
        move(verifying(), R.RepairRequired, R.CandidateReady, R.RepairRequired, R.CandidateReady)
      )
    );
    expect(() => assertRepairAllowed(run)).toThrow(
      expect.objectContaining({ name: 'RepairCapExceededError', repairsUsed: 2 })
    );
  });

  it('counts repairs across a pause and resume', () => {
    const run = move(
      verifying(),
      R.RepairRequired,
      R.UserPaused,
      R.ResumeImplementing,
      R.CandidateReady
    );
    expect(repairsUsed(run)).toBe(1);
    expect(() => assertRepairAllowed(run)).not.toThrow();
  });

  it('passes verification into shipping', () => {
    expect(applyVerification(verifying(), 'passed', time).state).toBe('shipping');
  });

  it('a revision session starts with a fresh repair budget', () => {
    const run = move(
      verifying(),
      R.RepairRequired,
      R.CandidateReady,
      R.RepairRequired,
      R.CandidateReady,
      R.VerificationPassed,
      R.PublicationObserved,
      R.RevisionRequested,
      R.CandidateReady
    );
    expect(repairsUsed(run)).toBe(0);
    expect(applyVerification(run, 'failed', time).state).toBe('implementing');
  });

  it('rejects verdicts outside the verifying state', () => {
    const run = move(verifying(), R.RepairRequired);
    expect(() => applyVerification(run, 'passed', time)).toThrow(IllegalTransitionError);
  });
});
