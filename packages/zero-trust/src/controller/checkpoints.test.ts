import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compiledFixture } from '../__tests__/compiled-fixture';
import { assertNoSecrets, SecretRedactionError } from '../redaction';
import { ReasonCode as R, transitionRun } from '../state';
import {
  approveCheckpoint,
  type CheckpointBindings,
  CheckpointError,
  type CheckpointPoint,
  checkpointBindings,
  checkpointDue,
  checkpointStatus,
  newCheckpoint,
  pauseAtCheckpoint,
  rejectCheckpoint,
  restoreCheckpoint,
} from './checkpoints';
import { validateRunConfig } from './config';
import { RunStore, RunStoreError } from './run-store';

const AT = '2026-10-08T00:00:00.000Z';
const LATER = '2026-10-08T00:00:01.000Z';
const roots: string[] = [];
const stores: RunStore[] = [];
const POINTS: CheckpointPoint[] = ['plan', 'patch', 'verification'];
function rig(points: CheckpointPoint[] | null = POINTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-checkpoints-'));
  roots.push(root);
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      profileDir: 'profile',
      stateDir: 'state',
      accelerator: 'auto',
      proxyEndpointsFile: 'endpoints.json',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: [
        {
          resource: 'fake',
          currency: 'USD',
          unit: 'token',
          price: 0,
          units: 1,
          source: 'fixture',
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: AT },
        },
      ],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 100,
      activeMinutes: 120,
    },
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
    ...(points === null ? {} : { checkpoints: points }),
  });
  const directory = path.join(root, 'runs');
  const store = RunStore.create(directory, config, AT);
  stores.push(store);
  return { store, directory };
}
function reopen(directory: string, store: RunStore) {
  const id = store.runId;
  store.close();
  const opened = RunStore.open(directory, id);
  stores.push(opened);
  return opened;
}
function phase(store: RunStore, point: CheckpointPoint) {
  store.persistRun(transitionRun(store.run, R.GatePassed, AT));
  if (point !== 'plan') {
    store.persistRun(transitionRun(store.run, R.PlanApproved, AT));
    store.persistRun(transitionRun(store.run, R.CandidateReady, AT));
    if (point === 'verification')
      store.persistRun(transitionRun(store.run, R.VerificationPassed, AT));
  }
}
function bindings(store: RunStore, point: CheckpointPoint): CheckpointBindings {
  return {
    ...(point === 'plan' ? { planDigest: 'a'.repeat(64) } : { candidateSha: 'b'.repeat(40) }),
    ...(point === 'verification' ? { verificationDigest: 'c'.repeat(64) } : {}),
    policyDigest: 'd'.repeat(64),
    budgetSessionId: store.budgetSessionId(1),
  };
}
function answer(store: RunStore, point: CheckpointPoint) {
  const record = store.checkpoint(point);
  if (!record) throw Error('missing checkpoint');
  return { point, digest: record.digest };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('durable checkpoints', () => {
  it.each(POINTS)('%s refuses wrong approvals without any durable mutation', (point) => {
    let { store, directory } = rig();
    phase(store, point);
    pauseAtCheckpoint(store, store.run, point, bindings(store, point), AT);
    const run = store.run;
    const record = store.checkpoint(point);
    const journal = path.join(store.directory, 'control/events.jsonl');
    const bytes = fs.readFileSync(journal);
    expect(() =>
      approveCheckpoint(store, store.run, { point, digest: '0'.repeat(64) }, AT)
    ).toThrow(new CheckpointError('checkpoint_stale'));
    expect(store.run).toEqual(run);
    expect(store.checkpoint(point)).toEqual(record);
    expect(fs.readFileSync(journal)).toEqual(bytes);
    store = reopen(directory, store);
    expect(store.run).toEqual(run);
    expect(store.checkpoint(point)).toEqual(record);
    expect(fs.readFileSync(journal)).toEqual(bytes);
  });

  it('refuses direct and multi-edge resume bypasses live and on replay', () => {
    let { store, directory } = rig();
    phase(store, 'verification');
    pauseAtCheckpoint(store, store.run, 'verification', bindings(store, 'verification'), AT);
    const resumed = transitionRun(store.run, R.ResumeShipping, AT);
    const advanced = transitionRun(resumed, R.PublicationObserved, AT);
    const journal = path.join(store.directory, 'control/events.jsonl');
    const bytes = fs.readFileSync(journal);
    for (const next of [resumed, advanced]) {
      expect(() => store.persistRun(next)).toThrow(RunStoreError);
      expect(store.run.state).toBe('paused_user');
      expect(fs.readFileSync(journal)).toEqual(bytes);
    }
    store = reopen(directory, store);
    const id = store.runId;
    store.close();
    fs.appendFileSync(journal, `${JSON.stringify({ v: 1, type: 'run', run: advanced })}\n`);
    expect(() => RunStore.open(directory, id)).toThrow(RunStoreError);
  });

  it('an open pre-pause record prevents skipping the boundary but allows cancellation', () => {
    const { store } = rig();
    phase(store, 'plan');
    const data = bindings(store, 'plan');
    store.recordCheckpointBindings('plan', data);
    store.persistCheckpoint(newCheckpoint(store.run, 'plan', data, AT));
    expect(() => store.persistRun(transitionRun(store.run, R.PlanApproved, AT))).toThrow(
      RunStoreError
    );
    store.persistRun(transitionRun(store.run, R.UserCancelled, AT));
    expect(store.run.state).toBe('cancelled');
  });

  it('malformed inputs give fixed secret-free diagnostics without writes', () => {
    const { store } = rig();
    phase(store, 'plan');
    pauseAtCheckpoint(store, store.run, 'plan', bindings(store, 'plan'), AT);
    const marker = 'supplied-private-marker';
    const bad = { extra: () => marker };
    const getter = {
      get extra() {
        throw new Error(marker);
      },
    };
    const journal = path.join(store.directory, 'control/events.jsonl');
    const bytes = fs.readFileSync(journal);
    const record = store.checkpoint('plan');
    const calls = [
      () => checkpointBindings(bad, 'plan', store.runId),
      () => restoreCheckpoint(bad),
      () => restoreCheckpoint(getter),
      () => approveCheckpoint(store, store.run, { ...answer(store, 'plan'), ...bad } as never, AT),
      () => approveCheckpoint(store, store.run, { point: 'plan', digest: 'bad' }, AT),
      () => pauseAtCheckpoint(store, store.run, 'plan', bindings(store, 'plan'), new Date(NaN)),
      () => approveCheckpoint(store, store.run, answer(store, 'plan'), new Date(NaN)),
      () => rejectCheckpoint(store, store.run, answer(store, 'plan'), 'reason', new Date(NaN)),
    ];
    for (const call of calls) {
      try {
        call();
        throw new Error('expected refusal');
      } catch (error) {
        expect(error).toEqual(new CheckpointError('checkpoint_invalid'));
        expect(String(error)).not.toContain(marker);
        expect((error as Error).stack).not.toContain(marker);
        expect((error as Error).cause).toBeUndefined();
        assertNoSecrets(String(error));
      }
    }
    expect(store.checkpoint('plan')).toEqual(record);
    expect(fs.readFileSync(journal)).toEqual(bytes);
  });

  it.each(POINTS)('%s permits durable rejection of stale content, never approval', (point) => {
    let { store, directory } = rig();
    phase(store, point);
    const data = bindings(store, point);
    pauseAtCheckpoint(store, store.run, point, data, AT);
    const approval = answer(store, point);
    const changed = { ...data, policyDigest: 'e'.repeat(64) };
    store.recordCheckpointBindings(point, changed);
    store = reopen(directory, store);
    const run = store.run;
    const journal = path.join(store.directory, 'control/events.jsonl');
    const bytes = fs.readFileSync(journal);
    expect(() => approveCheckpoint(store, store.run, approval, LATER)).toThrow(
      new CheckpointError('checkpoint_stale')
    );
    expect(store.run).toEqual(run);
    expect(fs.readFileSync(journal)).toEqual(bytes);
    const status = checkpointStatus(store.checkpoint(point) as never, changed);
    expect(status.nextPermittedAction).toContain('is stale; reject');
    assertNoSecrets(status.nextPermittedAction);
    rejectCheckpoint(store, store.run, approval, 'obsolete content', LATER);
    store = reopen(directory, store);
    expect(store.run.state).toBe('cancelled');
    expect(store.checkpoint(point)?.status).toBe('rejected');
    expect(store.checkpoint(point)?.rejectionReason).toBe('obsolete content');
  });

  it.each(
    POINTS
  )('%s pauses once, persists before the pause, resumes exactly and stays closed', (point) => {
    let { store } = rig();
    const directory = path.dirname(store.directory);
    phase(store, point);
    const interrupted = store.run.state;
    const data = bindings(store, point);
    pauseAtCheckpoint(store, store.run, point, data, AT);
    const entries = fs
      .readFileSync(path.join(store.directory, 'control/events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const recordIndex = entries.findIndex((e) => e.type === 'checkpoint');
    const pauseIndex = entries.findIndex((e) => e.type === 'run' && e.run.state === 'paused_user');
    expect(recordIndex).toBeGreaterThan(-1);
    expect(pauseIndex).toBeGreaterThan(recordIndex);
    expect(store.run.state).toBe('paused_user');
    const history = store.run.history.length;
    pauseAtCheckpoint(store, store.run, point, data, LATER);
    expect(store.run.history).toHaveLength(history);
    store = reopen(directory, store);
    const record = store.checkpoint(point);
    if (!record) throw Error('missing');
    assertNoSecrets(JSON.stringify(record));
    const status = checkpointStatus(record);
    assertNoSecrets(status.nextPermittedAction);
    expect(status.nextPermittedAction).toContain(`--point ${point} --digest ${record.digest}`);
    expect(status.nextPermittedAction).toContain(
      point === 'plan'
        ? 'artifacts/plan.txt'
        : point === 'patch'
          ? 'artifacts/candidate.diff'
          : 'artifacts/verification.json'
    );
    const approval = answer(store, point);
    approveCheckpoint(store, store.run, approval, LATER);
    expect(store.run.state).toBe(interrupted);
    store = reopen(directory, store);
    expect(store.checkpoint(point)?.status).toBe('approved');
    expect(() => approveCheckpoint(store, store.run, approval, LATER)).toThrow(
      new CheckpointError('checkpoint_closed')
    );
    expect(checkpointStatus(store.checkpoint(point) ?? record).nextPermittedAction).toContain(
      'no further approval'
    );
    pauseAtCheckpoint(store, store.run, point, data, LATER);
    expect(store.run.state).toBe(interrupted);
  });

  it.each(POINTS)('%s recovers a crash between record and UserPaused idempotently', (point) => {
    let { store, directory } = rig();
    phase(store, point);
    const data = bindings(store, point);
    const state = store.run.state;
    store.recordCheckpointBindings(point, data);
    store.persistCheckpoint(newCheckpoint(store.run, point, data, AT));
    store = reopen(directory, store);
    expect(store.run.state).toBe(state);
    expect(store.checkpoint(point)?.status).toBe('open');
    pauseAtCheckpoint(store, store.run, point, data, LATER);
    expect(store.run.state).toBe('paused_user');
    const records = fs
      .readFileSync(path.join(store.directory, 'control/events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"type":"checkpoint"'));
    expect(records).toHaveLength(1);
    approveCheckpoint(store, store.run, answer(store, point), LATER);
    expect(store.run.state).toBe(state);
  });

  it('default config runs fake steps through shipping without records, ignoring mutated config copies', () => {
    const { store, directory } = rig(null);
    expect(store.config.checkpoints).toEqual([]);
    const configCopy = store.config;
    (configCopy.checkpoints as CheckpointPoint[]).push('plan');
    store.persistRun(transitionRun(store.run, R.GatePassed, AT));
    const planning = store.run;
    pauseAtCheckpoint(store, store.run, 'plan', bindings(store, 'plan'), AT);
    expect(store.run).toEqual(planning);
    store.persistRun(transitionRun(store.run, R.PlanApproved, AT));
    store.persistRun(transitionRun(store.run, R.CandidateReady, AT));
    const verifying = store.run;
    pauseAtCheckpoint(store, store.run, 'patch', bindings(store, 'patch'), AT);
    expect(store.run).toEqual(verifying);
    store.persistRun(transitionRun(store.run, R.VerificationPassed, AT));
    const shipping = store.run;
    pauseAtCheckpoint(store, store.run, 'verification', bindings(store, 'verification'), AT);
    expect(store.run).toEqual(shipping);
    expect(store.run.state).toBe('shipping');
    const opened = reopen(directory, store);
    for (const point of POINTS) expect(opened.checkpoint(point)).toBeUndefined();
    expect(opened.run.history.some((event) => event.reasonCode === R.UserPaused)).toBe(false);
    expect(
      fs.readFileSync(path.join(opened.directory, 'control/events.jsonl'), 'utf8')
    ).not.toContain('checkpoint');
  });

  it.each([
    'candidate',
    'policy',
    'session',
    'verification',
    'plan',
  ])('changed %s invalidates an old approval across reopen', (change) => {
    let { store, directory } = rig();
    const point = change === 'plan' ? 'plan' : 'verification';
    phase(store, point);
    const data = bindings(store, point);
    pauseAtCheckpoint(store, store.run, point, data, AT);
    const approval = answer(store, point);
    store.recordCheckpointBindings(point, {
      ...data,
      ...(change === 'candidate' ? { candidateSha: 'e'.repeat(40) } : {}),
      ...(change === 'policy' ? { policyDigest: 'e'.repeat(64) } : {}),
      ...(change === 'session' ? { budgetSessionId: store.budgetSessionId(2) } : {}),
      ...(change === 'verification' ? { verificationDigest: 'e'.repeat(64) } : {}),
      ...(change === 'plan' ? { planDigest: 'e'.repeat(64) } : {}),
    });
    store = reopen(directory, store);
    const run = store.run;
    const record = store.checkpoint(point);
    const journal = path.join(store.directory, 'control/events.jsonl');
    const bytes = fs.readFileSync(journal);
    expect(() => approveCheckpoint(store, store.run, approval, LATER)).toThrow(
      new CheckpointError('checkpoint_stale')
    );
    expect(store.run.state).toBe('paused_user');
    expect(store.checkpoint(point)?.status).toBe('open');
    expect(store.run).toEqual(run);
    expect(store.checkpoint(point)).toEqual(record);
    expect(fs.readFileSync(journal)).toEqual(bytes);
    store = reopen(directory, store);
    expect(store.run).toEqual(run);
    expect(store.checkpoint(point)).toEqual(record);
  });

  it('refuses mismatched digest, wrong point, stale run snapshot, wrong phase and invalid time', () => {
    const { store } = rig();
    expect(() => pauseAtCheckpoint(store, store.run, 'plan', bindings(store, 'plan'), AT)).toThrow(
      new CheckpointError('checkpoint_not_open')
    );
    phase(store, 'plan');
    const before = store.run;
    pauseAtCheckpoint(store, store.run, 'plan', bindings(store, 'plan'), AT);
    expect(() => approveCheckpoint(store, before, answer(store, 'plan'), AT)).toThrow(
      new CheckpointError('checkpoint_stale')
    );
    expect(() =>
      approveCheckpoint(store, store.run, { point: 'plan', digest: '0'.repeat(64) }, AT)
    ).toThrow(new CheckpointError('checkpoint_stale'));
    expect(() =>
      approveCheckpoint(
        store,
        store.run,
        { point: 'patch', digest: answer(store, 'plan').digest },
        AT
      )
    ).toThrow(new CheckpointError('checkpoint_not_open'));
    expect(() => approveCheckpoint(store, store.run, answer(store, 'plan'), 'bad')).toThrow(
      new CheckpointError('checkpoint_invalid')
    );
    expect(() =>
      approveCheckpoint(store, store.run, { ...answer(store, 'plan'), extra: true } as never, AT)
    ).toThrow(new CheckpointError('checkpoint_invalid'));
    expect(() =>
      approveCheckpoint(store, store.run, { point: 'plan', digest: [] } as never, AT)
    ).toThrow(new CheckpointError('checkpoint_invalid'));
    expect(() =>
      approveCheckpoint(store, store.run, { point: 'unknown', digest: 'a' } as never, AT)
    ).toThrow(new CheckpointError('checkpoint_invalid'));
  });

  it('rejects and durably records the reason without resuming', () => {
    let { store, directory } = rig();
    phase(store, 'patch');
    pauseAtCheckpoint(store, store.run, 'patch', bindings(store, 'patch'), AT);
    const approval = answer(store, 'patch');
    rejectCheckpoint(store, store.run, approval, 'Scope needs revision', new Date(LATER));
    store = reopen(directory, store);
    expect(store.run.state).toBe('cancelled');
    expect(store.checkpoint('patch')?.rejectionReason).toBe('Scope needs revision');
    expect(() => rejectCheckpoint(store, store.run, approval, 'again', LATER)).toThrow(
      new CheckpointError('checkpoint_closed')
    );
    assertNoSecrets(checkpointStatus(store.checkpoint('patch') as never).nextPermittedAction);
  });

  it('refuses secret-bearing records, status, bindings and rejection reasons before writing', () => {
    const { store } = rig();
    phase(store, 'plan');
    const data = bindings(store, 'plan');
    const secret = 'ghp_012345678901234567890123456789012345';
    expect(() =>
      pauseAtCheckpoint(store, store.run, 'plan', { ...data, planDigest: secret }, AT)
    ).toThrow(SecretRedactionError);
    expect(store.checkpoint('plan')).toBeUndefined();
    pauseAtCheckpoint(store, store.run, 'plan', data, AT);
    const record = store.checkpoint('plan');
    expect(() => checkpointStatus({ ...record, rejectionReason: secret } as never)).toThrow(
      SecretRedactionError
    );
    expect(() => rejectCheckpoint(store, store.run, answer(store, 'plan'), secret, AT)).toThrow(
      SecretRedactionError
    );
    expect(store.run.state).toBe('paused_user');
  });

  it.each([
    { planDigest: [] },
    { policyDigest: 'x' },
    { extra: true },
    { candidateSha: 'a'.repeat(40) },
    { budgetSessionId: 'other-s1' },
    { budgetSessionId: 'ztc-0000000000000000-run-1-s1' },
    { verificationDigest: 'c'.repeat(64) },
  ])('validates bindings and emits only fixed errors: %j', (bad) => {
    const { store } = rig();
    expect(() =>
      checkpointBindings({ ...bindings(store, 'plan'), ...bad }, 'plan', store.runId)
    ).toThrow(new CheckpointError('checkpoint_invalid'));
  });

  it('validates digest schema, point selection and persisted record tampering', () => {
    const { store } = rig();
    phase(store, 'plan');
    const record = newCheckpoint(store.run, 'plan', bindings(store, 'plan'), AT);
    for (const bad of [
      { digest: '0'.repeat(64) },
      { point: 'unknown' },
      { interruptedState: 'shipping' },
      { interruptedHistoryLength: -1 },
      { runId: 'bad' },
      { createdAt: 'bad' },
      { status: 'unknown' },
      { resolvedAt: AT },
      { rejectionReason: 'reason' },
      { extra: 1 },
    ]) {
      expect(() => restoreCheckpoint({ ...record, ...bad })).toThrow(CheckpointError);
    }
    expect(() => restoreCheckpoint({ ...record, status: 'approved' })).toThrow(CheckpointError);
    expect(() =>
      restoreCheckpoint({ ...record, status: 'rejected', resolvedAt: AT, rejectionReason: '' })
    ).toThrow(CheckpointError);
    expect(checkpointDue([], 'plan')).toBe(false);
    expect(checkpointDue(['patch'], 'patch')).toBe(true);
    expect(() => checkpointDue(['plan', 'plan'], 'plan')).toThrow(CheckpointError);
    expect(() => checkpointDue(['other'] as never, 'plan')).toThrow(CheckpointError);
    expect(() => checkpointDue(null as never, 'plan')).toThrow(CheckpointError);
    expect(() =>
      store.recordCheckpointBindings('patch', {
        candidateSha: 'x',
        policyDigest: 'a'.repeat(64),
        budgetSessionId: store.budgetSessionId(1),
      })
    ).toThrow(CheckpointError);
  });

  it('cannot approve a pause unrelated to its open checkpoint', () => {
    const { store } = rig();
    phase(store, 'plan');
    store.persistRun(transitionRun(store.run, R.UserPaused, AT));
    expect(() =>
      approveCheckpoint(store, store.run, { point: 'plan', digest: 'a'.repeat(64) }, AT)
    ).toThrow(new CheckpointError('checkpoint_not_open'));
  });

  it('refuses changed retry bindings and displaced pre-pause records', () => {
    const { store } = rig();
    phase(store, 'plan');
    const data = bindings(store, 'plan');
    store.recordCheckpointBindings('plan', data);
    store.persistCheckpoint(newCheckpoint(store.run, 'plan', data, AT));
    expect(() =>
      pauseAtCheckpoint(store, store.run, 'plan', { ...data, planDigest: 'e'.repeat(64) }, AT)
    ).toThrow(new CheckpointError('checkpoint_stale'));
    store.persistRun(transitionRun(store.run, R.UserCancelled, AT));
    expect(() => pauseAtCheckpoint(store, store.run, 'plan', data, AT)).toThrow(
      new CheckpointError('checkpoint_not_open')
    );
    expect(() => approveCheckpoint(store, store.run, answer(store, 'plan'), AT)).toThrow(
      new CheckpointError('checkpoint_not_open')
    );
  });

  it.each([
    'approve',
    'reject',
  ])('recovers %s decision when process dies before snapshot replacement', (decision) => {
    let { store, directory } = rig();
    phase(store, 'patch');
    pauseAtCheckpoint(store, store.run, 'patch', bindings(store, 'patch'), AT);
    const id = store.runId;
    store.close();
    const entry = compiledFixture(path.dirname(directory), 'controller/checkpoints');
    const script = `const fs=require('node:fs');const z=require(process.argv[3]);const {RunStore}=require(require('node:path').join(require('node:path').dirname(process.argv[3]),'run-store'));const s=RunStore.open(process.argv[1],process.argv[2]);fs.renameSync=()=>process.exit(73);const a={point:'patch',digest:s.checkpoint('patch').digest};if(process.argv[4]==='approve')z.approveCheckpoint(s,s.run,a,'${LATER}');else z.rejectCheckpoint(s,s.run,a,'review rejected','${LATER}');`;
    const child = spawnSync(process.execPath, ['-e', script, directory, id, entry, decision], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(child.status, child.stderr).toBe(73);
    store = RunStore.open(directory, id);
    stores.push(store);
    expect(store.run.state).toBe(decision === 'approve' ? 'verifying' : 'cancelled');
    expect(store.checkpoint('patch')?.status).toBe(
      decision === 'approve' ? 'approved' : 'rejected'
    );
    expect(() => approveCheckpoint(store, store.run, answer(store, 'patch'), LATER)).toThrow(
      new CheckpointError('checkpoint_closed')
    );
  });

  it('refuses duplicate records, unconfigured bindings and forged resolution', () => {
    const { store } = rig(['plan']);
    phase(store, 'plan');
    const data = bindings(store, 'plan');
    const record = newCheckpoint(store.run, 'plan', data, AT);
    expect(() => store.persistCheckpoint(record)).toThrow(RunStoreError);
    store.recordCheckpointBindings('plan', data);
    store.recordCheckpointBindings('plan', data);
    store.persistCheckpoint(record);
    expect(() => store.persistCheckpoint(record)).toThrow(RunStoreError);
    expect(() => store.recordCheckpointBindings('patch', bindings(store, 'patch'))).toThrow(
      RunStoreError
    );
    expect(() =>
      store.resolveCheckpoint({ ...record, status: 'approved', resolvedAt: AT }, store.run)
    ).toThrow(RunStoreError);
    pauseAtCheckpoint(store, store.run, 'plan', data, AT);
    expect(() =>
      store.resolveCheckpoint(
        { ...record, status: 'approved', resolvedAt: AT },
        transitionRun(store.run, R.UserCancelled, AT)
      )
    ).toThrow(new RunStoreError('run_diverged'));
  });
});
