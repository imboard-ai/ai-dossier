import type { Journal } from './journal';
import { isRecoveryEvent } from './recovery';
import { assertNoSecrets } from './redaction';
import {
  isRecord,
  permittedTransitions,
  ReasonCode,
  type RunRecord,
  type RunState,
  restoreRun,
  transitionRun,
} from './state';

export const OPERATION_KINDS = Object.freeze([
  'engagement_comment',
  'fork_ensure',
  'push_branch',
  'pr_create',
  'pr_update',
  'pr_close',
] as const);
export type OperationKind = (typeof OPERATION_KINDS)[number];
const MAX_WRITE_ATTEMPTS = 2; // Initial attempt plus one retry after proven absence.
export interface IntentInput {
  readonly contributionId: string;
  readonly target: string;
  readonly operationKind: OperationKind;
  /** Null before a candidate exists (engagement/fork only). */
  readonly candidateSha: string | null;
}
export interface Intent extends IntentInput {
  readonly key: string;
  readonly status: 'intended' | 'attempted' | 'confirmed' | 'ambiguous';
  readonly attempts: number;
  readonly retryReady: boolean;
  readonly artifactRef: string | null;
  /** Durable proven absence after the final attempt; never admits a retry. */
  readonly exhaustedAbsent?: true;
}
export type ReconcileResult =
  | { readonly kind: 'found'; readonly artifactRef: string; readonly remoteSha?: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };
export interface MutationResult {
  readonly artifactRef: string;
  readonly remoteSha?: string;
}
export interface WriteAdapter {
  /** Must establish contributor/target identity, not merely find a similar artifact. */
  reconcile(intent: Intent): Promise<ReconcileResult>;
  /** Must enforce authorization and compare-and-swap push semantics independently. */
  mutate(intent: Intent): Promise<MutationResult>;
}
export interface IntentState {
  readonly run: RunRecord;
  readonly contributionId: string;
  readonly intents: ReadonlyMap<string, Intent>;
  readonly blockedReason?: WriteBlockReason;
}
export const WRITE_BLOCK_REASONS = Object.freeze([
  'unknown',
  'reconciliation_error',
  'invalid_evidence',
  'unexpected_remote_sha',
  'retry_exhausted',
] as const);
export type WriteBlockReason = (typeof WRITE_BLOCK_REASONS)[number];
export class IntentError extends Error {
  constructor() {
    super('Invalid zero-trust write intent or journal event');
    this.name = 'IntentError';
  }
}
export class WriteBlockedError extends Error {
  constructor() {
    super('Zero-trust writes blocked; reconciliation requires hand-off');
    this.name = 'WriteBlockedError';
  }
}
export class MutationUncertainError extends Error {
  constructor() {
    super('Mutation outcome uncertain; reconcile before retry');
    this.name = 'MutationUncertainError';
  }
}

