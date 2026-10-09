import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createFixtures,
  NOW,
  producerEvidence,
  SHA,
  START,
  signedReceipt,
} from '../../fixtures/retention';
import { BudgetLedger, estimateBudget } from '../budget';
import { RunStore } from '../controller/run-store';
import { handoffMarker } from '../github/handoff';
import { PrTracker } from '../github/track';
import { Journal } from '../journal';
import { contributionOutcome } from '../metrics/outcomes';
import { SecretRedactionError } from '../redaction';
import { ReasonCode, transitionRun } from '../state';
import { exportContribution, validateContributionExport } from './export';
import { applySweep, planSweep } from './retention';
import { inventory } from './sweep-files';

it('missing verification yields null attribution; portable null/empty evidence never permits an invented verified SHA', async () => {
  const r = rig();
  await producerEvidence(r);
  fs.unlinkSync(path.join(r.directory, 'receipt-evidence.json'));
  const bundle = exportContribution(r.store, path.join(r.temp, 'missing'));
  expect(bundle.status.verifiedSha).toBeNull();
  expect(bundle.status.outcomeSha).toBe(SHA);
  for (const verification of [null, []]) {
    const changed = structuredClone(bundle);
    changed.status.verifiedSha = 'f'.repeat(40);
    changed.verification = verification;
    expect(() => validateContributionExport(changed)).toThrow('invalid-evidence');
  }
});
it('shared metrics projection preserves crossed estimated/observed totals and unknown observations through expiry', async () => {
  const r = rig();
  await producerEvidence(r);
  const ledger = new BudgetLedger(
    path.join(r.directory, 'budget/ledger.json'),
    r.store.contributionId
  );
  const reservation = ledger.reserve(
    r.store.budgetSessionId(1),
    estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'fake',
          maxInputTokens: 19,
          maxOutputTokens: 1,
          retries: 0,
          streamingTimeMs: 1000,
        },
      },
      [r.rate]
    )
  );
  ledger.settle(reservation.id, {
    money: { currency: 'USD', minor: 1 },
    tokens: 1,
    timeMs: 1,
    source: 'model_usage',
  });
  const expected = contributionOutcome(r.store);
  expect(expected.cost.byCurrency).toMatchObject({ USD: { estimatedMinor: 25, observedMinor: 9 } });
  const bundle = exportContribution(r.store, path.join(r.temp, 'metrics'));
  expect(bundle.status.metrics).toEqual({ outcome: expected.outcome, cost: expected.cost });
  expect(bundle.status.costTotals?.[0].spent).toBe(28);
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open();
  const swept = exportContribution(store, path.join(r.temp, 'swept'));
  expect(swept.summary?.metrics).toEqual(bundle.status.metrics);
  ledger.reserve(
    store.budgetSessionId(1),
    estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'fake',
          maxInputTokens: 1,
          maxOutputTokens: 1,
          retries: 0,
          streamingTimeMs: 1,
        },
      },
      [r.rate]
    )
  );
  const pending = exportContribution(store, path.join(r.temp, 'pending'));
  expect(pending.status.metrics.cost.byCurrency).toMatchObject({
    USD: { observedMinor: 'unknown' },
  });
  expect(pending.summary?.metrics).toEqual(swept.summary?.metrics);
});
it('actual accepted initial tracker retains available metrics accepted outcome in summary/export', async () => {
  const r = rig();
  r.store.recordUpstreamRepositoryId(1);
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.PublicationObserved,
    ReasonCode.ReviewAwaited,
    ReasonCode.UpstreamAccepted,
  ])
    r.store.persistRun(transitionRun(r.store.run, reason, START));
  r.write('receipt-evidence.json', [await signedReceipt(r)]);
  const journal = new Journal(r.store.storeDirectory('track'));
  new PrTracker(
    journal,
    {
      read: async () => ({ status: 404, body: null }),
      bodyDirectory: r.store.storeDirectory('bodies'),
      now: () => NOW,
      admission: {
        policyFresh: async () => true,
        contributorVerified: async () => true,
        forkBindingVerified: async () => true,
      },
    },
    {
      run: r.store.run,
      contributionId: r.store.contributionId,
      headSha: SHA,
      pr: {
        binding: {
          upstream: { owner: 'owner', repo: 'repo' },
          base: 'main',
          headOwner: 'contributor',
          branch: 'task',
        },
        fork: { repositoryId: 2, owner: 'contributor', repo: 'repo' },
        number: 2,
        url: 'https://github.com/owner/repo/pull/2',
        marker: handoffMarker({
          contributionId: r.store.contributionId,
          target: 'owner/repo#1',
          operationKind: 'pr_create',
          candidateSha: SHA,
        }),
      },
    }
  );
  journal.close();
  expect(contributionOutcome(r.store).outcome).toBe('accepted');
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const bundle = exportContribution(r.open(), path.join(r.temp, 'accepted'));
  expect(bundle.summary?.outcome).toBe('accepted');
  expect(bundle.summary?.metrics.outcome).toBe('accepted');
  expect(validateContributionExport(bundle)).toEqual(bundle);
});
it('already-held read-only store refuses actual control recovery before publication', async () => {
  const r = rig();
  await producerEvidence(r);
  r.close();
  const store = RunStore.open(r.root, r.runId, { readOnly: true });
  try {
    const directory = path.join(r.directory, 'control');
    fs.appendFileSync(path.join(directory, 'events.jsonl'), '{"torn":');
    const truncate = fs.ftruncateSync.bind(fs);
    const spy = vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, size) => {
      truncate(fd, size);
      throw new Error('crash after truncate');
    });
    expect(() => new Journal(directory)).toThrow();
    spy.mockRestore();
    const before = inventory(r.directory).protectedDigest;
    expect(() => exportContribution(store, path.join(r.temp, 'invalid'))).toThrow();
    expect(fs.existsSync(path.join(r.temp, 'invalid'))).toBe(false);
    expect(inventory(r.directory).protectedDigest).toBe(before);
  } finally {
    store.close();
  }
});
it.each([
  'run.json',
  'config.json',
  'control/events.jsonl',
])('held and reopened maintenance preserve safe secret diagnostic for %s', async (name) => {
  const r = rig();
  await producerEvidence(r);
  const file = path.join(r.directory, name);
  const bytes = fs.readFileSync(file, 'utf8');
  if (name.endsWith('jsonl')) {
    const rows = bytes
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    rows[0].discarded = 'ghp_planted';
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  } else fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(bytes), discarded: 'ghp_planted' }));
  expect(() => exportContribution(r.store, path.join(r.temp, 'invalid'))).toThrow(
    SecretRedactionError
  );
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow(SecretRedactionError);
});
it('expiry resume guard preserves the safe secret diagnostic', async () => {
  const r = rig();
  await producerEvidence(r);
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open();
  const file = path.join(r.directory, 'summary.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), discarded: 'ghp_planted' })
  );
  expect(() => store.assertResumable()).toThrow(SecretRedactionError);
});

