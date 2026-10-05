import type { Journal } from './journal';
import { assertNoSecrets } from './redaction';
import {
  isRecord,
  permittedTransitions,
  ReasonCode,
  type RunRecord,
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
}
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
  | { v: 1; type: 'intended'; input: IntentInput }
  | { v: 1; type: 'attempted' | 'ambiguous' | 'absent'; key: string }
  | { v: 1; type: 'confirmed'; key: string; artifactRef: string; remoteSha?: string }
  | { v: 1; type: 'blocked'; run: RunRecord };

function reduce(state: IntentState | undefined, raw: unknown): IntentState {
  if (!isRecord(raw) || raw.v !== 1) throw new IntentError();
  if (raw.type === 'run') {
    if (state) throw new IntentError();
    const run = restoreRun(raw.run);
    if (run.state !== 'blocked' && !permittedTransitions(run.state)[ReasonCode.PolicyBlocked])
      throw new IntentError();
    return {
      run,
      contributionId: safeString(raw.contributionId),
      intents: new Map(),
    };
  }
  if (!state || state.run.state === 'blocked') throw new IntentError();
  if (raw.type === 'blocked') {
    const run = restoreRun(raw.run);
    const expected = transitionRun(state.run, ReasonCode.PolicyBlocked, run.updatedAt);
    if (JSON.stringify(expected) !== JSON.stringify(run)) throw new IntentError();
    return { ...state, run };
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
    switch (raw.type) {
      case 'attempted':
        if (!(intent.status === 'intended' || intent.retryReady) || intent.attempts >= 2)
          throw new IntentError();
        next = { ...intent, status: 'attempted', attempts: intent.attempts + 1, retryReady: false };
        break;
      case 'ambiguous':
        if (intent.status !== 'attempted') throw new IntentError();
        next = { ...intent, status: 'ambiguous' };
        break;
      case 'absent':
        if (!['attempted', 'ambiguous'].includes(intent.status) || intent.attempts >= 2)
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
  return { ...state, intents };
}
export function replayIntents(events: readonly unknown[]): IntentState {
  let state: IntentState | undefined;
  for (const event of events) state = reduce(state, event);
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
      if (
        this.state.run.runId !== run.runId ||
        this.state.run.upstreamIssue !== run.upstreamIssue ||
        this.state.run.contributor !== run.contributor ||
        this.state.contributionId !== contributionId
      )
        throw new IntentError();
    }
    drivenJournals.add(journal);
  }
  snapshot(): IntentState {
    return { ...this.state, intents: new Map(this.state.intents) };
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
      if (this.failed || this.state.run.state === 'blocked') throw new WriteBlockedError();
      return work();
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private block(): never {
    const run = transitionRun(this.state.run, ReasonCode.PolicyBlocked, this.now());
    this.persist({ v: 1, type: 'blocked', run });
    throw new WriteBlockedError();
  }
  private confirm(intent: Intent, result: MutationResult): void {
    // Snapshot once; adapter values do not get re-read after validation.
    const artifactRef = safeString(result.artifactRef);
    const remoteSha = intent.operationKind === 'push_branch' ? result.remoteSha : undefined;
    if (intent.operationKind === 'push_branch' && remoteSha !== intent.candidateSha) this.block();
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
      if (!['attempted', 'ambiguous'].includes(intent.status)) continue;
      let result: ReconcileResult;
      try {
        const observed = await this.adapter.reconcile(intent);
        const kind = observed.kind;
        result =
          kind === 'found'
            ? { kind, artifactRef: observed.artifactRef, remoteSha: observed.remoteSha }
            : { kind };
      } catch {
        this.block();
      }
      if (!result || result.kind === 'unknown') this.block();
      if (result.kind === 'found') {
        try {
          this.confirm(intent, result);
        } catch (error) {
          if (this.failed || error instanceof WriteBlockedError) throw error;
          this.block();
        }
      } else if (result.kind === 'absent') {
        if (intent.attempts >= 2) this.block();
        if (!intent.retryReady) this.persist({ v: 1, type: 'absent', key: intent.key });
      } else this.block();
    }
  }
  resume(): Promise<void> {
    return this.serial(() => this.reconcileAll());
  }
  execute(input: IntentInput): Promise<string> {
    const valid = inputOf(input);
    const key = idempotencyKey(valid);
    return this.serial(async () => {
      if (valid.contributionId !== this.state.contributionId) throw new IntentError();
      await this.reconcileAll();
      let intent = this.state.intents.get(key);
      if (intent?.status === 'confirmed') return intent.artifactRef as string;
      if (!intent) {
        this.persist({ v: 1, type: 'intended', input: valid });
        intent = this.state.intents.get(key) as Intent;
      }
      this.persist({ v: 1, type: 'attempted', key });
      intent = this.state.intents.get(key) as Intent;
      let result: MutationResult;
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
