/** Local PRD §6 facts; reporting never grants permission or performs external I/O. */
import path from 'node:path';
import { lifecycleTimes } from '../controller/lifecycle-times';
import {
  OutcomeEvidenceError,
  readOutcomeBudget,
  readOutcomeHandoffs,
  readOutcomeTrack,
} from '../controller/outcome-records';
import { RunEvidenceError, type RunStore } from '../controller/run-store';
import { dataDescriptors } from '../data-descriptors';
import { readPrivate } from '../durable-fs';
import { isGitHubLogin } from '../github-login';
import { assertNoSecrets, assertSecretFree } from '../redaction';
import { isRecord, isTimestamp, ReasonCode } from '../state';
import { parseStrictUtf8Json } from '../strict-utf8';

export type Known<T> = T | 'unknown';
export interface CostAmounts {
  readonly estimatedMinor: Known<number>;
  readonly observedMinor: Known<number>;
}
export interface CurrencyCost extends CostAmounts {
  readonly model: CostAmounts;
  readonly vm: CostAmounts;
}
export interface ContributionOutcome {
  readonly contributionId: string;
  /** Availability is separate from text: `unknown` is itself a valid GitHub login. */
  readonly identity: 'known' | 'unknown';
  readonly contributor: Known<string>;
  readonly upstream: Known<string>;
  readonly issue: Known<number>;
  readonly gated: 'eligible' | 'ineligible' | 'hand_off' | 'unknown';
  readonly submitted: Known<boolean>;
  readonly prUrl?: Known<string>;
  readonly outcome: 'open' | 'accepted' | 'merged' | 'declined' | 'none' | 'unknown';
  readonly revisions: Known<number>;
  readonly activeMs: Known<number>;
  readonly waitMs: Known<{
    readonly maintainer: number;
    readonly contributor: number;
    readonly review: number;
    readonly paused: number;
  }>;
  readonly cost: { readonly byCurrency: Known<Readonly<Record<string, CurrencyCost>>> };
  readonly adoptionReported?: Known<{ readonly at: string; readonly note: string }>;
  readonly unknownEvidence: readonly EvidenceDiagnostic[];
}
export interface EvidenceDiagnostic {
  readonly source: 'run' | 'config' | 'handoff' | 'track' | 'budget' | 'time' | 'adoption';
  readonly reason:
    | 'missing'
    | 'corrupt'
    | 'identity_mismatch'
    | 'incomplete'
    | 'recovered'
    | 'invalid_timestamp';
}
export class MetricsError extends Error {
  constructor() {
    super('Invalid local outcome metrics');
    this.name = 'MetricsError';
  }
}
function attempt<T>(
  source: EvidenceDiagnostic['source'],
  diagnostics: EvidenceDiagnostic[],
  read: () => T
): Known<T> {
  try {
    return read();
  } catch (error) {
    const code = (error as { code?: string })?.code;
    diagnostics.push({
      source: error instanceof RunEvidenceError ? error.source : source,
      reason:
        error instanceof OutcomeEvidenceError
          ? error.code
          : source === 'time'
            ? 'invalid_timestamp'
            : code === 'persistence_uncertain'
              ? 'incomplete'
              : ['identity_mismatch', 'missing', 'incomplete', 'recovered'].includes(code ?? '')
                ? (code as EvidenceDiagnostic['reason'])
                : code === 'ENOENT' || code === 'missing_ledger'
                  ? 'missing'
                  : 'corrupt',
    });
    return 'unknown';
  }
}
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) throw new MetricsError();
  return sum;
}
function amounts(
  rows: readonly {
    estimate: { money: { minor: number } };
    observed?: { money: { minor: number } };
    status: string;
  }[]
): CostAmounts {
  return {
    estimatedMinor: rows.reduce((sum, row) => add(sum, row.estimate.money.minor), 0),
    observedMinor: rows.some((row) => !row.observed)
      ? 'unknown'
      : rows.reduce((sum, row) => add(sum, row.observed?.money.minor ?? 0), 0),
  };
}
function costs(store: RunStore): Readonly<Record<string, CurrencyCost>> {
  const state = readOutcomeBudget(store);
  const byCurrency: Record<string, CurrencyCost> = {};
  for (const currency of new Set(state.sessions.map((s) => s.ceiling.currency))) {
    const rows = state.reservations.filter(
      (r) => r.status !== 'released' && r.estimate.money.currency === currency
    );
    // Currency is the ledger's accounting currency after recorded FX, never a sum of source currencies.
    const models = new Set(Object.values(store.config.modelProfile.phases).map((p) => p?.model));
    const kind = (row: (typeof rows)[number]) => {
      const kinds = new Set(
        row.estimate.rates.map((r) =>
          r.unit === 'token' || models.has(r.resource)
            ? 'model'
            : r.unit === 'vm_increment'
              ? 'vm'
              : 'other'
        )
      );
      return kinds.size === 1 ? [...kinds][0] : 'mixed';
    };
    const uncertain = rows.some((r) => kind(r) === 'mixed' || kind(r) === 'other');
    const unknown: CostAmounts = { estimatedMinor: 'unknown', observedMinor: 'unknown' };
    byCurrency[currency] = {
      ...amounts(rows),
      model: uncertain ? unknown : amounts(rows.filter((r) => kind(r) === 'model')),
      vm: uncertain ? unknown : amounts(rows.filter((r) => kind(r) === 'vm')),
    };
  }
  return byCurrency;
}
export const ADOPTION_MAX_LENGTH = 2000;
function adoption(raw: unknown): { at: string; note: string } {
  if (!plainRecord(raw)) throw new MetricsError();
  const { at, note } = raw;
  if (typeof note === 'string') assertNoSecrets(note);
  if (
    !isTimestamp(at) ||
    typeof note !== 'string' ||
    !note.trim() ||
    note.length > ADOPTION_MAX_LENGTH ||
    Object.keys(raw).some((k) => !['at', 'note'].includes(k))
  )
    throw new MetricsError();
  return { at, note };
}
function readAdoption(
  store: RunStore,
  diagnostics: EvidenceDiagnostic[]
): ContributionOutcome['adoptionReported'] {
  try {
    return store.withStoreDirectory('artifacts', (dir) => {
      try {
        return adoption(parseStrictUtf8Json(readPrivate(path.join(dir, 'adoption.json'))));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
  } catch (error) {
    diagnostics.push({
      source: 'adoption',
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt',
    });
    return 'unknown';
  }
}
/** Explicit voluntary local note. No telemetry and no automatic adoption inference. */
export function recordAdoption(store: RunStore, note: string, now: Date | string): void {
  const value = adoption({ at: now instanceof Date ? now.toISOString() : now, note });
  store.replaceArtifact('adoption.json', Buffer.from(JSON.stringify(value)));
}

/** `now` defaults to the last durable transition, making repeated reads deterministic. */
export function contributionOutcome(store: RunStore, now?: Date | string): ContributionOutcome {
  const unknownEvidence: EvidenceDiagnostic[] = [];
  const unknown: ContributionOutcome = {
    contributionId: store.contributionId,
    identity: 'unknown',
    contributor: 'unknown',
    upstream: 'unknown',
    issue: 'unknown',
    gated: 'unknown',
    submitted: 'unknown',
    outcome: 'unknown',
    revisions: 'unknown',
    activeMs: 'unknown',
    waitMs: 'unknown',
    cost: { byCurrency: 'unknown' },
    unknownEvidence,
  };
  const evidence = attempt('run', unknownEvidence, () => store.validateOutcomeEvidence());
  if (evidence === 'unknown') return unknown;
  const { config, run } = evidence;
  if (config.issueUrl !== run.upstreamIssue || config.contributor !== run.contributor)
    return unknown;
  const handoffs = attempt('handoff', unknownEvidence, () => readOutcomeHandoffs(store, run));
  const tracker = attempt('track', unknownEvidence, () => readOutcomeTrack(store, run));
  const submitted = run.history.some((e) => e.reasonCode === ReasonCode.PublicationObserved);
  const passed = run.history.some((e) => e.reasonCode === ReasonCode.GatePassed);
  const gated = passed
    ? 'eligible'
    : run.history.some((e) => e.from === 'gating' && e.reasonCode === ReasonCode.PolicyBlocked)
      ? 'ineligible'
      : run.history.some(
            (e) =>
              e.from === 'gating' && ['awaiting_maintainer', 'awaiting_contributor'].includes(e.to)
          )
        ? 'hand_off'
        : 'unknown';
  const times = attempt('time', unknownEvidence, () => {
    const end = now instanceof Date ? now.toISOString() : (now ?? run.updatedAt);
    if (!isTimestamp(end) || Date.parse(end) < Date.parse(run.updatedAt)) throw new MetricsError();
    return lifecycleTimes(run, Date.parse(end));
  });
  const observed =
    handoffs === 'unknown'
      ? undefined
      : [...handoffs.handoffs.values()].find(
          (h) => h.input.operationKind === 'pr_create' && h.status === 'observed'
        );
  const outcome: ContributionOutcome['outcome'] = !submitted
    ? 'none'
    : tracker === 'unknown'
      ? 'unknown'
      : tracker.run.state === 'merged' || tracker.run.state === 'declined'
        ? tracker.outcomeSha
          ? tracker.run.state
          : 'unknown'
        : run.state === 'accepted'
          ? 'accepted'
          : [
                'submitted',
                'awaiting_review',
                'revising',
                'implementing',
                'verifying',
                'shipping',
                'paused_user',
              ].includes(run.state)
            ? 'open'
            : 'unknown';
  const adoptionReported = readAdoption(store, unknownEvidence);
  const value: ContributionOutcome = {
    contributionId: store.contributionId,
    identity: 'known',
    contributor: run.contributor,
    upstream: `${config.upstream.owner}/${config.upstream.repo}`,
    issue: config.upstream.issue,
    gated,
    submitted,
    ...(submitted
      ? { prUrl: tracker !== 'unknown' ? tracker.pr.url : (observed?.artifactRef ?? 'unknown') }
      : {}),
    outcome,
    revisions: !submitted
      ? 0
      : tracker === 'unknown'
        ? 'unknown'
        : tracker.run.history.filter((e) => e.reasonCode === ReasonCode.RevisionRequested).length,
    activeMs: times === 'unknown' ? 'unknown' : times.activeMs,
    waitMs: times === 'unknown' ? 'unknown' : times.waitMs,
    cost: { byCurrency: attempt('budget', unknownEvidence, () => costs(store)) },
    ...(adoptionReported === undefined ? {} : { adoptionReported }),
    unknownEvidence,
  };
  assertSecretFree(value);
  return value;
}

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: Known<number>;
  readonly unknown: number;
}
export interface OutcomeAggregate {
  readonly contributions: number;
  readonly eligibleToSubmitted: Rate;
  readonly accepted: Rate;
  readonly merged: Rate;
  readonly declined: Rate;
  readonly reworkPerSubmitted: Rate;
  readonly medianActiveMs: Known<number>;
  readonly costPerSubmitted: Known<Readonly<Record<string, CurrencyCost>>>;
  readonly costPerAccepted: Known<Readonly<Record<string, CurrencyCost>>>;
  readonly repeatUsage: Readonly<Record<string, number>>;
  readonly unknownContributors: number;
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value) || Object.keys(value).some((k) => !keys.includes(k)))
    throw new MetricsError();
  return value;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function choice(value: unknown, values: readonly unknown[]): void {
  if (!values.includes(value)) throw new MetricsError();
}
function count(value: unknown, allowUnknown = false, integer = true): void {
  if (allowUnknown && value === 'unknown') return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new MetricsError();
}
function text(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) throw new MetricsError();
}
function validateCosts(input: unknown, integer: boolean): void {
  if (input === 'unknown') return;
  if (!plainRecord(input)) throw new MetricsError();
  for (const [currency, raw] of Object.entries(input)) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new MetricsError();
    const row = shape(raw, ['estimatedMinor', 'observedMinor', 'model', 'vm']);
    for (const part of [
      row,
      shape(row.model, ['estimatedMinor', 'observedMinor']),
      shape(row.vm, ['estimatedMinor', 'observedMinor']),
    ]) {
      count(part.estimatedMinor, true, integer);
      count(part.observedMinor, true, integer);
    }
    for (const field of ['estimatedMinor', 'observedMinor']) {
      const total = row[field];
      const model = (row.model as Record<string, unknown>)[field];
      const vm = (row.vm as Record<string, unknown>)[field];
      if (typeof total === 'number') {
        const knownSum =
          (typeof model === 'number' ? model : 0) + (typeof vm === 'number' ? vm : 0);
        const tolerance = integer ? 0 : Number.EPSILON * Math.max(1, knownSum, total) * 4;
        if (knownSum - total > tolerance) throw new MetricsError();
      }
      if (typeof total === 'number' && typeof model === 'number' && typeof vm === 'number') {
        const sum = model + vm;
        const tolerance = integer ? 0 : Number.EPSILON * Math.max(1, sum, total) * 4;
        if (!Number.isFinite(sum) || Math.abs(total - sum) > tolerance) throw new MetricsError();
      }
    }
  }
}
/** Preserve original container authority: structuredClone erases class prototypes.
 * Like receipt snapshots, inspect data descriptors without invoking getters/toJSON.
 * Metrics permit finite fractional averages and null-prototype dictionaries. */
