import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtures, producerEvidence as evidence } from '../../fixtures/retention';
import { BudgetLedger } from '../budget';
import { logArtifact } from '../controller/evidence-runner';
import { RunStore } from '../controller/run-store';
import { replacePrivate } from '../durable-fs';
import { engagementBody } from '../github/handoff';
import { HandoffDriver } from '../github/handoff-driver';
import { Journal } from '../journal';
import { ReasonCode, transitionRun } from '../state';
import { contributionEvidence } from './evidence';
import { EXPORT_SCHEMA, exportContribution, validateContributionExport } from './export';
import { inDirectory, jsonRecord, optionalBytes } from './files';
import { applySweep, assertResumable, planSweep, readContributionSummary } from './retention';

const START = '2026-01-01T00:00:00.000Z';
const NOW = '2026-03-01T00:00:00.000Z';
const SHA = 'a'.repeat(40);
const { rig, cleanup, stores } = createFixtures();
const verificationMetadata = {
  phase: 'verification',
  network: 'none',
  timedOut: false,
  captureReport: true,
  tests: 2,
  failures: 0,
  skipped: 0,
  durationMs: 100,
};
function hashes(directory: string) {
  const result: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (
        relative === 'artifacts' ||
        relative === 'summary.json' ||
        relative === '.snapshot-expired' ||
        /^\.retention-(generation|completed)-[a-f0-9]{64}\.json$/u.test(relative)
      )
        continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file, relative);
      else result[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(directory, '');
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('retention acceptance criteria', () => {
  it('AC1/2/4 keeps every protected byte and exports producer-backed facts after reopen', async () => {
    const r = rig();
    const receipt = await evidence(r);
    const bulk = r.artifact('snapshots/source');
    r.artifact('logs/verification');
    // Every protected store has real bytes, including stores excluded from export.
    for (const name of [
      'intents',
      'handoff',
      'tokens',
      'push-ledger',
      'nonces',
      'vm',
      'profile',
      'bodies',
    ])
      r.write(`${name}/preserve.json`, { preserved: name });
    r.close();
    const before = hashes(r.directory);
    const plan = planSweep(r.root, NOW);
    expect(plan.contributions[0].files.map((f) => f.path)).toEqual([
      'artifacts/logs/verification',
      'artifacts/snapshots/source',
    ]);
    expect(fs.existsSync(bulk)).toBe(true);
    applySweep(plan);
    expect(hashes(r.directory)).toEqual(before);
    expect(fs.existsSync(bulk)).toBe(false);
    const store = r.open();
    expect(() => assertResumable(store)).toThrow('snapshot_expired');
    expect(() => store.assertResumeMatches(r.config)).toThrow('snapshot_expired');
    const summary = readContributionSummary(store);
    expect(summary?.facts.pr).toBe('https://github.com/owner/repo/pull/2');
    expect(summary?.facts.outcomeSha).toBe(SHA);
    expect(summary?.facts.receiptDigests).toEqual([receipt.digest]);
    expect(summary?.facts.costTotals?.[0]).toMatchObject({
      spent: 8,
      reserved: 0,
      tokens: 8,
      timeMs: 1000,
    });
    const output = path.join(r.temp, 'portfolio.json');
    const bundle = exportContribution(store, output);
    expect(new Ajv().compile(EXPORT_SCHEMA)(JSON.parse(fs.readFileSync(output, 'utf8')))).toBe(
      true
    );
    expect(bundle.receipts).toEqual([receipt]);
    expect(bundle.status).toMatchObject({
      pr: summary?.facts.pr,
      verifiedSha: SHA,
      outcomeSha: SHA,
      outcome: 'merged',
      snapshotExpired: true,
    });
    expect(bundle.verification?.[0].commands).toEqual(receipt.receipt.commands);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(output, 'utf8')).not.toContain(r.temp);
    expect(() => exportContribution(store, output)).toThrow();
    expect(hashes(r.directory)).toEqual(before);
  });
  it.each([
    'summary',
    'expired',
    'quarantined',
    'deleted',
  ] as const)('AC3 replays durable crash prefix after %s', (point) => {
    const r = rig();
    const first = r.artifact('one');
    r.artifact('nested/two');
    r.close();
    const before = hashes(r.directory);
    const plan = planSweep(r.root, NOW);
    expect(() =>
      applySweep(plan, (boundary) => {
        if (boundary === point) throw new Error('crash');
      })
    ).toThrow('crash');
    const summaryBytes = fs.readFileSync(path.join(r.directory, 'summary.json'));
    const resumed = r.open();
    expect(() => assertResumable(resumed)).toThrow('snapshot_expired');
    resumed.close();
    applySweep(plan);
    applySweep(plan);
    applySweep(planSweep(r.root, NOW));
    expect(fs.readFileSync(path.join(r.directory, 'summary.json'))).toEqual(summaryBytes);
    expect(fs.existsSync(first)).toBe(false);
    expect(hashes(r.directory)).toEqual(before);
  });
  it('AC5 config default30, explicit override, exact cutoff and configured retention', () => {
    const r = rig();
    r.artifact();
    r.close();
    expect(planSweep(r.root, '2026-01-31T00:00:00.000Z').contributions).toHaveLength(0);
    expect(planSweep(r.root, '2026-01-31T00:00:00.001Z').contributions).toHaveLength(1);
    expect(planSweep(r.root, NOW, 90).contributions).toHaveLength(0);
    const configured = rig(90);
    configured.artifact();
    configured.close();
    expect(planSweep(configured.root, NOW).contributions).toHaveLength(0);
    const plan = planSweep(configured.root, new Date(NOW), 30);
    expect(plan.contributions).toHaveLength(1);
    applySweep(plan);
  });
  it('never sweeps blocked_cleanup', () => {
    const r = rig();
    r.store.persistRun(
      transitionRun(r.store.run, ReasonCode.CleanupFailed, '2026-01-01T00:00:01.000Z')
    );
    const file = r.artifact();
    r.close();
    const plan = planSweep(r.root, NOW);
    expect(plan.contributions).toEqual([]);
    applySweep(plan);
    expect(fs.existsSync(file)).toBe(true);
  });
  it('empty expired artifacts still get a durable nonresumable summary', () => {
    const r = rig();
    r.close();
    applySweep(planSweep(r.root, NOW));
    const store = r.open();
    expect(readContributionSummary(store)?.snapshotExpired).toBe(true);
  });
});

