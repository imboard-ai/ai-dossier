import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, producerEvidence, SHA } from '../../fixtures/retention';
import { PrTracker, replayTrack } from '../github/track';
import { Journal } from '../journal';
import { exportContribution, validateContributionExport } from './export';
import { applySweep, planSweep, readContributionSummary } from './retention';
import { inventory } from './sweep-files';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
async function relocated() {
  const r = rig();
  await producerEvidence(r, false);
  r.artifact();
  r.close();
  const before = inventory(r.directory).protectedDigest;
  applySweep(planSweep(r.root, NOW));
  expect(inventory(r.directory).protectedDigest).toBe(before);
  const summary = fs.readFileSync(path.join(r.directory, 'summary.json'));
  const store = r.open();
  const journal = new Journal(store.storeDirectory('track'));
  const pr = replayTrack(journal.read()).pr;
  const pull = (number: number) => ({
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: 'closed',
    merged: number === 3,
    merged_at: number === 3 ? NOW : null,
    user: { login: 'contributor' },
    head: { sha: SHA, ref: 'task', label: 'contributor:task', repo: { id: 2 } },
    base: { ref: 'main' },
    title: 'Fix',
    body: pr.marker,
  });
  try {
    const tracker = new PrTracker(
      journal,
      {
        bodyDirectory: store.storeDirectory('bodies'),
        now: () => NOW,
        admission: {
          policyFresh: async () => true,
          contributorVerified: async () => true,
          forkBindingVerified: async () => true,
        },
        read: async (endpoint) => {
          if (endpoint.includes('/pulls?')) return { status: 200, body: [pull(2), pull(3)] };
          if (endpoint === '/repos/contributor/repo')
            return {
              status: 200,
              body: { id: 2, name: 'repo', owner: { login: 'contributor' } },
            };
          if (endpoint.includes('/git/ref/'))
            return {
              status: 200,
              body: { ref: 'refs/heads/task', object: { type: 'commit', sha: SHA } },
            };
          return { status: 200, body: pull(endpoint.endsWith('/3') ? 3 : 2) };
        },
      },
      { run: store.run, contributionId: store.contributionId, pr, headSha: SHA }
    );
    expect(await tracker.resume()).toMatchObject({ kind: 'merged' });
    store.persistRun(tracker.snapshot().run);
  } finally {
    journal.close();
  }
  return { r, store, summary };
}
it('AC2 real sweep → marked relocation → merge → export/replan preserves expiry links, SHAs and protected hashes', async () => {
  const { r, store, summary } = await relocated();
  const before = inventory(r.directory).protectedDigest;
  const bundle = exportContribution(store, path.join(r.temp, 'relocated-export'));
  expect(validateContributionExport(bundle)).toEqual(bundle);
  expect(bundle.summary).toMatchObject({
    pr: 'https://github.com/owner/repo/pull/2',
    verifiedSha: SHA,
    outcomeSha: null,
  });
  expect(bundle.status).toMatchObject({
    pr: 'https://github.com/owner/repo/pull/3',
    verifiedSha: SHA,
    outcomeSha: SHA,
    outcome: 'merged',
    snapshotExpired: true,
  });
  expect(bundle.relocations).toHaveLength(1);
  expect(readContributionSummary(store)?.facts.pr).toBe(bundle.summary?.pr);
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
  store.close();
  applySweep(planSweep(r.root, NOW));
  expect(inventory(r.directory).protectedDigest).toBe(before);
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
});
it('missing and contradictory portable relocation proof refuses invalid-evidence', async () => {
  const { r, store } = await relocated();
  const bundle = exportContribution(store, path.join(r.temp, 'original-export'));
  const mutations = [
    (b: typeof bundle) => {
      b.relocations = [];
    },
    (b: typeof bundle) => {
      b.relocations[0].body = 'not marked';
    },
    (b: typeof bundle) => {
      b.relocations[0].author = 'other';
    },
    (b: typeof bundle) => {
      b.relocations[0].to.fork.repositoryId = 9;
    },
    (b: typeof bundle) => {
      b.relocations[0].to.binding.branch = 'other';
    },
    (b: typeof bundle) => {
      b.relocations[0].to.binding.upstream.repo = 'other';
    },
    (b: typeof bundle) => {
      if (b.summary) b.summary.pr = 'https://github.com/owner/other/pull/2';
    },
    (b: typeof bundle) => {
      b.relocations[0].from.url = 'https://github.com/owner/repo/pull/4';
    },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(bundle);
    mutate(altered);
    expect(() => validateContributionExport(altered)).toThrow('invalid-evidence');
  }
});
it.each([
  'missing',
  'fork',
  'branch',
  'marker',
  'upstream',
])('forged journal relocation (%s) refuses export/replan without changing expiry or protected bytes', async (fault) => {
  const { r, store, summary } = await relocated();
  store.close();
  const file = path.join(r.directory, 'track/events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const rebound = events.find((e) => e.type === 'rebound');
  if (fault === 'missing') delete rebound.evidence;
  if (fault === 'fork') rebound.evidence.to.fork.repositoryId = 9;
  if (fault === 'branch') rebound.evidence.to.binding.branch = 'other';
  if (fault === 'marker') rebound.evidence.body = 'not marked';
  if (fault === 'upstream') rebound.evidence.to.url = 'https://github.com/owner/other/pull/3';
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const before = inventory(r.directory).protectedDigest;
  const reopened = r.open();
  expect(() => exportContribution(reopened, path.join(r.temp, 'forged-export'))).toThrow(
    'invalid-evidence'
  );
  expect(() => reopened.assertResumable()).toThrow('snapshot_expired');
  reopened.close();
  expect(() => planSweep(r.root, NOW)).toThrow(/invalid-(evidence|summary)/u);
  expect(inventory(r.directory).protectedDigest).toBe(before);
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
  expect(fs.existsSync(path.join(r.temp, 'forged-export'))).toBe(false);
});
