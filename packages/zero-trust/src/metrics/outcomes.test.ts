import { createHash, generateKeyPairSync } from 'node:crypto';
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
import { withStoreLock } from '../lock';
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
  it('snapshots outer cohorts and renderer discrimination without invoking accessors or echoing traps', () => {
    let invoked = 0;
    const cohort = Object.defineProperty([], '0', {
      enumerable: true,
      get() {
        invoked++;
        throw new Error('ghp_demo');
      },
    });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('ghp_demo');
        },
      }
    );
    for (const call of [
      () => aggregate(cohort),
      () => renderMetricsJson(proxy as never),
      () => renderMetricsHuman(proxy as never),
    ]) {
      expect(call).toThrow(MetricsError);
      try {
        call();
      } catch (error) {
        expect((error as Error).message).toBe('Invalid local outcome metrics');
      }
    }
    expect(invoked).toBe(0);
  });
  it('rejects lossy arrays but normalizes only recognized absent optional fields', () => {
    const o = contributionOutcome(rig().store);
    for (const evidence of [Array(2), Object.assign([], { extra: 'discarded' })]) {
      const input = { ...o, unknownEvidence: evidence };
      expect(() => aggregate([input])).toThrow(MetricsError);
      expect(() => renderMetricsJson(input)).toThrow(MetricsError);
      expect(() => renderMetricsHuman(input)).toThrow(MetricsError);
    }
    expect(renderMetricsJson({ ...o, prUrl: undefined, adoptionReported: undefined })).toBe(
      renderMetricsJson(o)
    );
    expect(aggregate([{ ...o, prUrl: undefined }])).toEqual(aggregate([o]));
  });
  it('rejects contradictory known costs and cohort membership, preserving fractional averages', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.track();
    r.spend(1, 1);
    const o = contributionOutcome(r.store);
    const contradictory = {
      estimatedMinor: 1,
      observedMinor: 1,
      model: { estimatedMinor: 9, observedMinor: 9 },
      vm: { estimatedMinor: 9, observedMinor: 9 },
    };
    expect(() => aggregate([{ ...o, cost: { byCurrency: { USD: contradictory } } }])).toThrow(
      MetricsError
    );
    const stats = aggregate([o]);
    const emptyRate = { numerator: 0, denominator: 0, unknown: 0, value: 'unknown' as const };
    const overlap = { numerator: 1, denominator: 1, unknown: 1, value: 'unknown' as const };
    for (const value of [
      { ...stats, accepted: overlap, merged: overlap, declined: { ...overlap, numerator: 0 } },
      {
        ...stats,
        accepted: emptyRate,
        merged: emptyRate,
        declined: emptyRate,
        reworkPerSubmitted: emptyRate,
      },
      { ...stats, costPerSubmitted: { USD: contradictory } },
    ])
      for (const render of [renderMetricsJson, renderMetricsHuman])
        expect(() => render(value)).toThrow(MetricsError);
    const currency = {
      estimatedMinor: 0.3,
      observedMinor: 0.3,
      model: { estimatedMinor: 0.1, observedMinor: 0.1 },
      vm: { estimatedMinor: 0.2, observedMinor: 0.2 },
    };
    expect(() =>
      renderMetricsJson({ ...stats, costPerSubmitted: { USD: currency } })
    ).not.toThrow();
  });
  it('reads config evidence once without requiring a retired signer and diagnoses missing evidence', () => {
    const r = rig();
    fs.unlinkSync(r.store.config.signerKeyFile);
    const original = fs.openSync;
    const reads: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (typeof file === 'string') reads.push(file);
      return original(file, flags, mode);
    });
    expect(contributionOutcome(r.store).identity).toBe('known');
    expect(reads.filter((file) => file.endsWith('/config.json'))).toHaveLength(1);
    expect(reads.filter((file) => file.endsWith('/config.sha256'))).toHaveLength(1);
    fs.unlinkSync(path.join(r.store.directory, 'config.json'));
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'config',
      reason: 'missing',
    });
    const second = rig();
    fs.unlinkSync(path.join(second.store.directory, 'control/events.jsonl'));
    expect(contributionOutcome(second.store).unknownEvidence).toContainEqual({
      source: 'run',
      reason: 'missing',
    });
  });
  it('refuses reporting an unsettled budget publication after directory fsync uncertainty', () => {
    const r = rig();
    const row = r.ledger.reserve(r.store.budgetSessionId(1), {
      money: { currency: 'USD', minor: 10 },
      tokens: 1,
      timeMs: 1,
      rates: [r.rate],
    });
    const original = fs.fsyncSync;
    const rename = fs.renameSync;
    let renamed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      const result = rename(a, b);
      if (b === r.ledger.file) renamed = true;
      return result;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (renamed && fs.fstatSync(fd).isDirectory()) throw new Error('injected');
      return original(fd);
    });
    expect(() =>
      r.ledger.settle(row.id, {
        money: { currency: 'USD', minor: 8 },
        tokens: 1,
        timeMs: 1,
        source: 'fixture',
      })
    ).toThrow();
    vi.restoreAllMocks();
    expect(renamed).toBe(true);
    expect(contributionOutcome(r.store)).toMatchObject({
      cost: { byCurrency: 'unknown' },
      unknownEvidence: expect.arrayContaining([{ source: 'budget', reason: 'incomplete' }]),
    });
  });
  it('refuses concurrent budget publication without reclaiming or writing evidence', () => {
    const r = rig();
    withStoreLock(
      `${r.ledger.file}.lock`,
      0,
      () => {
        throw new Error('unexpected reclaim');
      },
      () => {
        const write = vi.spyOn(fs, 'writeSync');
        const rename = vi.spyOn(fs, 'renameSync');
        expect(contributionOutcome(r.store).cost.byCurrency).toBe('unknown');
        expect(write).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      }
    );
    expect(contributionOutcome(r.store).cost.byCurrency).not.toBe('unknown');
  });
  it.each([
    'deleted',
    'corrupt',
    'invalid-byte',
    'digest-deleted',
    'digest-corrupt',
    'changed',
  ])('refuses cached success when current config evidence is %s', (mode) => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    const t = r.track();
    t.event({
      type: 'outcome',
      outcome: 'merged',
      headSha: t.sha,
      run: r.step(ReasonCode.ObservedUpstreamMerge),
    });
    expect(contributionOutcome(r.store).outcome).toBe('merged');
    const file = path.join(r.store.directory, 'config.json');
    const digest = path.join(r.store.directory, 'config.sha256');
    if (mode === 'deleted') fs.unlinkSync(file);
    else if (mode === 'digest-deleted') fs.unlinkSync(digest);
    else if (mode === 'digest-corrupt') fs.writeFileSync(digest, '0'.repeat(64));
    else if (mode === 'corrupt') fs.writeFileSync(file, '{');
    else {
      let bytes = fs.readFileSync(file);
      if (mode === 'invalid-byte') bytes[bytes.indexOf(Buffer.from('fixture'))] = 0xff;
      else {
        const config = JSON.parse(bytes.toString());
        config.budget.ceilingMinor += 1;
        bytes = Buffer.from(JSON.stringify(config));
      }
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(digest, createHash('sha256').update(bytes).digest('hex'));
    }
    const outcome = contributionOutcome(r.store);
    expect(outcome).toMatchObject({
      identity: 'unknown',
      submitted: 'unknown',
      outcome: 'unknown',
      cost: { byCurrency: 'unknown' },
    });
    expect(outcome.unknownEvidence.length).toBeGreaterThan(0);
    expect(aggregate([outcome]).merged.value).toBe('unknown');
  });

  it('contains snapshot exceptions and refuses original class dictionaries', () => {
    const o = contributionOutcome(rig().store);
    const stats = aggregate([o]);
    class Dictionary {}
    for (const value of [
      { ...o, cost: { byCurrency: new Dictionary() } },
      { ...stats, repeatUsage: new Dictionary() },
      { ...o, activeMs: () => 'ghp_demo' },
      { ...stats, medianActiveMs: () => 'ghp_demo' },
      Object.defineProperty({ ...o }, 'activeMs', {
        get() {
          throw new Error('ghp_demo');
        },
      }),
      Object.defineProperty({ ...stats }, 'medianActiveMs', {
        get() {
          throw new Error('ghp_demo');
        },
      }),
    ]) {
      for (const render of [renderMetricsJson, renderMetricsHuman]) {
        let error: unknown;
        try {
          render(value as never);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(MetricsError);
        expect((error as Error).message).toBe('Invalid local outcome metrics');
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it('refuses contradictory contribution and cohort facts while permitting rework above one', () => {
    const o = contributionOutcome(rig().store);
    expect(() => aggregate([{ ...o, submitted: false, outcome: 'merged' }])).toThrow(MetricsError);
    expect(() => aggregate([{ ...o, submitted: true, outcome: 'none' }])).toThrow(MetricsError);
    const stats = aggregate([o]);
    for (const patch of [
      { contributions: 0 },
      { unknownContributors: 2 },
      { repeatUsage: { contributor: 2 } },
      { merged: { numerator: 1, denominator: 1, value: 1, unknown: 0 } },
      { eligibleToSubmitted: { numerator: 0, denominator: 2, value: 0, unknown: 0 } },
    ])
      expect(() => renderMetricsJson({ ...stats, ...patch })).toThrow(MetricsError);
    const submitted = {
      ...o,
      gated: 'eligible' as const,
      submitted: true,
      outcome: 'open' as const,
      revisions: 3,
    };
    expect(() => renderMetricsJson(aggregate([submitted]))).not.toThrow();
  });

  it('latches uncertain adoption publication after rename and directory fsync failure', () => {
    const r = rig();
    const original = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('injected EIO');
      return original(fd);
    });
    expect(() => recordAdoption(r.store, 'first', START)).toThrow();
    vi.restoreAllMocks();
    expect(contributionOutcome(r.store).outcome).toBe('unknown');
    expect(() => recordAdoption(r.store, 'second', START)).toThrow();
    expect(
      JSON.parse(fs.readFileSync(path.join(r.store.directory, 'artifacts/adoption.json'), 'utf8'))
        .note
    ).toBe('first');
  });

  it.each([
    'deleted',
    'truncated',
    'corrupt',
    'complete-prefix',
  ])('refuses cached success after control evidence is %s', (mode) => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    const t = r.track();
    t.event({
      type: 'outcome',
      outcome: 'merged',
      headSha: t.sha,
      run: r.step(ReasonCode.ObservedUpstreamMerge),
    });
    expect(contributionOutcome(r.store).outcome).toBe('merged');
    const file = path.join(r.store.storeDirectory('control'), 'events.jsonl');
    const bytes = fs.readFileSync(file);
    if (mode === 'deleted') fs.unlinkSync(file);
    else if (mode === 'corrupt') fs.writeFileSync(file, '{');
    else if (mode === 'truncated') fs.writeFileSync(file, bytes.subarray(0, -3));
    else fs.writeFileSync(file, bytes.subarray(0, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1));
    const outcome = contributionOutcome(r.store);
    expect(outcome.outcome).toBe('unknown');
    expect(outcome.activeMs).toBe('unknown');
    expect(outcome.unknownEvidence).toContainEqual(expect.objectContaining({ source: 'run' }));
    expect(aggregate([outcome]).merged.value).toBe('unknown');
  });

  it('refuses invalid UTF-8 inside an otherwise valid budget JSON string', () => {
    const r = rig();
    r.spend();
    const file = path.join(r.store.storeDirectory('budget'), 'ledger.json');
    const bytes = fs.readFileSync(file);
    bytes[bytes.indexOf(Buffer.from('fixture-provider'))] = 0xff;
    fs.writeFileSync(file, bytes);
    expect(contributionOutcome(r.store).cost.byCurrency).toBe('unknown');
  });

  it('refuses invalid UTF-8 inside an otherwise valid adoption JSON string', () => {
    const r = rig();
    recordAdoption(r.store, 'voluntary note', START);
    const file = path.join(r.store.storeDirectory('artifacts'), 'adoption.json');
    const bytes = fs.readFileSync(file);
    bytes[bytes.indexOf(Buffer.from('voluntary'))] = 0xff;
    fs.writeFileSync(file, bytes);
    expect(contributionOutcome(r.store).adoptionReported).toBe('unknown');
  });

  it('keeps budget descriptor authority across a path-replacement race', () => {
    const r = rig();
    r.spend(10, 8);
    const directory = r.store.storeDirectory('budget');
    const moved = `${directory}-original`;
    const original = fs.realpathSync;
    const value = r.ledger.snapshot();
    let replaced = false;
    const swap = () => {
      if (replaced) return;
      replaced = true;
      fs.renameSync(directory, moved);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(
        path.join(directory, 'ledger.json'),
        JSON.stringify({ ...value, reservations: [] }),
        { mode: 0o600 }
      );
    };
    vi.spyOn(fs, 'realpathSync').mockImplementation((input, options) => {
      const resolved = original(input, options);
      if (
        typeof input === 'string' &&
        input.startsWith('/proc/self/fd/') &&
        resolved === directory
      ) {
        swap();
      }
      return resolved;
    });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((input, flags, mode) => {
      if (typeof input === 'string' && /^\/proc\/self\/fd\/\d+\/ledger\.json$/.test(input)) swap();
      return open(input, flags, mode);
    });
    expect(contributionOutcome(r.store).cost.byCurrency).toMatchObject({
      USD: { estimatedMinor: 10, observedMinor: 8 },
    });
    expect(replaced).toBe(true);
  });

  it('keeps unreadable artifact directories unknown and preserves budget identity diagnostics', () => {
    const r = rig();
    fs.rmdirSync(r.store.storeDirectory('artifacts'));
    expect(contributionOutcome(r.store)).toMatchObject({
      adoptionReported: 'unknown',
      unknownEvidence: expect.arrayContaining([{ source: 'adoption', reason: 'missing' }]),
    });
    const file = path.join(r.store.storeDirectory('budget'), 'ledger.json');
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    ledger.contributionId = 'ztc-0000000000000000';
    fs.writeFileSync(file, JSON.stringify(ledger));
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'budget',
      reason: 'identity_mismatch',
    });
  });

  it('refuses noncanonical contributors, opaque dictionaries and inconsistent rate facts', () => {
    const o = contributionOutcome(rig().store);
    for (const contributor of ['not a login', 'a--b', 'a'.repeat(40)])
      expect(() => aggregate([{ ...o, contributor }])).toThrow(MetricsError);
    for (const byCurrency of [new Date(), new Map(), []])
      expect(() => aggregate([{ ...o, cost: { byCurrency } }] as never)).toThrow(MetricsError);
    const stats = aggregate([o]);
    expect(() =>
      renderMetricsJson({
        ...stats,
        merged: { numerator: 1, denominator: 1, unknown: 0, value: 0 },
      })
    ).toThrow(MetricsError);
    expect(() => renderMetricsJson({ ...stats, repeatUsage: new Map() } as never)).toThrow(
      MetricsError
    );
  });

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
    vi.spyOn(r.store, 'validateConfigEvidence').mockImplementation(() => {
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

  it('refuses a complete-line tracker prefix missing a durable revision instead of counting zero', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    const t = r.track();
    t.event({
      type: 'revision_started',
      feedback: [{ id: 'review:1', updatedAt: START }],
      run: r.step(ReasonCode.RevisionRequested),
    });
    expect(contributionOutcome(r.store).revisions).toBe(1);
    const file = path.join(r.store.storeDirectory('track'), 'events.jsonl');
    const first = fs.readFileSync(file, 'utf8').split('\n')[0];
    replacePrivate(file, Buffer.from(`${first}\n`));
    const o = contributionOutcome(r.store);
    expect(o.revisions).toBe('unknown');
    expect(o.unknownEvidence).toContainEqual({ source: 'track', reason: 'incomplete' });
    expect(aggregate([o]).reworkPerSubmitted).toEqual({
      numerator: 0,
      denominator: 1,
      unknown: 1,
      value: 'unknown',
    });
  });

  it('rejects invalid UTF-8 even inside otherwise ignored journal properties', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.track();
    const file = path.join(r.store.storeDirectory('track'), 'events.jsonl');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.ignored = 'PLACEHOLDER';
    const text = JSON.stringify(raw);
    const i = text.indexOf('PLACEHOLDER');
    replacePrivate(
      file,
      Buffer.concat([
        Buffer.from(text.slice(0, i)),
        Buffer.from([0xff]),
        Buffer.from(`${text.slice(i + 11)}\n`),
      ])
    );
    expect(contributionOutcome(r.store)).toMatchObject({
      outcome: 'unknown',
      revisions: 'unknown',
      unknownEvidence: [{ source: 'track', reason: 'corrupt' }],
    });
  });

  it('preserves an open outcome through revision verification repair with legitimate external lag', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    const t = r.track();
    t.event({
      type: 'revision_started',
      feedback: [{ id: 'review:1', updatedAt: START }],
      run: r.step(ReasonCode.RevisionRequested),
    });
    r.step(ReasonCode.CandidateReady);
    r.step(ReasonCode.RepairRequired);
    expect(contributionOutcome(r.store)).toMatchObject({ outcome: 'open', revisions: 1 });
    expect(aggregate([contributionOutcome(r.store)]).accepted.value).toBe(0);
  });

  it('counts the valid unknown login case-insensitively while retaining unavailable identity', () => {
    const a = rig('USD', 'unknown');
    const b = rig('USD', 'Unknown');
    const c = rig();
    c.store.close();
    const stats = aggregate([
      contributionOutcome(a.store),
      contributionOutcome(b.store),
      contributionOutcome(c.store),
    ]);
    expect(stats.repeatUsage).toEqual({ unknown: 2 });
    expect(stats.unknownContributors).toBe(1);
  });

  it('refuses malformed public facts and extra newline property names in either renderer', () => {
    const o = contributionOutcome(rig().store);
    const injected = { ...o, 'extra\noutcome': 'merged' };
    expect(() => renderMetricsHuman(injected)).toThrow(MetricsError);
    expect(() => renderMetricsJson(injected)).toThrow(MetricsError);
    for (const activeMs of [NaN, Infinity, -1])
      expect(() => aggregate([{ ...o, activeMs }])).toThrow(MetricsError);
    expect(() => renderMetricsJson({ ...aggregate([o]), medianActiveMs: NaN })).toThrow(
      MetricsError
    );
    expect(() =>
      renderMetricsHuman({ ...o, cost: { byCurrency: { BADKEY: {} } } } as never)
    ).toThrow(MetricsError);
  });

  it('pins adoption storage and refuses replaced symlink directories without external writes', () => {
    const r = rig();
    const dir = r.store.storeDirectory('artifacts');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-adoption-outside-'));
    dirs.push(outside);
    fs.renameSync(dir, `${dir}-original`);
    fs.symlinkSync(outside, dir);
    expect(() => recordAdoption(r.store, 'voluntary', START)).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(contributionOutcome(r.store).adoptionReported).toBe('unknown');
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'adoption',
      reason: 'corrupt',
    });
  });

  it('distinguishes missing, corrupt, recovered and identity-mismatch evidence without raw diagnostics', () => {
    const r = rig();
    r.shipping();
    r.step(ReasonCode.PublicationObserved);
    r.track();
    const file = path.join(r.store.storeDirectory('track'), 'events.jsonl');
    const original = fs.readFileSync(file);
    fs.unlinkSync(file);
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'track',
      reason: 'missing',
    });
    replacePrivate(file, Buffer.from('{}\n'));
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'track',
      reason: 'corrupt',
    });
    replacePrivate(
      file,
      Buffer.from(
        original.toString('utf8').replaceAll(r.store.contributionId, 'ztc-0000000000000000')
      )
    );
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'track',
      reason: 'identity_mismatch',
    });
    replacePrivate(file, Buffer.concat([original, Buffer.from('{')]));
    const j = new Journal(r.store.storeDirectory('track'));
    j.close();
    expect(contributionOutcome(r.store).unknownEvidence).toContainEqual({
      source: 'track',
      reason: 'recovered',
    });
  });
});