function safeString(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in persisted identifiers.
    /[\u0000-\u001f]/u.test(value)
  )
    throw new IntentError();
  assertNoSecrets(value);
  return value;
}
function inputOf(value: unknown): IntentInput {
  if (!isRecord(value)) throw new IntentError();
  const operationKind = value.operationKind as OperationKind;
  if (!OPERATION_KINDS.includes(operationKind)) throw new IntentError();
  const sha = value.candidateSha;
  if (
    !(typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha)) &&
    !(sha === null && (operationKind === 'engagement_comment' || operationKind === 'fork_ensure'))
  )
    throw new IntentError();
  return Object.freeze({
    contributionId: safeString(value.contributionId),
    target: safeString(value.target),
    operationKind,
    candidateSha: sha as string | null,
  });
}
export function idempotencyKey(input: IntentInput): string {
  const valid = inputOf(input);
  return JSON.stringify([
    valid.contributionId,
    valid.target,
    valid.operationKind,
    valid.candidateSha,
  ]);
}
export function engagementMarker(contributionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(contributionId)) throw new IntentError();
  assertNoSecrets(contributionId);
  return `<!-- ai-dossier:ztfc contribution=${contributionId} op=engagement -->`;
}
export function parseEngagementMarker(text: string): string | null {
  const matches = [
    ...text.matchAll(
      /<!-- ai-dossier:ztfc contribution=([A-Za-z0-9_-]{1,128}) op=engagement -->/gu
    ),
  ];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

type Event =
  | { v: 1; type: 'run'; run: RunRecord; contributionId: string }
  | { v: 1; type: 'run_update'; run: RunRecord }
  | { v: 1; type: 'intended'; input: IntentInput }
  | { v: 1; type: 'attempted' | 'ambiguous' | 'absent' | 'exhausted'; key: string }
  | { v: 1; type: 'confirmed'; key: string; artifactRef: string; remoteSha?: string }
  | { v: 1; type: 'blocked'; run: RunRecord; reason: WriteBlockReason };

/** Only the same controller run or an exact forward continuation may be observed. */
function continuation(previous: RunRecord, value: unknown): RunRecord {
  const run = restoreRun(value);
  if (
    run.runId !== previous.runId ||
    run.upstreamIssue !== previous.upstreamIssue ||
    run.contributor !== previous.contributor ||
    run.createdAt !== previous.createdAt ||
    run.history.length < previous.history.length ||
    JSON.stringify(run.history.slice(0, previous.history.length)) !==
      JSON.stringify(previous.history)
  )
    throw new IntentError();
  return run;
}

const ADMISSION: Readonly<Record<OperationKind, readonly RunState[]>> = Object.freeze({
  engagement_comment: ['gating', 'awaiting_maintainer'],
  fork_ensure: ['shipping'],
  push_branch: ['shipping'],
  pr_create: ['shipping'],
  pr_update: ['shipping', 'revising'],
  // Explicit withdrawal is performed before the controller records declined.
  pr_close: ['shipping', 'submitted', 'awaiting_review', 'revising', 'accepted'],
});

function reduce(state: IntentState | undefined, raw: unknown): IntentState {
  if (!isRecord(raw) || raw.v !== 1) throw new IntentError();
  if (raw.type === 'run') {
    if (state) throw new IntentError();
    const run = restoreRun(raw.run);
    return {
      run,
      contributionId: safeString(raw.contributionId),
      intents: new Map(),
    };
  }
  if (!state) throw new IntentError();
  if (raw.type === 'run_update') return { ...state, run: continuation(state.run, raw.run) };
  // Historical attempts remain replayable, but closed states cannot add attempts.
  if (
    (raw.type === 'intended' || raw.type === 'attempted') &&
    (state.blockedReason || !permittedTransitions(state.run.state)[ReasonCode.PolicyBlocked])
  )
    throw new IntentError();
  if (raw.type === 'blocked') {
    if (!WRITE_BLOCK_REASONS.includes(raw.reason as WriteBlockReason)) throw new IntentError();
    const run = restoreRun(raw.run);
    const expected = permittedTransitions(state.run.state)[ReasonCode.PolicyBlocked]
      ? transitionRun(state.run, ReasonCode.PolicyBlocked, run.updatedAt)
      : state.run;
    if (JSON.stringify(expected) !== JSON.stringify(run)) throw new IntentError();
    return { ...state, run, blockedReason: raw.reason as WriteBlockReason };
  }
  const intents = new Map(state.intents);
  if (raw.type === 'intended') {
    const input = inputOf(raw.input);
    const key = idempotencyKey(input);
    if (input.contributionId !== state.contributionId || intents.has(key)) throw new IntentError();
    intents.set(
      key,
      Object.freeze({
        ...input,
        key,
        status: 'intended',
        attempts: 0,
        retryReady: false,
        artifactRef: null,
      })
    );
  } else {
    const intent = typeof raw.key === 'string' ? intents.get(raw.key) : undefined;
    if (!intent) throw new IntentError();
    let next: Intent;
    if (intent.exhaustedAbsent) throw new IntentError();
    switch (raw.type) {
      case 'exhausted':
        if (
          !['attempted', 'ambiguous'].includes(intent.status) ||
          intent.attempts !== MAX_WRITE_ATTEMPTS
        )
          throw new IntentError();
        next = { ...intent, status: 'ambiguous', retryReady: false, exhaustedAbsent: true };
        break;
      case 'attempted':
        if (
          !(intent.status === 'intended' || intent.retryReady) ||
          intent.attempts >= MAX_WRITE_ATTEMPTS
        )
          throw new IntentError();
        next = { ...intent, status: 'attempted', attempts: intent.attempts + 1, retryReady: false };
        break;
      case 'ambiguous':
        if (intent.status !== 'attempted') throw new IntentError();
        next = { ...intent, status: 'ambiguous' };
        break;
      case 'absent':
        if (
          !['attempted', 'ambiguous'].includes(intent.status) ||
          intent.attempts >= MAX_WRITE_ATTEMPTS
        )
          throw new IntentError();
        next = { ...intent, status: 'ambiguous', retryReady: true };
        break;
      case 'confirmed':
        if (!['attempted', 'ambiguous'].includes(intent.status)) throw new IntentError();
        if (intent.operationKind === 'push_branch' && raw.remoteSha !== intent.candidateSha)
          throw new IntentError();
        next = {
          ...intent,
          status: 'confirmed',
          retryReady: false,
          artifactRef: safeString(raw.artifactRef),
        };
        break;
      default:
        throw new IntentError();
    }
    intents.set(intent.key, Object.freeze(next));
  }
  return {
    ...state,
    intents,
    // The fsynced exhaustion event itself fences ALL writes, including recovery
    // between this evidence append and the optional lifecycle block append.
    ...(raw.type === 'exhausted' ? { blockedReason: 'retry_exhausted' as const } : {}),
  };
}
export function replayIntents(events: readonly unknown[]): IntentState {
  let state: IntentState | undefined;
  for (const event of events) {
    if (!isRecoveryEvent(event)) state = reduce(state, event);
  }
  if (!state) throw new IntentError();
  return state;
}

const drivenJournals = new WeakSet<Journal>();

/** Serial controller driver. The injected adapter is trusted, never worker/model code. */
export class IntentDriver {
  private state: IntentState;
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(
    private readonly journal: Journal,
    private readonly adapter: WriteAdapter,
    initial: { run: RunRecord; contributionId: string },
    private readonly now: () => string
  ) {
    if (drivenJournals.has(journal)) throw new IntentError();
    const events = journal.read();
    const run = restoreRun(initial.run);
    const contributionId = safeString(initial.contributionId);
    if (!events.length) {
      const event: Event = { v: 1, type: 'run', run, contributionId };
      const state = reduce(undefined, event);
      journal.append(event);
      this.state = state;
    } else {
      this.state = replayIntents(events);
      if (this.state.contributionId !== contributionId) throw new IntentError();
      this.observeRun(run);
    }
    drivenJournals.add(journal);
  }
  snapshot(): IntentState {
    return { ...this.state, intents: new Map(this.state.intents) };
  }
  /** Synchronous revocation: cannot queue behind an asynchronous reconciliation/write. */
  observeRun(value: RunRecord): void {
    if (this.failed) throw new WriteBlockedError();
    const run = continuation(this.state.run, value);
    if (run.history.length !== this.state.run.history.length)
      this.persist({ v: 1, type: 'run_update', run });
  }
  private persist(event: Event): void {
    const next = reduce(this.state, event);
    try {
      this.journal.append(event);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.state = next;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => {
      if (this.failed) throw new WriteBlockedError();
      return work();
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private block(reason: WriteBlockReason = 'unknown'): never {
    // Latch before clock/transition/persistence: even a failed hand-off blocks admission.
    this.failed = true;
    const run = permittedTransitions(this.state.run.state)[ReasonCode.PolicyBlocked]
      ? transitionRun(this.state.run, ReasonCode.PolicyBlocked, this.now())
      : this.state.run;
    this.persist({ v: 1, type: 'blocked', run, reason });
    throw new WriteBlockedError();
  }
  private confirm(intent: Intent, result: MutationResult): void {
    // Snapshot once; adapter values do not get re-read after validation.
    const artifactRef = safeString(result.artifactRef);
    const remoteSha = intent.operationKind === 'push_branch' ? result.remoteSha : undefined;
    if (intent.operationKind === 'push_branch' && remoteSha !== intent.candidateSha)
      this.block('unexpected_remote_sha');
    this.persist({
      v: 1,
      type: 'confirmed',
      key: intent.key,
      artifactRef,
      ...(remoteSha === undefined ? {} : { remoteSha }),
    });
  }
  private async reconcileAll(): Promise<void> {
    for (const intent of this.state.intents.values()) {
      if (intent.exhaustedAbsent || !['attempted', 'ambiguous'].includes(intent.status)) continue;
      let result: ReconcileResult;
      try {
        const observed = await this.adapter.reconcile(intent);
        const kind = observed.kind;
        result =
          kind === 'found'
            ? { kind, artifactRef: observed.artifactRef, remoteSha: observed.remoteSha }
            : { kind };
      } catch {
        this.block('reconciliation_error');
      }
      if (this.failed) throw new WriteBlockedError();
      if (!result || result.kind === 'unknown') this.block();
      if (result.kind === 'found') {
        try {
          this.confirm(intent, result);
        } catch (error) {
          if (this.failed || error instanceof WriteBlockedError) throw error;
          this.block('invalid_evidence');
        }
      } else if (result.kind === 'absent') {
        if (intent.attempts >= MAX_WRITE_ATTEMPTS) {
          this.persist({ v: 1, type: 'exhausted', key: intent.key });
          this.block('retry_exhausted');
        }
        if (!intent.retryReady) this.persist({ v: 1, type: 'absent', key: intent.key });
      } else this.block('invalid_evidence');
    }
  }
  resume(): Promise<void> {
    return this.serial(() => this.reconcileAll());
  }
  private admit(operationKind: OperationKind): void {
    if (
      this.failed ||
      this.state.blockedReason ||
      !ADMISSION[operationKind].includes(this.state.run.state)
    )
      throw new WriteBlockedError();
  }
  execute(input: IntentInput): Promise<string> {
    const valid = inputOf(input);
    const key = idempotencyKey(valid);
    return this.serial(async () => {
      if (valid.contributionId !== this.state.contributionId) throw new IntentError();
      await this.reconcileAll();
      this.admit(valid.operationKind);
      let intent = this.state.intents.get(key);
      if (intent?.status === 'confirmed') return intent.artifactRef as string;
      if (!intent) {
        this.persist({ v: 1, type: 'intended', input: valid });
        intent = this.state.intents.get(key) as Intent;
      }
      this.persist({ v: 1, type: 'attempted', key });
      intent = this.state.intents.get(key) as Intent;
      let result: MutationResult;
      this.admit(valid.operationKind);
      try {
        result = await this.adapter.mutate(intent);
      } catch {
        this.persist({ v: 1, type: 'ambiguous', key });
        throw new MutationUncertainError();
      }
      try {
        this.confirm(intent, result);
      } catch (error) {
        if (this.failed || error instanceof WriteBlockedError) throw error;
        this.persist({ v: 1, type: 'ambiguous', key });
        throw new MutationUncertainError();
      }
      return this.state.intents.get(key)?.artifactRef as string;
    });
  }
}
