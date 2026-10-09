import fs from 'node:fs';
import path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, producerEvidence, START } from '../../fixtures/retention';
import { BudgetLedger, estimateBudget } from '../budget';
import { RunStore } from '../controller/run-store';
import { lstatIfPresent } from '../durable-fs';
import { recordAdoption } from '../metrics/outcomes';
import { issueReceipt } from '../receipt/issue';
import { exportContribution, validateContributionExport } from './export';
import { applySweep, planSweep } from './retention';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);

it('real tracker mixed-case repository URLs remain exportable and sweepable', async () => {
  const r = rig();
  await producerEvidence(r, true, 'https://github.com/Owner/Repo/pull/2');
  expect(exportContribution(r.store, path.join(r.temp, 'mixed')).pr).toBe(
    'https://github.com/Owner/Repo/pull/2'
  );
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const store = r.open();
  expect(exportContribution(store, path.join(r.temp, 'mixed-expired')).outcome).toBe('merged');
});

it('validates original PR semantics and intact receipt bindings without a relocation', async () => {
  const r = rig();
  await producerEvidence(r);
  const bundle = exportContribution(r.store, path.join(r.temp, 'original'));
  expect(validateContributionExport(bundle)).toEqual(bundle);
  const mutations = [
    (b: typeof bundle) => {
      if (b.originalPr)
        b.originalPr = { ...b.originalPr, fork: { ...b.originalPr.fork, repositoryId: 999 } };
    },
    (b: typeof bundle) => {
      if (b.originalPr) b.originalPr = { ...b.originalPr, marker: 'not a marker' };
    },
    (b: typeof bundle) => {
      if (b.originalPr) b.originalPr = { ...b.originalPr, number: 999 };
    },
    (b: typeof bundle) => {
      if (b.originalPr)
        b.originalPr = { ...b.originalPr, url: 'https://github.com/foreign/project/pull/2' };
    },
    (b: typeof bundle) => {
      b.pr = b.status.pr = 'https://github.com/owner/repo/pull/99';
    },
    (b: typeof bundle) => {
      b.pr = b.status.pr = 'https://github.com/owner/repo/pull/999999999999999999999';
      b.originalPr = null;
    },
    (b: typeof bundle) => {
      b.run = { ...b.run, contributor: 'not a login' };
      b.receipts = [];
      b.verification = null;
      b.originalPr = null;
    },
    (b: typeof bundle) => {
      b.run = { ...b.run, upstreamIssue: 'https://foreign.example/issues/1' };
      b.status.upstreamIssue = b.run.upstreamIssue;
      b.pr = b.status.pr = 'https://foreign.example/pull/2';
      b.receipts = [];
      b.verification = null;
      b.originalPr = null;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(bundle);
    mutate(changed);
    expect(() => validateContributionExport(changed)).toThrow();
  }
});

it.each([
  'upstream',
  'session',
  'budget-session',
] as const)('authentic receipt %s contradiction refuses local export', async (fault) => {
  const r = rig();
  r.store.recordUpstreamRepositoryId(1);
  await producerEvidence(r);
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  const old = bundle.receipts[0].receipt;
  const {
    schemaVersion: _schema,
    issuedAt: _issued,
    expiresAt: _expires,
    verified: _verified,
    ...receiptInput
  } = old;
  const signed = await issueReceipt(
    {
      ...receiptInput,
      ...(fault === 'upstream'
        ? { upstreamRepositoryId: 999 }
        : {
            sessionId:
              fault === 'session' ? 'ztc-0000000000000000-run-1-s1' : r.store.budgetSessionId(2),
          }),
    },
    new Ed25519Signer(r.key),
    () => Date.parse(START)
  );
  r.write('receipt-evidence.json', [signed]);
  expect(() => exportContribution(r.store, path.join(r.temp, 'contradiction'))).toThrow();
});

it('missing optional tracker exports unknown after an actual observed merge and permits sweep', async () => {
  const r = rig();
  await producerEvidence(r);
  fs.unlinkSync(path.join(r.directory, 'track/events.jsonl'));
  const bundle = exportContribution(r.store, path.join(r.temp, 'unknown'));
  expect(bundle.status).toMatchObject({ outcome: 'unknown', outcomeSha: null });
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const reopened = r.open();
  expect(exportContribution(reopened, path.join(r.temp, 'expired-unknown')).outcome).toBe(
    'unknown'
  );
});

it.each([
  'summary',
  'expired',
  'quarantined',
  'deleted',
] as const)('pending first batch resumes before aged later adoption after %s', (crash) => {
  const r = rig();
  r.artifact('one');
  r.artifact('two');
  r.close();
  expect(() =>
    applySweep(planSweep(r.root, NOW), (point) => {
      if (point === crash) throw new Error('crash');
    })
  ).toThrow('crash');
  const summary = fs.readFileSync(path.join(r.directory, 'summary.json'));
  const store = r.open();
  recordAdoption(store, 'Voluntary observation', NOW);
  store.close();
  r.age();
  const future = '2027-12-01T00:00:00.000Z';
  const retry = planSweep(r.root, future);
  expect(retry.contributions).toHaveLength(1);
  expect(retry.contributions[0].generation).toBeUndefined();
  applySweep(retry);
  expect(fs.existsSync(path.join(r.directory, 'artifacts/adoption.json'))).toBe(true);
  applySweep(planSweep(r.root, future));
  expect(fs.existsSync(path.join(r.directory, 'artifacts/adoption.json'))).toBe(false);
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
});

it('completed override does not pin subsequent default or different-override generations', () => {
  const r = rig(90);
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW, 30));
  const store = r.open();
  recordAdoption(store, 'Later observation', NOW);
  store.close();
  r.age();
  const future = '2027-12-01T00:00:00.000Z';
  const plan = planSweep(r.root, future);
  expect(plan.contributions[0].retentionDays).toBe(90);
  applySweep(plan);
  expect(planSweep(r.root, future, 7).contributions).toEqual([]);
});

