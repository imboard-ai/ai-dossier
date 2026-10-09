import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, producerEvidence, SHA, START } from '../../fixtures/retention';
import { RunStore } from '../controller/run-store';
import { PrTracker, replayTrack } from '../github/track';
import { Journal } from '../journal';
import { recordAdoption } from '../metrics/outcomes';
import { exportContribution } from './export';
import { applySweep, planSweep } from './retention';
import { inventory } from './sweep-files';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
async function trackerRig() {
  const r = rig();
  await producerEvidence(r, false);
  const journal = new Journal(r.store.storeDirectory('track'));
  const pr = replayTrack(journal.read()).pr;
  let merged = false;
  let tick = Date.parse('2026-01-02T00:00:00Z');
  const tracker = new PrTracker(
    journal,
    {
      bodyDirectory: r.store.storeDirectory('bodies'),
      now: () => {
        tick += 1000;
        return new Date(tick).toISOString();
      },
      admission: {
        policyFresh: async () => true,
        contributorVerified: async () => true,
        forkBindingVerified: async () => true,
      },
      read: async (endpoint) => {
        if (/\/pulls\/2$/u.test(endpoint))
          return {
            status: 200,
            body: {
              number: 2,
              html_url: pr.url,
              state: merged ? 'closed' : 'open',
              merged,
              user: { login: 'contributor' },
              head: { sha: SHA, ref: 'task', repo: { id: 2 } },
              base: { ref: 'main' },
              title: 'Fix',
              body: pr.marker,
            },
          };
        if (endpoint === '/repos/contributor/repo') return { status: 200, body: { id: 2 } };
        if (endpoint.includes('/git/ref/'))
          return {
            status: 200,
            body: { ref: 'refs/heads/task', object: { type: 'commit', sha: SHA } },
          };
        if (endpoint.includes('/reviews?'))
          return {
            status: 200,
            body: [
              {
                id: 1,
                user: { login: 'maintainer', type: 'User' },
                author_association: 'MEMBER',
                body: 'Please handle the empty case',
                state: 'CHANGES_REQUESTED',
                submitted_at: START,
                commit_id: SHA,
                html_url: `${pr.url}#pullrequestreview-1`,
              },
            ],
          };
        if (endpoint.includes('/check-runs?'))
          return { status: 200, body: { total_count: 0, check_runs: [] } };
        if (endpoint.includes('/actions/runs?'))
          return { status: 200, body: { total_count: 0, workflow_runs: [] } };
        if (endpoint.endsWith('/status'))
          return { status: 200, body: { total_count: 0, state: 'pending' } };
        return { status: 200, body: [] };
      },
    },
    { run: r.store.run, contributionId: r.store.contributionId, pr, headSha: SHA }
  );
  return {
    r,
    journal,
    tracker,
    merge: () => {
      merged = true;
    },
  };
}
it.each([
  'awaiting_review',
  'revising',
] as const)('maintenance refuses real tracker-owned %s tail loss', async (state) => {
  const { r, journal, tracker } = await trackerRig();
  const file = path.join(r.directory, 'track/events.jsonl');
  const prefix = fs.readFileSync(file);
  try {
    if (state === 'awaiting_review') await tracker.resume();
    else expect(await tracker.beginRevision()).toMatchObject({ kind: 'revising' });
    r.store.persistRun(tracker.snapshot().run);
  } finally {
    journal.close();
  }
  expect(r.store.run.state).toBe(state);
  fs.writeFileSync(file, prefix);
  const before = inventory(r.directory).protectedDigest;
  expect(() => exportContribution(r.store, path.join(r.temp, 'tail-loss'))).toThrow(
    'invalid-evidence'
  );
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
  expect(inventory(r.directory).protectedDigest).toBe(before);
});
it('real merged-during-revision exports observed merge separately from blocked execution and sweeps', async () => {
  const { r, journal, tracker, merge } = await trackerRig();
  try {
    expect(await tracker.beginRevision()).toMatchObject({ kind: 'revising' });
    merge();
    expect(await tracker.resume()).toMatchObject({
      kind: 'blocked',
      reason: 'merged_during_revision',
    });
    r.store.persistRun(tracker.snapshot().run);
  } finally {
    journal.close();
  }
  const bundle = exportContribution(r.store, path.join(r.temp, 'revision-merge'));
  expect(bundle.run.state).toBe('blocked');
  expect(bundle.status).toMatchObject({ outcome: 'merged', outcomeSha: SHA });
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open();
  expect(exportContribution(store, path.join(r.temp, 'expired-revision-merge')).outcome).toBe(
    'merged'
  );
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
});
it('legacy revision block without observed SHA is unknown, never an inferred merge', async () => {
  const { r, journal, tracker, merge } = await trackerRig();
  try {
    await tracker.beginRevision();
    merge();
    await tracker.resume();
    r.store.persistRun(tracker.snapshot().run);
  } finally {
    journal.close();
  }
  const file = path.join(r.directory, 'track/events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete events[events.length - 1].observedMergeSha;
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  expect(exportContribution(r.store, path.join(r.temp, 'legacy-block')).status).toMatchObject({
    outcome: 'unknown',
    outcomeSha: null,
  });
});
it('maintenance refuses a real repaired tracker tail, without changing protected bytes', async () => {
  const r = rig();
  await producerEvidence(r, false);
  fs.appendFileSync(path.join(r.directory, 'track/events.jsonl'), '{');
  new Journal(r.store.storeDirectory('track')).close();
  const before = inventory(r.directory).protectedDigest;
  expect(() => exportContribution(r.store, path.join(r.temp, 'recovered'))).toThrow(
    'invalid-evidence'
  );
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
  expect(inventory(r.directory).protectedDigest).toBe(before);
});
it('maintenance refuses held upstream identity divergence with the same complete RunStore comparison as metrics', () => {
  const r = rig();
  r.store.recordUpstreamRepositoryId(1);
  const file = path.join(r.directory, 'control/events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  events.find((event) => event.type === 'upstream').repositoryId = 9;
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const before = inventory(r.directory).protectedDigest;
  expect(() => r.store.validateOutcomeEvidence()).toThrow();
  expect(() => exportContribution(r.store, path.join(r.temp, 'diverged'))).toThrow();
  expect(inventory(r.directory).protectedDigest).toBe(before);
});
it('read-only archive maintenance needs stored config, not a deleted execution signing key', () => {
  const r = rig();
  r.artifact();
  r.close();
  fs.unlinkSync(r.key);
  const before = inventory(r.directory).protectedDigest;
  expect(() => RunStore.open(r.root, r.runId)).toThrow();
  applySweep(planSweep(r.root, NOW));
  expect(inventory(r.directory).protectedDigest).toBe(before);
  const archive = RunStore.open(r.root, r.runId, { readOnly: true });
  try {
    expect(exportContribution(archive, path.join(r.temp, 'archived')).status.snapshotExpired).toBe(
      true
    );
  } finally {
    archive.close();
  }
});
it.each([
  'retained',
  'active',
] as const)('budget %s transaction owner cannot yield known costs or expiry', async (owner) => {
  const r = rig();
  await producerEvidence(r);
  const file = path.join(r.directory, 'budget/ledger.json.lock');
  // Any unresolved owner requires reconciliation, including a dead owner's
  // retained file. Reporting never steals it or treats readable data as settled.
  fs.writeFileSync(file, JSON.stringify({ pid: owner === 'active' ? process.pid : 999999 }), {
    mode: 0o600,
  });
  const before = inventory(r.directory).protectedDigest;
  expect(() => exportContribution(r.store, path.join(r.temp, 'uncertain-cost'))).toThrow();
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
  expect(inventory(r.directory).protectedDigest).toBe(before);
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
});
it.each([
  'summary',
  'quarantined',
  'deleted',
] as const)('later adoption generation retains first summary and crash-replays after %s', (crash) => {
  const r = rig();
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const summary = fs.readFileSync(path.join(r.directory, 'summary.json'));
  const store = r.open();
  recordAdoption(store, 'Voluntary adoption', NOW);
  store.close();
  const adoption = path.join(r.directory, 'artifacts/adoption.json');
  fs.utimesSync(adoption, new Date(NOW), new Date(NOW));
  const before = inventory(r.directory).protectedDigest;
  applySweep(planSweep(r.root, NOW));
  expect(fs.existsSync(adoption)).toBe(true);
  const future = '2026-12-01T00:00:00.000Z';
  const plan = planSweep(r.root, future);
  expect(plan.contributions[0].generation).toMatch(/^\.retention-generation-/u);
  expect(plan.contributions[0].files.map((file) => file.path)).toEqual(['artifacts/adoption.json']);
  expect(() =>
    applySweep(plan, (point) => {
      if (point === crash) throw new Error('crash');
    })
  ).toThrow('crash');
  applySweep(planSweep(r.root, future));
  expect(fs.existsSync(adoption)).toBe(false);
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
  expect(inventory(r.directory).protectedDigest).toBe(before);
  const reopened = r.open();
  expect(() => reopened.assertResumable()).toThrow('snapshot_expired');
});