describe('adversarial retention', () => {
  it('rejects an active lifetime guard at planning and apply', () => {
    const r = rig();
    r.artifact();
    expect(() => planSweep(r.root, NOW)).toThrow();
    r.close();
    const plan = planSweep(r.root, NOW);
    const active = r.open();
    expect(() => applySweep(plan)).toThrow();
    active.close();
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid explicit retention %s', (days) => {
    const r = rig();
    r.close();
    expect(() => planSweep(r.root, NOW, days)).toThrow();
  });
  it('rejects invalid time and unknown root entries', () => {
    const r = rig();
    r.close();
    expect(() => planSweep(r.root, 'bad')).toThrow();
    fs.writeFileSync(path.join(r.root, 'untrusted'), 'x');
    expect(() => planSweep(r.root, NOW)).toThrow();
  });
  it.each(['root', 'contribution', 'ancestor', 'leaf'])('rejects %s symlinks', (kind) => {
    const r = rig();
    const file = r.artifact('nested/file');
    r.close();
    if (kind === 'root') {
      fs.symlinkSync(r.root, path.join(r.temp, 'alias'));
      expect(() => planSweep(path.join(r.temp, 'alias'), NOW)).toThrow();
    } else if (kind === 'contribution') {
      fs.renameSync(r.directory, `${r.directory}-moved`);
      fs.symlinkSync(`${r.directory}-moved`, r.directory);
      expect(() => planSweep(r.root, NOW)).toThrow();
    } else {
      const target = kind === 'ancestor' ? path.dirname(file) : file;
      fs.renameSync(target, `${target}-moved`);
      fs.symlinkSync(`${target}-moved`, target);
      expect(() => planSweep(r.root, NOW)).toThrow();
    }
  });
  it.each([
    'clone',
    'traversal',
    'stale',
    'replacement',
    'extra',
    'hardlink',
    'fifo',
  ])('fails closed for %s plans/files', (kind) => {
    const r = rig();
    const file = r.artifact();
    r.close();
    const plan = planSweep(r.root, NOW);
    const before = hashes(r.directory);
    if (kind === 'clone') expect(() => applySweep(structuredClone(plan))).toThrow();
    else if (kind === 'traversal') {
      (plan.contributions[0].files[0] as { path: string }).path = '../run.json';
      expect(() => applySweep(plan)).toThrow();
    } else {
      if (kind === 'stale') fs.utimesSync(file, new Date(NOW), new Date(NOW));
      if (kind === 'replacement') {
        fs.unlinkSync(file);
        fs.writeFileSync(file, 'changed');
      }
      if (kind === 'extra') r.artifact('extra');
      if (kind === 'hardlink') fs.linkSync(file, `${file}-link`);
      if (kind === 'fifo') {
        fs.unlinkSync(file);
        expect(spawnSync('mkfifo', [file]).status).toBe(0);
      }
      expect(() => applySweep(plan)).toThrow();
    }
    expect(hashes(r.directory)).toEqual(before);
    expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
  });
  it('refuses changed protected evidence and missing artifact before expiry', () => {
    const r = rig();
    const file = r.artifact();
    r.close();
    const plan = planSweep(r.root, NOW);
    fs.unlinkSync(file);
    expect(() => applySweep(plan)).toThrow();
    r.artifact();
    r.age();
    const second = planSweep(r.root, NOW);
    r.write('tokens/new.json', { new: true });
    expect(() => applySweep(second)).toThrow();
  });
  it('fails closed when an artifact is swapped for a symlink after expiry', () => {
    const r = rig();
    const file = r.artifact();
    r.close();
    const plan = planSweep(r.root, NOW);
    expect(() =>
      applySweep(plan, (point) => {
        if (point === 'expired') {
          fs.unlinkSync(file);
          fs.symlinkSync(path.join(r.directory, 'run.json'), file);
        }
      })
    ).toThrow();
    expect(fs.existsSync(path.join(r.directory, 'run.json'))).toBe(true);
  });
  it('fails closed for a leaf identity race during atomic isolation', () => {
    const r = rig();
    const file = r.artifact();
    r.close();
    const plan = planSweep(r.root, NOW);
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('/snapshot') && String(to).includes('.zt-retention-')) {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(r.directory, 'run.json'), file);
      }
      original(from, to);
    });
    expect(() => applySweep(plan)).toThrow();
    expect(fs.existsSync(path.join(r.directory, 'run.json'))).toBe(true);
    expect(
      fs
        .readdirSync(path.join(r.directory, '.retention-quarantine'))
        .some((name) => name.startsWith('.zt-retention-'))
    ).toBe(true);
  });
  it('uses the authenticated plan snapshot even when the caller mutates arrays during a fault hook', () => {
    const r = rig();
    const artifact = r.artifact();
    r.write('tokens/protected.json', { preserve: true });
    r.close();
    const plan = planSweep(r.root, NOW);
    const before = hashes(r.directory);
    applySweep(plan, (point) => {
      if (point === 'expired')
        (plan.contributions[0].files[0] as { path: string }).path = 'tokens/protected.json';
    });
    expect(fs.existsSync(artifact)).toBe(false);
    expect(hashes(r.directory)).toEqual(before);
  });
  it('closed stores and replaced contribution directory cannot expose pinned access', () => {
    const r = rig();
    fs.renameSync(r.directory, `${r.directory}-moved`);
    fs.mkdirSync(r.directory, { mode: 0o700 });
    expect(() => r.store.withPinnedDirectory(() => true)).toThrow();
    r.store.close();
    expect(() => r.store.withPinnedDirectory(() => true)).toThrow();
  });
  it('refuses corrupt summary/expiry metadata, rather than granting resume', () => {
    const r = rig();
    expect(() => assertResumable(r.store)).not.toThrow();
    r.write('summary.json', {});
    expect(() => readContributionSummary(r.store)).toThrow();
    expect(() => assertResumable(r.store)).toThrow();
    fs.unlinkSync(path.join(r.directory, 'summary.json'));
    r.write('.snapshot-expired', {});
    expect(() => readContributionSummary(r.store)).toThrow();
    expect(() => assertResumable(r.store)).toThrow();
  });
  it('dry-run maintenance never repairs a torn control tail or unconfirmed snapshot', () => {
    const r = rig();
    r.artifact();
    r.close();
    const journal = path.join(r.directory, 'control/events.jsonl');
    const original = fs.readFileSync(journal);
    fs.appendFileSync(journal, '{torn');
    const before = hashes(r.directory);
    expect(() => planSweep(r.root, NOW)).toThrow();
    expect(hashes(r.directory)).toEqual(before);
    fs.writeFileSync(journal, original);
    const lines = original.toString().trimEnd().split('\n');
    lines.pop();
    fs.writeFileSync(journal, `${lines.join('\n')}\n`);
    const unconfirmed = hashes(r.directory);
    expect(() => planSweep(r.root, NOW)).toThrow();
    expect(hashes(r.directory)).toEqual(unconfirmed);
  });
  it('read-only RunStore denies writes and pending control recovery without mutation', () => {
    const r = rig();
    r.close();
    const store = RunStore.open(r.root, r.runId, { readOnly: true });
    stores.push(store);
    const before = hashes(r.directory);
    expect(() =>
      store.persistRun(transitionRun(store.run, ReasonCode.GatePassed, '2026-01-01T00:00:01.000Z'))
    ).toThrow();
    expect(hashes(r.directory)).toEqual(before);
    store.close();
    r.write('control/events.jsonl.recovery', {});
    const marked = hashes(r.directory);
    expect(() => planSweep(r.root, NOW)).toThrow();
    expect(hashes(r.directory)).toEqual(marked);
  });
  it('live cached state cannot hide corrupt snapshots or changed config digests', () => {
    const r = rig();
    const originalRun = fs.readFileSync(path.join(r.directory, 'run.json'));
    r.write('run.json', {});
    expect(() => exportContribution(r.store, path.join(r.temp, 'bad-run.json'))).toThrow();
    fs.writeFileSync(path.join(r.directory, 'run.json'), originalRun);
    const config = JSON.parse(fs.readFileSync(path.join(r.directory, 'config.json'), 'utf8'));
    config.retentionDays = 90;
    r.write('config.json', config);
    replacePrivate(
      path.join(r.directory, 'config.sha256'),
      Buffer.from(
        createHash('sha256')
          .update(fs.readFileSync(path.join(r.directory, 'config.json')))
          .digest('hex')
      )
    );
    expect(() => exportContribution(r.store, path.join(r.temp, 'bad-config.json'))).toThrow();
  });
});