function snapshotFacts(input: unknown): unknown {
  let nodes = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 12) throw new MetricsError();
    if (
      value === undefined ||
      value === null ||
      ['string', 'boolean', 'number'].includes(typeof value)
    )
      return value;
    if (typeof value !== 'object') throw new MetricsError();
    const { array, keys, descriptors } = dataDescriptors(value, true);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  try {
    return copy(input, 0);
  } catch {
    throw new MetricsError();
  }
}
function safeOutcome(input: unknown): ContributionOutcome {
  const raw = shape(snapshotFacts(input), [
    'contributionId',
    'identity',
    'contributor',
    'upstream',
    'issue',
    'gated',
    'submitted',
    'prUrl',
    'outcome',
    'revisions',
    'activeMs',
    'waitMs',
    'cost',
    'adoptionReported',
    'unknownEvidence',
  ]);
  assertSecretFree(raw);
  text(raw.contributionId);
  text(raw.contributor);
  text(raw.upstream);
  choice(raw.identity, ['known', 'unknown']);
  if (raw.identity === 'known' && !isGitHubLogin(raw.contributor)) throw new MetricsError();
  choice(raw.gated, ['eligible', 'ineligible', 'hand_off', 'unknown']);
  choice(raw.submitted, [true, false, 'unknown']);
  choice(raw.outcome, ['open', 'accepted', 'merged', 'declined', 'none', 'unknown']);
  if (
    (raw.submitted === false && !['none', 'unknown'].includes(raw.outcome as string)) ||
    (raw.submitted === true && raw.outcome === 'none') ||
    (raw.submitted === 'unknown' && raw.outcome !== 'unknown')
  )
    throw new MetricsError();
  if (
    (raw.submitted === true && ['ineligible', 'hand_off'].includes(raw.gated as string)) ||
    (raw.submitted === false && typeof raw.revisions === 'number' && raw.revisions > 0)
  )
    throw new MetricsError();
  count(raw.issue, true);
  count(raw.revisions, true);
  count(raw.activeMs, true);
  if (raw.prUrl !== undefined) text(raw.prUrl);
  else delete raw.prUrl;
  if (raw.waitMs !== 'unknown') {
    const waits = shape(raw.waitMs, ['maintainer', 'contributor', 'review', 'paused']);
    for (const key of ['maintainer', 'contributor', 'review', 'paused']) count(waits[key]);
  }
  validateCosts(shape(raw.cost, ['byCurrency']).byCurrency, true);
  if (raw.adoptionReported !== undefined && raw.adoptionReported !== 'unknown')
    adoption(raw.adoptionReported);
  else if (raw.adoptionReported === undefined) delete raw.adoptionReported;
  if (!Array.isArray(raw.unknownEvidence)) throw new MetricsError();
  for (const entry of raw.unknownEvidence) {
    const d = shape(entry, ['source', 'reason']);
    choice(d.source, ['run', 'config', 'handoff', 'track', 'budget', 'time', 'adoption']);
    choice(d.reason, [
      'missing',
      'corrupt',
      'identity_mismatch',
      'incomplete',
      'recovered',
      'invalid_timestamp',
    ]);
  }
  return raw as unknown as ContributionOutcome;
}
function safeAggregate(input: unknown): OutcomeAggregate {
  const raw = shape(snapshotFacts(input), [
    'contributions',
    'eligibleToSubmitted',
    'accepted',
    'merged',
    'declined',
    'reworkPerSubmitted',
    'medianActiveMs',
    'costPerSubmitted',
    'costPerAccepted',
    'repeatUsage',
    'unknownContributors',
  ]);
  assertSecretFree(raw);
  count(raw.contributions);
  count(raw.unknownContributors);
  count(raw.medianActiveMs, true, false);
  const contributions = raw.contributions as number;
  for (const key of [
    'eligibleToSubmitted',
    'accepted',
    'merged',
    'declined',
    'reworkPerSubmitted',
  ]) {
    const r = shape(raw[key], ['numerator', 'denominator', 'unknown', 'value']);
    count(r.numerator);
    count(r.denominator);
    count(r.unknown);
    count(r.value, true, false);
    if (
      r.value !== rate(r.numerator as number, r.denominator as number, r.unknown as number).value ||
      (key !== 'reworkPerSubmitted' && (r.numerator as number) > (r.denominator as number)) ||
      (r.denominator as number) > contributions ||
      (r.denominator === 0 && r.numerator !== 0) ||
      (r.unknown as number) > contributions ||
      (key !== 'eligibleToSubmitted' && r.denominator !== (raw.accepted as Rate).denominator)
    )
      throw new MetricsError();
  }
  validateCosts(raw.costPerSubmitted, false);
  validateCosts(raw.costPerAccepted, false);
  if (
    (contributions === 0 && raw.medianActiveMs !== 'unknown') ||
    ((raw.accepted as Rate).unknown > 0 && raw.costPerAccepted !== 'unknown') ||
    ((raw.accepted as Rate).denominator === 0 &&
      raw.costPerSubmitted !== 'unknown' &&
      Object.keys(raw.costPerSubmitted as object).length > 0) ||
    ((raw.accepted as Rate).numerator === 0 &&
      raw.costPerAccepted !== 'unknown' &&
      Object.keys(raw.costPerAccepted as object).length > 0)
  )
    throw new MetricsError();
  if (!plainRecord(raw.repeatUsage)) throw new MetricsError();
  let knownContributors = 0;
  for (const [login, total] of Object.entries(raw.repeatUsage)) {
    if (!isGitHubLogin(login) || login !== login.toLowerCase()) throw new MetricsError();
    count(total);
    if (total === 0) throw new MetricsError();
    knownContributors = add(knownContributors, total as number);
  }
  if (
    add(knownContributors, raw.unknownContributors as number) !== contributions ||
    (raw.merged as Rate).numerator > (raw.accepted as Rate).numerator ||
    add((raw.accepted as Rate).numerator, (raw.declined as Rate).numerator) >
      (raw.accepted as Rate).denominator ||
    add(
      add((raw.accepted as Rate).numerator, (raw.declined as Rate).numerator),
      (raw.accepted as Rate).unknown
    ) > contributions ||
    (raw.eligibleToSubmitted as Rate).numerator > (raw.accepted as Rate).denominator ||
    add((raw.eligibleToSubmitted as Rate).numerator, (raw.eligibleToSubmitted as Rate).unknown) >
      contributions ||
    (raw.merged as Rate).unknown !== (raw.accepted as Rate).unknown ||
    (raw.declined as Rate).unknown !== (raw.accepted as Rate).unknown
  )
    throw new MetricsError();
  return raw as unknown as OutcomeAggregate;
}
function rate(numerator: number, denominator: number, unknown: number): Rate {
  return {
    numerator,
    denominator,
    unknown,
    value: unknown || !denominator ? 'unknown' : numerator / denominator,
  };
}
function averageCost(
  outcomes: readonly ContributionOutcome[]
): OutcomeAggregate['costPerSubmitted'] {
  if (outcomes.some((o) => o.cost.byCurrency === 'unknown')) return 'unknown';
  const currencies = new Set(outcomes.flatMap((o) => Object.keys(o.cost.byCurrency)));
  const result: Record<string, CurrencyCost> = {};
  for (const currency of currencies) {
    const rows = outcomes.map((o) =>
      o.cost.byCurrency === 'unknown' ? undefined : o.cost.byCurrency[currency]
    );
    const avg = (part: 'total' | 'model' | 'vm', field: keyof CostAmounts): Known<number> => {
      const values = rows.map((r) =>
        r === undefined ? 0 : part === 'total' ? r[field] : r[part][field]
      );
      if (values.includes('unknown')) return 'unknown';
      return values.reduce<number>((sum, v) => add(sum, v as number), 0) / outcomes.length;
    };
    const component = (part: 'total' | 'model' | 'vm'): CostAmounts => ({
      estimatedMinor: avg(part, 'estimatedMinor'),
      observedMinor: avg(part, 'observedMinor'),
    });
    result[currency] = { ...component('total'), model: component('model'), vm: component('vm') };
  }
  return result;
}
/** One outcome per contribution, never one per resumed session. Duplicate IDs are refused. */
export function aggregate(input: readonly ContributionOutcome[]): OutcomeAggregate {
  const cohort = snapshotFacts(input);
  if (!Array.isArray(cohort)) throw new MetricsError();
  const outcomes = cohort.map(safeOutcome);
  assertSecretFree(outcomes);
  if (new Set(outcomes.map((o) => o.contributionId)).size !== outcomes.length)
    throw new MetricsError();
  const submitted = outcomes.filter((o) => o.submitted === true);
  const unknownSubmission = outcomes.filter((o) => o.submitted === 'unknown').length;
  const eligible = outcomes.filter((o) => o.gated === 'eligible');
  const accepted = submitted.filter((o) => o.outcome === 'accepted' || o.outcome === 'merged');
  const unknownOutcome =
    submitted.filter((o) => o.outcome === 'unknown').length + unknownSubmission;
  const times = outcomes.map((o) => o.activeMs);
  const sorted = times.filter((t): t is number => typeof t === 'number').sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const repeatUsage: Record<string, number> = Object.create(null);
  for (const o of outcomes)
    if (o.identity === 'known') {
      const login = o.contributor.toLowerCase();
      repeatUsage[login] = add(repeatUsage[login] ?? 0, 1);
    }
  return {
    contributions: outcomes.length,
    eligibleToSubmitted: rate(
      eligible.filter((o) => o.submitted === true).length,
      eligible.length,
      outcomes.filter(
        (o) => o.gated === 'unknown' || (o.gated === 'eligible' && o.submitted === 'unknown')
      ).length
    ),
    accepted: rate(accepted.length, submitted.length, unknownOutcome),
    merged: rate(
      submitted.filter((o) => o.outcome === 'merged').length,
      submitted.length,
      unknownOutcome
    ),
    declined: rate(
      submitted.filter((o) => o.outcome === 'declined').length,
      submitted.length,
      unknownOutcome
    ),
    reworkPerSubmitted: rate(
      submitted.reduce((n, o) => add(n, typeof o.revisions === 'number' ? o.revisions : 0), 0),
      submitted.length,
      submitted.filter((o) => o.revisions === 'unknown').length + unknownSubmission
    ),
    medianActiveMs:
      times.includes('unknown') || !sorted.length
        ? 'unknown'
        : sorted.length % 2
          ? (sorted[middle] as number)
          : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
    costPerSubmitted: unknownSubmission ? 'unknown' : averageCost(submitted),
    costPerAccepted: unknownOutcome ? 'unknown' : averageCost(accepted),
    repeatUsage,
    unknownContributors: outcomes.filter((o) => o.identity === 'unknown').length,
  };
}
export function renderMetricsJson(value: ContributionOutcome | OutcomeAggregate): string {
  const detached = snapshotFacts(value);
  const snapshot =
    isRecord(detached) && Object.hasOwn(detached, 'contributionId')
      ? safeOutcome(detached)
      : safeAggregate(detached);
  assertSecretFree(snapshot);
  return JSON.stringify(snapshot, null, 2);
}
export function renderMetricsHuman(value: ContributionOutcome | OutcomeAggregate): string {
  const snapshot = JSON.parse(renderMetricsJson(value)) as Record<string, unknown>;
  return Object.entries(snapshot)
    .map(([key, fact]) => `${key}: ${JSON.stringify(fact)}`)
    .join('\n');
}