it.each([
  'lock',
  'guard',
])('public artifact .%s suffix still counts as recent activity', (suffix) => {
  const r = rig();
  r.age();
  r.store.replaceArtifact(`snapshot.${suffix}`, Buffer.from('fresh'));
  r.store.close();
  expect(planSweep(r.root, new Date()).contributions).toEqual([]);
});

it('maintenance refuses native async before invocation and rejects thenables', () => {
  const r = rig();
  let invoked = false;
  const callback = async () => {
    invoked = true;
  };
  // Deliberate runtime invalid input; production types also forbid promises.
  expect(() => r.store.withPinnedDirectory(callback as unknown as () => void)).toThrow(
    'invalid_store'
  );
  expect(invoked).toBe(false);
  expect(() =>
    r.store.withPinnedDirectory((() => Promise.resolve()) as unknown as () => void)
  ).toThrow('invalid_store');
});

it.each([
  'run.json',
  'config.json',
  'control/events.jsonl',
])('oversized %s refuses before maintenance opening can read it whole', (name) => {
  const r = rig();
  r.close();
  const file = path.join(r.directory, name);
  const original = fs.readFileSync(file);
  const cap = name.endsWith('jsonl') ? 16 * 1024 * 1024 : 1024 * 1024;
  fs.writeFileSync(file, Buffer.concat([original, Buffer.alloc(cap, 32)]));
  expect(() => RunStore.open(r.root, r.runId, { readOnly: true })).toThrow();
  expect(() => planSweep(r.root, new Date())).toThrow();
});

it.each([
  'settle',
  'release',
] as const)('retained budget %s advances current costs without rewriting expiry evidence', async (mode) => {
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
          maxInputTokens: 2,
          maxOutputTokens: 3,
          retries: 0,
          streamingTimeMs: 1000,
        },
      },
      [r.rate]
    )
  );
  r.artifact();
  r.close();
  applySweep(planSweep(r.root, NOW));
  const summary = fs.readFileSync(path.join(r.directory, 'summary.json'));
  if (mode === 'settle')
    ledger.settle(reservation.id, {
      money: { currency: 'USD', minor: 3 },
      tokens: 3,
      timeMs: 100,
      source: 'reconciled',
    });
  else ledger.release(reservation.id, 'confirmed absent');
  const store = r.open();
  const bundle = exportContribution(store, path.join(r.temp, 'reconciled'));
  expect(bundle.summary?.costTotals).not.toEqual(bundle.status.costTotals);
  expect(() => store.assertResumable()).toThrow('snapshot_expired');
  store.close();
  applySweep(planSweep(r.root, '2027-12-01T00:00:00.000Z'));
  expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summary);
  const current = JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  current.reservations[0].observed.money.minor++;
  fs.writeFileSync(ledger.file, JSON.stringify(current));
  const changed = r.open();
  expect(() => exportContribution(changed, path.join(r.temp, 'rewritten'))).toThrow(
    'invalid-summary'
  );
});

it('shared no-follow presence distinguishes missing, ordinary, dangling and inaccessible paths', () => {
  const r = rig();
  const file = path.join(r.temp, 'presence');
  expect(lstatIfPresent(file)).toBeNull();
  fs.writeFileSync(file, 'present');
  expect(lstatIfPresent(file)?.isFile()).toBe(true);
  const link = path.join(r.temp, 'dangling');
  fs.symlinkSync(path.join(r.temp, 'missing'), link);
  expect(lstatIfPresent(link)?.isSymbolicLink()).toBe(true);
  expect(() => lstatIfPresent(path.join(file, 'child'))).toThrow();
});
