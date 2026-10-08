import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, HASH, NOW } from '../../fixtures/retention';
import { approveCheckpoint, pauseAtCheckpoint, rejectCheckpoint } from '../controller/checkpoints';
import { ReasonCode, transitionRun } from '../state';
import { exportContribution } from './export';
import { applySweep, planSweep, readContributionSummary } from './retention';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('actual swept checkpoint approval refuses with no control or run snapshot writes; rejection stays permitted', () => {
  const r = rig(undefined, ['plan']);
  r.store.persistRun(transitionRun(r.store.run, ReasonCode.GatePassed, r.store.run.updatedAt));
  r.artifact('plan', 'approved plan');
  pauseAtCheckpoint(
    r.store,
    r.store.run,
    'plan',
    { policyDigest: HASH, planDigest: HASH, budgetSessionId: r.store.budgetSessionId(1) },
    r.store.run.updatedAt
  );
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open(),
    answer = { point: 'plan' as const, digest: store.checkpoint('plan')?.digest ?? '' };
  const journal = path.join(r.directory, 'control/events.jsonl'),
    snapshot = path.join(r.directory, 'run.json');
  const beforeJournal = fs.readFileSync(journal),
    beforeRun = fs.readFileSync(snapshot);
  expect(() => approveCheckpoint(store, store.run, answer, NOW)).toThrow('snapshot_expired');
  expect(fs.readFileSync(journal)).toEqual(beforeJournal);
  expect(fs.readFileSync(snapshot)).toEqual(beforeRun);
  expect(store.checkpoint('plan')?.status).toBe('open');
  expect(rejectCheckpoint(store, store.run, answer, 'Cancelled by contributor', NOW).state).toBe(
    'cancelled'
  );
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
});
it('ordinary and multi-edge active transitions cannot bypass expiry by ending in a safe terminal state', () => {
  const r = rig();
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open(),
    journal = path.join(r.directory, 'control/events.jsonl'),
    before = fs.readFileSync(journal);
  const active = transitionRun(store.run, ReasonCode.GatePassed, NOW);
  expect(() => store.persistRun(active)).toThrow('snapshot_expired');
  expect(() => store.persistRun(transitionRun(active, ReasonCode.UserCancelled, NOW))).toThrow(
    'snapshot_expired'
  );
  expect(fs.readFileSync(journal)).toEqual(before);
  store.persistRun(transitionRun(store.run, ReasonCode.UserCancelled, NOW));
  expect(store.run.state).toBe('cancelled');
});
it('observed publication/review/outcome status can still persist after expiry', () => {
  const r = rig();
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
  ])
    r.store.persistRun(transitionRun(r.store.run, reason, r.store.run.updatedAt));
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open();
  for (const reason of [
    ReasonCode.PublicationObserved,
    ReasonCode.ReviewAwaited,
    ReasonCode.UpstreamAccepted,
    ReasonCode.ObservedUpstreamMerge,
  ])
    store.persistRun(transitionRun(store.run, reason, NOW));
  expect(store.run.state).toBe('merged');
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
});
it('a normal 5000-file summary over 1MiB roundtrips and replays a durable crash prefix', () => {
  const r = rig();
  for (let i = 0; i < 5000; i++) r.artifact(`file-${'a'.repeat(96)}-${String(i).padStart(5, '0')}`);
  r.close();
  const plan = planSweep(r.root, NOW);
  expect(() =>
    applySweep(plan, (point) => {
      if (point === 'summary') throw new Error('crash');
    })
  ).toThrow('crash');
  expect(fs.statSync(path.join(r.directory, 'summary.json')).size).toBeGreaterThan(1024 * 1024);
  const store = r.open();
  expect(readContributionSummary(store)?.sweep.files).toHaveLength(5000);
  expect(
    exportContribution(store, path.join(r.temp, 'summary-export')).status.snapshotExpired
  ).toBe(true);
  store.close();
  applySweep(plan);
  applySweep(planSweep(r.root, NOW));
  expect(fs.readdirSync(path.join(r.directory, 'artifacts'))).toEqual([]);
}, 120000);
it('unsupported serialized summary refuses during dry run before summary, expiry or deletion', () => {
  const r = rig(),
    prefix = `${`${'p'.repeat(100)}/`.repeat(10)}`;
  for (let i = 0; i < 4000; i++) r.artifact(`${prefix}${i}`);
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow('size-limit');
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
  expect(fs.existsSync(path.join(r.directory, '.snapshot-expired'))).toBe(false);
  expect(fs.readdirSync(path.join(r.directory, 'artifacts', prefix))).toHaveLength(4000);
}, 120000);