const { rig, cleanup } = createFixtures();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it('portable and persisted unsupported verified SHA refuses despite intact original receipt', async () => {
  const r = rig();
  await producerEvidence(r);
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  bundle.status.verifiedSha = 'c'.repeat(40);
  expect(() => validateContributionExport(bundle)).toThrow('invalid-evidence');
  r.artifact();
  r.close();
  const file = path.join(r.directory, 'track/events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  events[0].verifiedSha = 'c'.repeat(40);
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  r.age();
  const before = inventory(r.directory).protectedDigest;
  const store = r.open();
  expect(() => exportContribution(store, path.join(r.temp, 'invalid'))).toThrow('invalid-evidence');
  store.close();
  expect(() => planSweep(r.root, NOW)).toThrow('invalid-evidence');
  expect(inventory(r.directory).protectedDigest).toBe(before);
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
});
it('portable credential refusal preserves SecretRedactionError; malformed snapshots still map safely', () => {
  const r = rig();
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  bundle.disclosure = 'ghp_planted';
  expect(() => validateContributionExport(bundle)).toThrow(SecretRedactionError);
  expect(() => validateContributionExport({ impossible: 1n })).toThrow('invalid-input');
});
it.each([
  'track',
  'handoff',
])('actual %s journal interrupted after truncate leaves sidecar that refuses export, plan and stale apply before writes', async (directory) => {
  const r = rig();
  await producerEvidence(r);
  const artifact = r.artifact();
  r.close();
  const plan = planSweep(r.root, NOW);
  const dir = path.join(r.directory, directory);
  const file = path.join(dir, 'events.jsonl');
  fs.appendFileSync(file, '{"incomplete":');
  const truncate = fs.ftruncateSync.bind(fs);
  const spy = vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, length) => {
    truncate(fd, length);
    throw new Error('crash after truncate');
  });
  expect(() => new Journal(dir)).toThrow();
  spy.mockRestore();
  expect(fs.existsSync(`${file}.recovery`)).toBe(true);
  r.age();
  const before = inventory(r.directory).protectedDigest;
  const store = r.open();
  expect(() => exportContribution(store, path.join(r.temp, 'invalid'))).toThrow('invalid-evidence');
  store.close();
  expect(() => planSweep(r.root, NOW)).toThrow('invalid-evidence');
  expect(() => applySweep(plan)).toThrow();
  expect(fs.existsSync(artifact)).toBe(true);
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
  expect(inventory(r.directory).protectedDigest).toBe(before);
});
it.each([
  'track',
  'handoff',
])('present null/malformed/symlink %s recovery intents are never silently skipped', async (directory) => {
  const r = rig();
  await producerEvidence(r);
  const file = path.join(r.directory, directory, 'events.jsonl.recovery');
  for (const content of ['null', 'not json']) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    expect(() => exportContribution(r.store, path.join(r.temp, 'invalid'))).toThrow(
      'invalid-evidence'
    );
    fs.unlinkSync(file);
  }
  fs.symlinkSync('/nonexistent-owned-target', file);
  expect(() => exportContribution(r.store, path.join(r.temp, 'invalid'))).toThrow(
    'invalid-evidence'
  );
});