describe('sanitized contribution export and evidence', () => {
  it('replays actual pending and observed engagement hand-offs without leaking body paths', async () => {
    const r = rig();
    const intent = {
      contributionId: r.store.contributionId,
      target: 'owner/repo#1',
      operationKind: 'engagement_comment' as const,
      candidateSha: null,
    };
    const body = engagementBody(intent, {
      approach: 'Fix the regression.',
      verification: 'Run npm test.',
    });
    let visible = false;
    let at = Date.parse(START);
    const journal = new Journal(r.store.storeDirectory('handoff'));
    try {
      const driver = new HandoffDriver(
        journal,
        {
          bodyDirectory: r.store.storeDirectory('bodies'),
          now: () => {
            at += 1000;
            return new Date(at).toISOString();
          },
          admission: {
            policyFresh: async () => true,
            contributorVerified: async () => true,
            forkBindingVerified: async () => true,
            prBindingVerified: async () => true,
            commitPr: async () => true,
            receiptValid: async () => true,
            remoteBranchSha: async () => SHA,
          },
          read: async () => ({
            status: 200,
            body: visible
              ? [
                  {
                    id: 5,
                    html_url: 'https://github.com/owner/repo/issues/1#issuecomment-5',
                    body,
                    user: { login: 'contributor' },
                  },
                ]
              : [],
          }),
        },
        { run: r.store.run, contributionId: r.store.contributionId }
      );
      await driver.issueEngagement({
        intent,
        binding: { upstream: { owner: 'owner', repo: 'repo' }, issue: 1 },
        body,
      });
      r.store.persistRun(driver.snapshot().run);
      expect(exportContribution(r.store, path.join(r.temp, 'pending.json')).outcome).toBe(
        'unknown'
      );
      visible = true;
      expect((await driver.resume())?.kind).toBe('observed');
      r.store.persistRun(driver.snapshot().run);
      r.artifact();
      r.close();
      applySweep(planSweep(r.root, NOW));
      const store = r.open();
      const bundle = exportContribution(store, path.join(r.temp, 'engagement.json'));
      expect(bundle.summary?.links).toContain(
        'https://github.com/owner/repo/issues/1#issuecomment-5'
      );
      expect(bundle.pr).toBeNull();
      expect(bundle.outcome).toBe('unknown');
      expect(JSON.stringify(bundle)).not.toContain(r.temp);
      journal.close();
      fs.appendFileSync(path.join(r.directory, 'handoff/events.jsonl'), '{');
      new Journal(store.storeDirectory('handoff')).close();
      const protectedBefore = hashes(r.directory);
      expect(() => exportContribution(store, path.join(r.temp, 'recovered-handoff.json'))).toThrow(
        'invalid-evidence'
      );
      store.close();
      expect(() => planSweep(r.root, NOW)).toThrow();
      expect(hashes(r.directory)).toEqual(protectedBefore);
    } finally {
      journal.close();
    }
  });
  it('public runtime validation refuses tampered receipt, verification and summary facts', async () => {
    const r = rig();
    await evidence(r);
    r.close();
    applySweep(planSweep(r.root, NOW));
    const store = r.open();
    const bundle = exportContribution(store, path.join(r.temp, 'valid.json'));
    const badSignature = structuredClone(bundle);
    badSignature.receipts[0].signature.signature = 'AAAA';
    expect(() => validateContributionExport(badSignature)).toThrow();
    const badDigest = structuredClone(bundle);
    badDigest.receipts[0].digest = '0'.repeat(64);
    expect(() => validateContributionExport(badDigest)).toThrow();
    const badVerification = structuredClone(bundle);
    if (badVerification.verification) badVerification.verification[0].verified = false;
    expect(() => validateContributionExport(badVerification)).toThrow();
    const missingReceipt = structuredClone(bundle);
    missingReceipt.receipts = [];
    expect(() => validateContributionExport(missingReceipt)).toThrow();
    const badSummary = structuredClone(bundle);
    if (badSummary.summary) badSummary.summary.runId = 'foreign';
    expect(() => validateContributionExport(badSummary)).toThrow();
  });
  it('rejects forged tracker identity and unconfirmed raw control replay', async () => {
    const r = rig();
    await evidence(r);
    const journal = path.join(r.directory, 'track/events.jsonl');
    const events = fs
      .readFileSync(journal, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    events[0].contributionId = 'foreign';
    fs.writeFileSync(journal, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    expect(() => exportContribution(r.store, path.join(r.temp, 'foreign.json'))).toThrow();
    fs.unlinkSync(journal);
    const control = path.join(r.directory, 'control/events.jsonl');
    const lines = fs.readFileSync(control, 'utf8').trimEnd().split('\n');
    lines.pop();
    fs.writeFileSync(control, `${lines.join('\n')}\n`);
    expect(() => exportContribution(r.store, path.join(r.temp, 'unconfirmed.json'))).toThrow();
  });
  it('unknown is honest without optional evidence; exports never include config/environment/stores', () => {
    const r = rig();
    r.write('tokens/excluded.json', { token: 'ghp_excluded' });
    r.write('nonces/excluded.json', { secret: 'ghp_excluded' });
    const bundle = exportContribution(r.store, path.join(r.temp, 'unknown.json'));
    expect(bundle.outcome).toBe('unknown');
    expect(bundle.status.costTotals).toBeNull();
    expect(bundle.verification).toBeNull();
    expect(bundle.disclosure).toBeNull();
    expect(bundle.policyCitations).toBeNull();
    expect(bundle.summary).toBeNull();
    expect(bundle.receipts).toEqual([]);
    expect(() => validateContributionExport({ ...bundle, unexpected: true })).toThrow();
    expect(() => validateContributionExport({ ...bundle, disclosure: 'ghp_output' })).toThrow();
    expect(() =>
      validateContributionExport({ ...bundle, status: { ...bundle.status, state: 'merged' } })
    ).toThrow();
  });
  it('initialized budget without a session is unknown, not zero', () => {
    const r = rig();
    const ledger = new BudgetLedger(
      path.join(r.directory, 'budget/ledger.json'),
      r.store.contributionId
    );
    ledger.initialize(['fake'], [r.rate]);
    expect(
      exportContribution(r.store, path.join(r.temp, 'budget.json')).status.costTotals
    ).toBeNull();
  });
  it('tracker without outcome has only awaiting_review, never merged', async () => {
    const r = rig();
    await evidence(r, false);
    expect(exportContribution(r.store, path.join(r.temp, 'tracking.json')).outcome).toBe(
      'awaiting_review'
    );
  });
  it.each([
    'receipt-evidence.json',
    'portfolio-evidence.json',
    'budget/ledger.json',
    'track/events.jsonl',
    'control/events.jsonl',
  ])('AC4 scans discarded nested source fields in %s', async (name) => {
    const r = rig();
    await evidence(r);
    const file = path.join(r.directory, name);
    if (name.endsWith('jsonl')) {
      const lines = fs
        .readFileSync(file, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      lines[0].discarded = { nested: 'ghp_planted' };
      fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    } else {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) raw[0].discarded = { nested: 'ghp_planted' };
      else raw.discarded = { nested: 'ghp_planted' };
      r.write(name, raw);
    }
    expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
    expect(fs.existsSync(path.join(r.temp, 'refused.json'))).toBe(false);
  });
  it.each(['run.json', 'config.json'])('scans raw %s before projection', (name) => {
    const r = rig();
    const file = path.join(r.directory, name);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.discarded = 'ghp_planted';
    r.write(name, raw);
    expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
  });
  it.each([
    'receipt-evidence.json',
    'portfolio-evidence.json',
    'budget/ledger.json',
    'track/events.jsonl',
  ])('corrupt %s cannot become zero or success', (name) => {
    const r = rig();
    fs.writeFileSync(path.join(r.directory, name), '{', { mode: 0o600 });
    expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
    r.close();
    expect(() => planSweep(r.root, NOW)).toThrow();
  });
  it.each([
    'signature',
    'digest',
    'identity',
    'shape',
  ])('refuses invalid receipt %s', async (kind) => {
    const r = rig();
    const receipt = await evidence(r);
    if (kind === 'signature') receipt.signature.signature = 'AAAA';
    if (kind === 'digest') receipt.digest = '0'.repeat(64);
    if (kind === 'identity') receipt.receipt.runId = 'foreign-run';
    if (kind === 'shape') receipt.signature.algorithm = 'unsupported';
    r.write('receipt-evidence.json', [receipt]);
    expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
  });
  it('refuses malformed portfolio, tracker, budget and receipt lists', () => {
    const r = rig();
    for (const [name, raw] of [
      ['portfolio-evidence.json', { runId: r.runId, disclosure: 'text', policyCitations: [{}] }],
      ['portfolio-evidence.json', {}],
      ['receipt-evidence.json', {}],
      ['receipt-evidence.json', [{}]],
      ['budget/ledger.json', {}],
    ] as const) {
      r.write(name, raw);
      expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
      fs.unlinkSync(path.join(r.directory, name));
    }
    r.write('track/events.jsonl', {});
    expect(() => exportContribution(r.store, path.join(r.temp, 'refused.json'))).toThrow();
  });
  it('standalone verification scans logs then exports only command metadata', () => {
    const r = rig();
    const log = { ...logArtifact('log text', '', false) };
    const command = {
      id: 'test',
      command: 'npm test',
      required: true,
      status: 'passed',
      exitStatus: 0,
      suites: 2,
      sanitizedLogDigest: log.digest,
    };
    const raw = {
      runId: r.runId,
      candidateSha: SHA,
      records: [
        {
          ...verificationMetadata,
          id: 'test',
          argv: 'npm test',
          status: 'passed',
          exitCode: 0,
          suites: 2,
          log,
          evidence: command,
        },
      ],
    };
    r.write('verification-evidence.json', raw);
    const bundle = exportContribution(r.store, path.join(r.temp, 'verify.json'));
    expect(bundle.verification?.[0]).toMatchObject({
      receiptDigest: null,
      verified: true,
      commands: [command],
    });
    expect(JSON.stringify(bundle)).not.toContain('log text');
    raw.records[0].log.excerpt = 'ghp_log';
    r.write('verification-evidence.json', raw);
    expect(() => exportContribution(r.store, path.join(r.temp, 'secret.json'))).toThrow();
    raw.records[0].log.excerpt = '';
    raw.records[0].log.digest = 'c'.repeat(64);
    r.write('verification-evidence.json', raw);
    expect(() => exportContribution(r.store, path.join(r.temp, 'corrupt.json'))).toThrow();
  });
  it('refuses malformed and inconclusive verification without claiming pass', () => {
    const r = rig();
    const log = { ...logArtifact('', '', false) };
    r.write('verification-evidence.json', {});
    expect(() => exportContribution(r.store, path.join(r.temp, 'bad.json'))).toThrow();
    const evidence = {
      id: 'test',
      command: 'npm test',
      required: true,
      status: 'inconclusive',
      exitStatus: 'unknown',
      suites: 'unknown',
      sanitizedLogDigest: log.digest,
    };
    r.write('verification-evidence.json', {
      runId: r.runId,
      candidateSha: SHA,
      records: [
        {
          ...verificationMetadata,
          id: 'test',
          argv: 'npm test',
          status: 'inconclusive',
          exitCode: null,
          suites: null,
          tests: null,
          failures: null,
          skipped: null,
          log,
          evidence,
        },
      ],
    });
    expect(
      exportContribution(r.store, path.join(r.temp, 'unknown-verify.json')).verification?.[0]
        .verified
    ).toBe(false);
    evidence.status = 'invented';
    r.write('verification-evidence.json', {
      runId: r.runId,
      candidateSha: SHA,
      records: [
        {
          ...verificationMetadata,
          id: 'test',
          argv: 'npm test',
          status: 'invented',
          exitCode: null,
          suites: null,
          log,
          evidence,
        },
      ],
    });
    expect(() => exportContribution(r.store, path.join(r.temp, 'bad-status.json'))).toThrow();
  });
  it('does not overwrite existing output or follow output symlinks/ancestors', () => {
    const r = rig();
    const target = path.join(r.temp, 'existing');
    fs.writeFileSync(target, 'preserve');
    fs.symlinkSync(target, path.join(r.temp, 'link'));
    expect(() => exportContribution(r.store, path.join(r.temp, 'link'))).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    fs.symlinkSync(r.temp, path.join(r.temp, 'alias'));
    expect(() => exportContribution(r.store, path.join(r.temp, 'alias/new'))).toThrow();
  });
  it('corrupt expiry marker, summary facts and traversal cannot be exported or replayed', () => {
    const r = rig();
    r.artifact();
    r.close();
    applySweep(planSweep(r.root, NOW));
    const store = r.open();
    const original = JSON.parse(fs.readFileSync(path.join(r.directory, 'summary.json'), 'utf8'));
    r.write('.snapshot-expired', {
      runId: r.runId,
      snapshotExpired: true,
      summaryDigest: '0'.repeat(64),
    });
    expect(() => exportContribution(store, path.join(r.temp, 'bad.json'))).toThrow();
    fs.unlinkSync(path.join(r.directory, '.snapshot-expired'));
    r.write('summary.json', { ...original, facts: { ...original.facts, outcome: 'merged' } });
    expect(() => exportContribution(store, path.join(r.temp, 'bad.json'))).toThrow();
    original.sweep.files[0].path = 'artifacts/../run.json';
    r.write('summary.json', original);
    expect(() => readContributionSummary(store)).toThrow();
  });
  it('pins relative paths and refuses corrupt/raw unreadable selected records', () => {
    const r = rig();
    expect(() => inDirectory(r.directory, '../tokens', () => true)).toThrow();
    expect(() => jsonRecord(Buffer.from([0xff]))).toThrow();
    expect(() => jsonRecord(Buffer.alloc(1024 * 1024 + 1))).toThrow();
    expect(optionalBytes(r.directory, 'missing.json')).toBeNull();
    r.write('portfolio-evidence.json', {});
    fs.chmodSync(path.join(r.directory, 'portfolio-evidence.json'), 0o644);
    expect(() =>
      r.store.withPinnedDirectory((root) => contributionEvidence(r.store, root))
    ).toThrow();
  });
  it('scans overwritten duplicate JSON fields and escaped strings in the raw source', () => {
    const r = rig();
    for (const secret of ['ghp_hidden', 'gh\\u0070_hidden']) {
      replacePrivate(
        path.join(r.directory, 'portfolio-evidence.json'),
        Buffer.from(
          `{"runId":"${r.runId}","disclosure":"${secret}","disclosure":"safe","policyCitations":[]}`
        )
      );
      expect(() => exportContribution(r.store, path.join(r.temp, 'duplicate.json'))).toThrow();
    }
    expect(fs.existsSync(path.join(r.temp, 'duplicate.json'))).toBe(false);
  });
  it('malformed selected JSON never echoes a planted credential in an error', () => {
    const r = rig();
    for (const name of ['portfolio-evidence.json', 'run.json', 'summary.json']) {
      const file = path.join(r.directory, name);
      const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
      replacePrivate(file, Buffer.from('{"secret":ghp_planted}'));
      let failure: unknown;
      try {
        exportContribution(r.store, path.join(r.temp, 'bad.json'));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('ghp_planted');
      if (original) replacePrivate(file, original);
      else fs.unlinkSync(file);
    }
  });
  it('does not recreate a missing permanent lifetime guard during dry-run', () => {
    const r = rig();
    r.close();
    fs.unlinkSync(path.join(r.directory, '.controller.guard'));
    const before = hashes(r.directory);
    expect(() => planSweep(r.root, NOW)).toThrow();
    expect(hashes(r.directory)).toEqual(before);
  });
});
