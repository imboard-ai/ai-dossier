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
async function relocated(
  fault?:
    | 'author'
    | 'fork'
    | 'missing-author'
    | 'missing-fork'
    | 'upstream'
    | 'label'
    | 'head-user'
    | 'base-id'
    | 'case-branch'
    | 'valid-base'
) {
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
          if (endpoint === '/repos/owner/repo')
            return { status: 200, body: { id: 1, name: 'repo', owner: { login: 'owner' } } };
          if (endpoint.includes('/git/ref/'))
            return {
              status: 200,
              body: { ref: 'refs/heads/task', object: { type: 'commit', sha: SHA } },
            };
          const body = pull(endpoint.endsWith('/3') ? 3 : 2);
          if (endpoint.endsWith('/3')) {
            if (fault === 'author') body.user.login = 'intruder';
            if (fault === 'fork') body.head.repo.id = 9;
            if (fault === 'missing-author') Reflect.deleteProperty(body, 'user');
            if (fault === 'missing-fork') Reflect.deleteProperty(body.head, 'repo');
            if (fault === 'label') body.head.label = 'intruder:other';
            if (fault === 'case-branch') body.head.label = 'contributor:Task';
            if (fault === 'head-user') Object.assign(body.head, { user: { login: 'intruder' } });
            if (fault === 'upstream')
              Object.assign(body.base, {
                repo: {
                  id: 9,
                  name: 'other',
                  owner: { login: 'intruder' },
                  full_name: 'intruder/other',
                },
              });
            if (fault === 'base-id' || fault === 'valid-base')
              Object.assign(body.base, {
                repo: {
                  id: fault === 'base-id' ? 9 : 1,
                  name: 'repo',
                  owner: { login: 'owner' },
                  full_name: 'owner/repo',
                },
              });
          }
          return { status: 200, body };
        },
      },
      { run: store.run, contributionId: store.contributionId, pr, headSha: SHA }
    );
    const result = await tracker.resume();
    if (fault && fault !== 'valid-base') {
      expect(result.kind).not.toBe('merged');
      expect(journal.read().some((event) => (event as { type: string }).type === 'rebound')).toBe(
        false
      );
    } else expect(result).toMatchObject({ kind: 'merged' });
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
it.each([
  'author',
  'fork',
  'missing-author',
  'missing-fork',
  'upstream',
  'label',
  'head-user',
  'base-id',
  'case-branch',
] as const)('AC2 detailed replacement %s contradicts or omits listing identity: no rebound or merge', async (fault) => {
  const { r, store, summary } = await relocated(fault);
  const bundle = exportContribution(store, path.join(r.temp, 'refused-relocation'));
  expect(bundle.pr).toBe('https://github.com/owner/repo/pull/2');
  expect(bundle.relocations).toEqual([]);
  expect(bundle.outcome).not.toBe('merged');
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
});
it('AC2 supplied upstream detail is checked against the independently bound repository read', async () => {
  const { r, store } = await relocated('valid-base');
  expect(exportContribution(store, path.join(r.temp, 'valid-base')).outcome).toBe('merged');
});
it('missing and contradictory portable relocation proof refuses invalid-evidence', async () => {
  const { r, store } = await relocated();
  const bundle = exportContribution(store, path.join(r.temp, 'original-export'));
  const mutations = [
    (b: typeof bundle) => {
      b.relocations = b.relocations.map((proof) => ({
        ...proof,
        from: { ...proof.from, fork: { ...proof.from.fork, repositoryId: 9 } },
        to: { ...proof.to, fork: { ...proof.to.fork, repositoryId: 9 } },
      }));
    },
    (b: typeof bundle) => {
      b.relocations = b.relocations.map((proof) => ({
        ...proof,
        from: { ...proof.from, fork: { ...proof.from.fork, repo: 'other' } },
        to: { ...proof.to, fork: { ...proof.to.fork, repo: 'other' } },
      }));
    },
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
      b.relocations[0].to = {
        ...b.relocations[0].to,
        fork: { ...b.relocations[0].to.fork, repositoryId: 9 },
      };
    },
    (b: typeof bundle) => {
      b.relocations[0].to = {
        ...b.relocations[0].to,
        binding: { ...b.relocations[0].to.binding, branch: 'other' },
      };
    },
    (b: typeof bundle) => {
      b.relocations[0].to = {
        ...b.relocations[0].to,
        binding: {
          ...b.relocations[0].to.binding,
          upstream: { ...b.relocations[0].to.binding.upstream, repo: 'other' },
        },
      };
    },
    (b: typeof bundle) => {
      if (b.summary) b.summary.pr = 'https://github.com/owner/other/pull/2';
    },
    (b: typeof bundle) => {
      b.relocations[0].from = {
        ...b.relocations[0].from,
        url: 'https://github.com/owner/repo/pull/4',
      };
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
