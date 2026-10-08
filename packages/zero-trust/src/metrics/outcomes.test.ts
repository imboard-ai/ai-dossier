import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import { validateRunConfig } from '../controller/config';
import { RunStore } from '../controller/run-store';
import { replacePrivate } from '../durable-fs';
import { handoffMarker } from '../github/handoff';
import { Journal } from '../journal';
import { ReasonCode, transitionRun } from '../state';
import {
  ADOPTION_MAX_LENGTH,
  aggregate,
  contributionOutcome,
  MetricsError,
  recordAdoption,
  renderMetricsHuman,
  renderMetricsJson,
} from './outcomes';

const START = '2026-10-05T00:00:00.000Z';
const dirs: string[] = [];
const stores: RunStore[] = [];
function rig(currency = 'USD', contributor = 'contributor') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-metrics-'));
  dirs.push(root);
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const rate: BudgetRate = {
    resource: 'fake',
    currency,
    unit: 'token',
    price: 1,
    units: 1,
    source: 'fixture',
    fx: { currency, numerator: 1, denominator: 1, timestamp: START },
  };
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const store = RunStore.create(
    path.join(root, 'stores'),
    validateRunConfig({
      issueUrl: 'https://github.com/owner/repo/issues/1',
      contributor,
      executionProfile: {
        provider: 'local-qemu',
        profileDir: 'profile',
        stateDir: 'state',
        accelerator: 'auto',
        proxyEndpointsFile: 'endpoints.json',
      },
      modelProfile: { phases: { planning: phase, implementing: phase }, rates: [rate] },
      budget: {
        currency,
        ceilingMinor: 1000,
        cleanupAllowanceMinor: 10,
        tokenLimit: 1000,
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
    }),
    START
  );
  stores.push(store);
  let clock = Date.parse(START);
  const step = (reason: ReasonCode, ms = 1000) => {
    clock += ms;
    store.persistRun(transitionRun(store.run, reason, new Date(clock).toISOString()));
    return store.run;
  };
  const shipping = () => {
    for (const r of [
      ReasonCode.GatePassed,
      ReasonCode.PlanApproved,
      ReasonCode.CandidateReady,
      ReasonCode.VerificationPassed,
    ])
      step(r);
  };
  const handoff = new Journal(store.storeDirectory('handoff'));
  handoff.append({
    v: 1,
    type: 'handoff_run',
    run: store.run,
    contributionId: store.contributionId,
  });
  handoff.close();
  const ledger = new BudgetLedger(
    path.join(store.storeDirectory('budget'), 'ledger.json'),
    store.contributionId
  );
  ledger.initialize(['fake'], [rate]);
  ledger.startSession({
    id: store.budgetSessionId(1),
    ceiling: { currency, minor: 1000 },
    cleanupAllowance: 10,
    tokenLimit: 1000,
    timeLimitMs: 120000,
  });
  const spend = (minor = 10, observed: number | null = 8, rates = [rate]) => {
    const row = ledger.reserve(store.budgetSessionId(1), {
      money: { currency, minor },
      tokens: 1,
      timeMs: 1,
      rates,
    });
    ledger.settle(
      row.id,
      observed === null
        ? null
        : { money: { currency, minor: observed }, tokens: 1, timeMs: 1, source: 'fixture-provider' }
    );
    return row;
  };
  const track = () => {
    const journal = new Journal(store.storeDirectory('track'));
    const sha = 'a'.repeat(40);
    const pr = {
      binding: {
        upstream: { owner: 'owner', repo: 'repo' },
        base: 'main',
        headOwner: contributor,
        branch: 'fix',
      },
      fork: { repositoryId: 2, owner: contributor, repo: 'repo' },
      number: 5,
      url: 'https://github.com/owner/repo/pull/5',
      marker: handoffMarker({
        contributionId: store.contributionId,
        operationKind: 'pr_create',
        target: 'owner/repo#1',
        candidateSha: sha,
      }),
    };
    journal.append({
      v: 1,
      type: 'track',
      run: store.run,
      contributionId: store.contributionId,
      pr,
      verifiedSha: sha,
    });
    journal.close();
    const event = (value: Record<string, unknown>) => {
      const j = new Journal(store.storeDirectory('track'));
      j.append({ v: 1, ...value });
      j.close();
    };
    return { event, sha };
  };
  return { store, step, shipping, ledger, spend, rate, track };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('local contribution outcomes', () => {
  it('derives six real-store outcomes and cohort rates without conflating submission and acceptance', () => {
    const ineligible = rig();
    ineligible.step(ReasonCode.PolicyBlocked);
    const handoff = rig();
    handoff.step(ReasonCode.PermissionRequired);
    const open = rig();
    open.shipping();
    open.step(ReasonCode.PublicationObserved);
    open.track();
    open.spend();
    const merged = rig();
    merged.shipping();
    merged.step(ReasonCode.PublicationObserved);
    const mt = merged.track();
    mt.event({
      type: 'outcome',
      outcome: 'merged',
      headSha: mt.sha,
      run: merged.step(ReasonCode.ObservedUpstreamMerge),
    });
    merged.spend(20, 22);
    const declined = rig();
    declined.shipping();
    declined.step(ReasonCode.PublicationObserved);
    const dt = declined.track();
    dt.event({
      type: 'outcome',
      outcome: 'declined',
      headSha: dt.sha,
      run: declined.step(ReasonCode.UpstreamDeclined),
    });
    const revised = rig();
    revised.shipping();
    revised.step(ReasonCode.PublicationObserved);
    const rt = revised.track();
    rt.event({
      type: 'revision_started',
      feedback: [{ id: 'review:1', updatedAt: START }],
      run: revised.step(ReasonCode.RevisionRequested),
    });
    const outcomes = [ineligible, handoff, open, merged, declined, revised].map((r) =>
      contributionOutcome(r.store)
    );
    expect(outcomes.map((o) => [o.gated, o.submitted, o.outcome, o.revisions])).toEqual([
      ['ineligible', false, 'none', 0],
      ['hand_off', false, 'none', 0],
      ['eligible', true, 'open', 0],
      ['eligible', true, 'merged', 0],
      ['eligible', true, 'declined', 0],
      ['eligible', true, 'open', 1],
    ]);
    expect(outcomes[2]?.prUrl).toBe('https://github.com/owner/repo/pull/5');
    const stats = aggregate(outcomes);
    expect(stats.eligibleToSubmitted).toEqual({
      numerator: 4,
      denominator: 4,
      unknown: 0,
      value: 1,
    });
    for (const key of ['accepted', 'merged', 'declined', 'reworkPerSubmitted'] as const)
      expect(stats[key]).toEqual({ numerator: 1, denominator: 4, unknown: 0, value: 0.25 });
    expect(stats.repeatUsage).toEqual({ contributor: 6 });
    expect(stats.costPerSubmitted).toMatchObject({
      USD: { estimatedMinor: 7.5, observedMinor: 7.5 },
    });
    expect(stats.costPerAccepted).toMatchObject({ USD: { estimatedMinor: 20, observedMinor: 22 } });
    expect(stats.medianActiveMs).toBe(5000);
  });

  it('keeps USD and EUR estimates, observations and components separate in all outputs', () => {
    const a = rig('USD');
    a.shipping();
    a.step(ReasonCode.PublicationObserved);
    a.track();
    a.spend(12, 9);
    const b = rig('EUR', 'Contributor');
    b.shipping();
    b.step(ReasonCode.PublicationObserved);
    b.track();
    b.spend(40, 45, [{ ...b.rate, resource: 'vm', unit: 'vm_increment' }]);
    const stats = aggregate([contributionOutcome(a.store), contributionOutcome(b.store)]);
    expect(stats.costPerSubmitted).toEqual({
      USD: {
        estimatedMinor: 6,
        observedMinor: 4.5,
        model: { estimatedMinor: 6, observedMinor: 4.5 },
        vm: { estimatedMinor: 0, observedMinor: 0 },
      },
      EUR: {
        estimatedMinor: 20,
        observedMinor: 22.5,
        model: { estimatedMinor: 0, observedMinor: 0 },
        vm: { estimatedMinor: 20, observedMinor: 22.5 },
      },
    });
    expect(stats.repeatUsage).toEqual({ contributor: 2 });
    const json = JSON.parse(renderMetricsJson(stats));
    const human = Object.fromEntries(
      renderMetricsHuman(stats)
        .split('\n')
        .map((line) => {
          const i = line.indexOf(': ');
          return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
        })
    );
    expect(human).toEqual(json);
    expect(Object.keys(json.costPerSubmitted)).toEqual(['USD', 'EUR']);
  });

  it('excludes long maintainer, contributor, paused and review waits from active time', () => {
    const r = rig();
    r.step(ReasonCode.PermissionRequired);
    r.step(ReasonCode.MaintainerInvited, 30 * 86400000);
    r.step(ReasonCode.ForkMissing);
    r.step(ReasonCode.ResumeGating, 60000);
    r.step(ReasonCode.GatePassed);
    r.step(ReasonCode.UserPaused);
    r.step(ReasonCode.ResumePlanning, 120000);
    r.step(ReasonCode.PlanApproved);
    r.step(ReasonCode.CandidateReady);
    r.step(ReasonCode.VerificationPassed);
    r.step(ReasonCode.PublicationObserved);
    r.track();
    r.step(ReasonCode.ReviewAwaited, 180000);
    const result = contributionOutcome(
      r.store,
      new Date(Date.parse(r.store.run.updatedAt) + 10000)
    );
    expect(result.activeMs).toBe(8000);
    expect(result.waitMs).toEqual({
      maintainer: 30 * 86400000,
      contributor: 60000,
      paused: 120000,
      review: 190000,
    });
    expect(contributionOutcome(r.store, 'invalid').activeMs).toBe('unknown');
    expect(contributionOutcome(r.store, START).waitMs).toBe('unknown');
  });

  it.each([
    'missing',
    'corrupt',
    'truncated',
    'foreign',
  ] as const)('keeps %s tracker evidence unknown and never manufactures a merge', (kind) => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.track();
    const file = path.join(r.store.storeDirectory('track'), 'events.jsonl');
    if (kind === 'missing') fs.unlinkSync(file);
    else if (kind === 'foreign') {
      const text = fs
        .readFileSync(file, 'utf8')
        .replaceAll(r.store.contributionId, 'ztc-0000000000000000');
      replacePrivate(file, Buffer.from(text));
    } else replacePrivate(file, Buffer.from(kind === 'corrupt' ? '{}\n' : '{'));
    r.step(ReasonCode.ObservedUpstreamMerge);
    const o = contributionOutcome(r.store);
    expect(o).toMatchObject({
      submitted: true,
      outcome: 'unknown',
      revisions: 'unknown',
      prUrl: 'unknown',
    });
    expect(aggregate([o])).toMatchObject({
      merged: { numerator: 0, denominator: 1, unknown: 1, value: 'unknown' },
      costPerAccepted: 'unknown',
    });
    if (kind === 'missing') expect(fs.existsSync(file)).toBe(false);
    if (kind === 'truncated') expect(fs.readFileSync(file, 'utf8')).toBe('{');
  });

  it('does not turn missing/corrupt budget or unavailable run/config into zeros', () => {
    const r = rig();
    const file = r.ledger.file;
    fs.unlinkSync(file);
    expect(contributionOutcome(r.store).cost.byCurrency).toBe('unknown');
    replacePrivate(file, Buffer.from('{}'));
    expect(contributionOutcome(r.store).cost.byCurrency).toBe('unknown');
    vi.spyOn(r.store, 'config', 'get').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(contributionOutcome(r.store).submitted).toBe('unknown');
    r.store.close();
    const result = contributionOutcome(r.store);
    expect(result).toMatchObject({
      contributor: 'unknown',
      activeMs: 'unknown',
      waitMs: 'unknown',
    });
    expect(aggregate([result])).toMatchObject({
      eligibleToSubmitted: { value: 'unknown' },
      costPerSubmitted: 'unknown',
      unknownContributors: 1,
    });
  });

  it('preserves unknown observation and mixed allocation while ignoring released reservations', () => {
    const r = rig();
    const released = r.ledger.reserve(r.store.budgetSessionId(1), {
      money: { currency: 'USD', minor: 50 },
      tokens: 1,
      timeMs: 1,
      rates: [r.rate],
    });
    r.ledger.release(released.id, 'not-executed');
    r.spend(20, null, [r.rate, { ...r.rate, resource: 'vm', unit: 'vm_increment' }]);
    const o = contributionOutcome(r.store);
    expect(o.cost.byCurrency).toEqual({
      USD: {
        estimatedMinor: 20,
        observedMinor: 'unknown',
        model: { estimatedMinor: 'unknown', observedMinor: 'unknown' },
        vm: { estimatedMinor: 'unknown', observedMinor: 'unknown' },
      },
    });
  });

  it('records only voluntary bounded secret-free adoption atomically and quotes human values', () => {
    const r = rig();
    expect(contributionOutcome(r.store).adoptionReported).toBeUndefined();
    recordAdoption(r.store, 'Adopted\nvoluntarily', new Date(START));
    expect(contributionOutcome(r.store).adoptionReported).toEqual({
      at: START,
      note: 'Adopted\nvoluntarily',
    });
    const file = path.join(r.store.storeDirectory('artifacts'), 'adoption.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    for (const note of ['', ' ', 'x'.repeat(ADOPTION_MAX_LENGTH + 1), 'ghp_private'])
      expect(() => recordAdoption(r.store, note, START)).toThrow();
    expect(() => recordAdoption(r.store, 'valid', 'invalid')).toThrow(MetricsError);
    expect(fs.readFileSync(file, 'utf8')).toContain('voluntarily');
    const o = contributionOutcome(r.store);
    expect(renderMetricsHuman(o)).toContain('Adopted\\nvoluntarily');
    expect(JSON.parse(renderMetricsJson(o)).adoptionReported).toEqual(o.adoptionReported);
    replacePrivate(file, Buffer.from('{}'));
    expect(contributionOutcome(r.store).adoptionReported).toBe('unknown');
  });

  it('handles accepted and empty cohorts, unknowns, duplicate contributions and secret-shaped output', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.step(ReasonCode.UpstreamAccepted);
    r.track();
    const o = contributionOutcome(r.store);
    expect(o.outcome).toBe('accepted');
    expect(aggregate([o]).accepted.value).toBe(1);
    expect(aggregate([])).toMatchObject({
      contributions: 0,
      medianActiveMs: 'unknown',
      merged: { numerator: 0, denominator: 0, value: 'unknown' },
    });
    expect(() => aggregate([o, o])).toThrow(MetricsError);
    expect(aggregate([{ ...o, activeMs: 'unknown', revisions: 'unknown' }])).toMatchObject({
      medianActiveMs: 'unknown',
      reworkPerSubmitted: { value: 'unknown' },
    });
    expect(() => renderMetricsJson({ ...o, contributor: 'ghp_private' })).toThrow();
  });

  it('imports no github/model module and executes reporting with network operations forbidden', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'outcomes.ts'), 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:github|model)\//u);
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.track();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('forbidden network');
    });
    const o = contributionOutcome(r.store);
    aggregate([o]);
    renderMetricsHuman(o);
    renderMetricsJson(o);
    expect(fetch).not.toHaveBeenCalled();
  });
});
