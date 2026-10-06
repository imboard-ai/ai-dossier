/** Durable contributor hand-off (PRD §5.8 `awaiting_contributor`). Issuing a link is never
 * a write: the journal records "link issued" and, after reconciliation, "observed". The
 * driver schedules nothing — no reminders, no compute until an explicit resume. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replacePrivate } from '../durable-fs';
import { type IntentInput, idempotencyKey } from '../intents';
import type { Journal } from '../journal';
import { receiptDigest } from '../receipt/issue';
import { parseReceipt } from '../receipt/schema';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import { isRecord, ReasonCode, type RunRecord, restoreRun, transitionRun } from '../state';
import {
  compareLink,
  formatCompareLink,
  type HandoffOperation,
  handoffIntentId,
  handoffMarker,
  type IssueBinding,
  issueBinding,
  issueCommentLink,
  issueUrl,
  type PrBinding,
  type PreparedLink,
  prBinding,
} from './handoff';
import { buildPrContent, type PrContentInput } from './pr-body';
import { type AmbiguityReason, type GitHubRead, reconcileComment, reconcilePr } from './reconcile';
import { HandoffError } from './text';

/** Admission is identical to a brokered write (PRD §5.9); each check runs fresh. */
export interface HandoffAdmission {
  /** AI policy, issue open state, assignment, competing fixes and permission, rechecked now. */
  policyFresh(): Promise<boolean>;
  /** The authenticated contributor login equals the run's contributor. */
  contributorVerified(): Promise<boolean>;
  /** PR only: the fork is owned by the contributor and its parent is the bound upstream. */
  forkBindingVerified(): Promise<boolean>;
  /** PR only: the authenticated receipt with this canonical SHA-256 (the one rendered in
   * the body) is valid for this candidate SHA. */
  receiptValid(candidateSha: string, receiptDigest: string): Promise<boolean>;
  /** PR only, provided by the verified push (#1066): the fork branch SHA read back from the
   * remote, or null when the branch is absent. Must equal the candidate. */
  remoteBranchSha(): Promise<string | null>;
}

export interface HandoffDeps {
  readonly read: GitHubRead;
  readonly admission: HandoffAdmission;
  /** Controller-owned directory for copy-paste body files. */
  readonly bodyDirectory: string;
  readonly now: () => string;
}

/** Only a moved head is terminal; an ambiguous match waits for a person (see resume). */
export const HANDOFF_BLOCK_REASONS = Object.freeze(['unexpected_head_sha'] as const);
export type HandoffBlockReason = (typeof HANDOFF_BLOCK_REASONS)[number];

export interface HandoffRecord {
  readonly key: string;
  readonly intentId: string;
  readonly input: IntentInput & { readonly operationKind: HandoffOperation };
  readonly binding: PrBinding | IssueBinding;
  readonly link: string;
  readonly linkKind: PreparedLink['kind'];
  readonly title?: string;
  readonly bodyFile: string;
  readonly bodyDigest: string;
  readonly status: 'link_issued' | 'observed' | 'blocked';
  /** The run's time when the link was issued. */
  readonly issuedAt: string;
  readonly artifactRef?: string;
  /** PR only, once observed. */
  readonly number?: number;
  readonly headSha?: string;
  readonly prState?: PrState;
  readonly reason?: HandoffBlockReason;
}
export type PrState = 'open' | 'closed' | 'merged';
export interface HandoffState {
  readonly run: RunRecord;
  readonly contributionId: string;
  readonly handoffs: ReadonlyMap<string, HandoffRecord>;
}

export interface HandoffStatus {
  readonly state: 'awaiting_contributor';
  readonly operation: HandoffOperation;
  readonly link: string;
  readonly linkKind: PreparedLink['kind'];
  /** What the contributor's click will submit, and where. */
  readonly submits: string;
  readonly title?: string;
  readonly bodyFile: string;
  readonly bodyDigest: string;
  /** The contributor submits under their own account and is the author. */
  readonly author: string;
  readonly nextPermittedAction: string;
}

export type HandoffOutcome =
  | {
      readonly kind: 'awaiting_contributor';
      readonly status: HandoffStatus;
      /** `unknown`: GitHub could not be read; the same link stays valid, none is reissued.
       * `ambiguous`: a person must resolve the submissions (status says how), then resume. */
      readonly reconciliation: 'absent' | 'unknown' | 'ambiguous' | 'not_checked';
      readonly ambiguity?: AmbiguityReason;
    }
  | {
      readonly kind: 'observed';
      readonly operation: HandoffOperation;
      readonly url: string;
      /** PR only, as observed; a closed PR is surfaced, not hidden. */
      readonly prState?: PrState;
      readonly number?: number;
      readonly headSha?: string;
      /** Never `green`: upstream CI is not observed here (scenario 12). */
      readonly ci: 'pending' | 'unknown';
    }
  | { readonly kind: 'blocked'; readonly reason: HandoffBlockReason };

type Event =
  | { v: 1; type: 'handoff_run'; run: RunRecord; contributionId: string }
  | { v: 1; type: 'handoff_run_update'; run: RunRecord }
  | {
      v: 1;
      type: 'link_issued';
      input: IntentInput;
      binding: PrBinding | IssueBinding;
      link: string;
      linkKind: PreparedLink['kind'];
      title?: string;
      body: string;
      bodyFile: string;
      bodyDigest: string;
      run: RunRecord;
    }
  | {
      v: 1;
      type: 'handoff_observed';
      key: string;
      artifactRef: string;
      number?: number;
      headSha?: string;
      prState?: PrState;
      run: RunRecord;
    }
  | { v: 1; type: 'handoff_blocked'; key: string; reason: HandoffBlockReason; run: RunRecord };

function fail(): never {
  throw new HandoffError('invalid_journal');
}

function sameRun(a: RunRecord, b: RunRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
    fail();
  return run;
}

/** The upstream comes from the run's own issue URL, not from the link request. */
function upstreamIssue(run: RunRecord): IssueBinding {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]{0,15})$/u.exec(
    run.upstreamIssue
  );
  if (!match) throw new HandoffError('invalid_binding');
  return issueBinding({ upstream: { owner: match[1], repo: match[2] }, issue: Number(match[3]) });
}

function sameRepo(a: IssueBinding['upstream'], b: IssueBinding['upstream']): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/** Re-derive the bound target from the run; a journal or caller cannot redirect it. */
function bindingFor(
  run: RunRecord,
  input: IntentInput,
  binding: unknown
): PrBinding | IssueBinding {
  const issue = upstreamIssue(run);
  if (input.operationKind === 'engagement_comment') {
    const b = issueBinding(binding);
    if (!sameRepo(b.upstream, issue.upstream) || b.issue !== issue.issue)
      throw new HandoffError('invalid_binding');
    return b;
  }
  const b = prBinding(binding);
  if (
    !sameRepo(b.upstream, issue.upstream) ||
    b.headOwner.toLowerCase() !== run.contributor.toLowerCase()
  )
    throw new HandoffError('invalid_binding');
  return b;
}

function digestOf(body: string): string {
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

/** The journaled link must be exactly the one the binding, title and body produce. */
function sameLink(
  input: IntentInput,
  binding: PrBinding | IssueBinding,
  raw: Record<string, unknown>
): boolean {
  if (input.operationKind === 'engagement_comment')
    return (
      raw.title === undefined &&
      raw.linkKind === 'body_file' &&
      raw.link === issueUrl(binding as IssueBinding)
    );
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string') return false;
  const expected = formatCompareLink(binding as PrBinding, raw.title, raw.body);
  return raw.link === expected.url && raw.linkKind === expected.kind;
}

/** Hand-off edges are recorded only by this driver's own events. */
const HANDOFF_REASONS: readonly ReasonCode[] = [
  ReasonCode.ContributorHandoff,
  ReasonCode.PublicationObserved,
  ReasonCode.EngagementObserved,
];

function observedReason(operation: HandoffOperation): ReasonCode {
  return operation === 'pr_create' ? ReasonCode.PublicationObserved : ReasonCode.EngagementObserved;
}

function pendingOf(state: HandoffState): HandoffRecord | undefined {
  return [...state.handoffs.values()].find((record) => record.status === 'link_issued');
}

function reduce(state: HandoffState | undefined, raw: unknown): HandoffState {
  if (!isRecord(raw) || raw.v !== 1) fail();
  if (raw.type === 'handoff_run') {
    if (state || typeof raw.contributionId !== 'string') fail();
    return { run: restoreRun(raw.run), contributionId: raw.contributionId, handoffs: new Map() };
  }
  if (!state) fail();
  if (raw.type === 'handoff_run_update') {
    const run = continuation(state.run, raw.run);
    // While a link is pending, the lifecycle may only fail/cancel, never observe or re-issue.
    if (
      pendingOf(state) &&
      run.history
        .slice(state.run.history.length)
        .some((entry) => HANDOFF_REASONS.includes(entry.reasonCode))
    )
      fail();
    return { ...state, run };
  }
  const handoffs = new Map(state.handoffs);
  const run = restoreRun(raw.run);
  if (raw.type === 'link_issued') {
    const input = raw.input as IntentInput;
    const intentId = handoffIntentId(input);
    const operationKind = input.operationKind as HandoffOperation;
    const key = idempotencyKey(input);
    const binding = bindingFor(state.run, input, raw.binding);
    if (
      input.contributionId !== state.contributionId ||
      handoffs.has(key) ||
      pendingOf(state) ||
      (operationKind === 'engagement_comment' &&
        [...handoffs.values()].some((r) => r.input.operationKind === 'engagement_comment')) ||
      state.run.state !== (operationKind === 'pr_create' ? 'shipping' : 'gating') ||
      typeof raw.body !== 'string' ||
      raw.bodyDigest !== digestOf(raw.body) ||
      typeof raw.bodyFile !== 'string' ||
      !path.isAbsolute(raw.bodyFile) ||
      path.basename(raw.bodyFile) !== `${intentId}.md` ||
      !sameLink(input, binding, raw) ||
      !sameRun(run, transitionRun(state.run, ReasonCode.ContributorHandoff, run.updatedAt))
    )
      fail();
    assertNoSecrets(raw.link as string);
    handoffs.set(
      key,
      Object.freeze({
        key,
        intentId,
        input: Object.freeze({ ...input, operationKind }),
        binding,
        link: raw.link as string,
        linkKind: raw.linkKind as PreparedLink['kind'],
        ...(raw.title === undefined ? {} : { title: raw.title as string }),
        bodyFile: raw.bodyFile,
        bodyDigest: raw.bodyDigest,
        status: 'link_issued',
        issuedAt: run.updatedAt,
      })
    );
    return { ...state, run, handoffs };
  }
  const record = typeof raw.key === 'string' ? handoffs.get(raw.key) : undefined;
  if (!record || record.status !== 'link_issued') fail();
  if (raw.type === 'handoff_observed') {
    const repo = `https://github.com/${record.binding.upstream.owner}/${record.binding.upstream.repo}`;
    const isPr = record.input.operationKind === 'pr_create';
    const expectedRef = isPr
      ? `${repo}/pull/${raw.number}`
      : `${repo}/issues/${(record.binding as IssueBinding).issue}#issuecomment-`;
    if (
      typeof raw.artifactRef !== 'string' ||
      (isPr
        ? !Number.isSafeInteger(raw.number) ||
          (raw.number as number) < 1 ||
          raw.headSha !== record.input.candidateSha ||
          !['open', 'closed', 'merged'].includes(raw.prState as string) ||
          raw.artifactRef.toLowerCase() !== expectedRef.toLowerCase()
        : raw.number !== undefined ||
          raw.headSha !== undefined ||
          raw.prState !== undefined ||
          !raw.artifactRef.toLowerCase().startsWith(expectedRef.toLowerCase()) ||
          !/^[1-9][0-9]*$/u.test(raw.artifactRef.slice(expectedRef.length))) ||
      !sameRun(
        run,
        transitionRun(state.run, observedReason(record.input.operationKind), run.updatedAt)
      )
    )
      fail();
    handoffs.set(
      record.key,
      Object.freeze({
        ...record,
        status: 'observed',
        artifactRef: raw.artifactRef,
        ...(isPr
          ? {
              number: raw.number as number,
              headSha: raw.headSha as string,
              prState: raw.prState as PrState,
            }
          : {}),
      })
    );
    return { ...state, run, handoffs };
  }
  if (raw.type === 'handoff_blocked') {
    if (
      !HANDOFF_BLOCK_REASONS.includes(raw.reason as HandoffBlockReason) ||
      !sameRun(run, transitionRun(state.run, ReasonCode.PolicyBlocked, run.updatedAt))
    )
      fail();
    handoffs.set(
      record.key,
      Object.freeze({ ...record, status: 'blocked', reason: raw.reason as HandoffBlockReason })
    );
    return { ...state, run, handoffs };
  }
  return fail();
}

export function replayHandoffs(events: readonly unknown[]): HandoffState {
  let state: HandoffState | undefined;
  for (const event of events) if (!isRecoveryEvent(event)) state = reduce(state, event);
  if (!state) fail();
  return state;
}

export function handoffStatus(state: HandoffState): HandoffStatus | null {
  const record = pendingOf(state);
  if (!record || state.run.state !== 'awaiting_contributor') return null;
  const author = state.run.contributor;
  const keepMarker =
    'Keep the hidden ai-dossier marker line; it is how the run finds the submission.';
  const paste =
    record.linkKind === 'body_file'
      ? ` Paste the prepared body from ${record.bodyFile} before submitting.`
      : '';
  let submits: string;
  let action: string;
  if (record.input.operationKind === 'pr_create') {
    const b = record.binding as PrBinding;
    submits = `Pull request to ${b.upstream.owner}/${b.upstream.repo}:${b.base} from ${b.headOwner}:${b.branch} at ${record.input.candidateSha}`;
    action = `Review the prefilled pull request at the link and submit it from your own account (${author}), as its author.${paste} ${keepMarker} Then resume the run.`;
  } else {
    const b = record.binding as IssueBinding;
    submits = `Comment on ${b.upstream.owner}/${b.upstream.repo}#${b.issue} asking to work on the issue`;
    action = `Open the issue at the link, review the prepared request, and post it from your own account (${author}), as its author.${paste} ${keepMarker} Then resume the run.`;
  }
  return Object.freeze({
    state: 'awaiting_contributor',
    operation: record.input.operationKind,
    link: record.link,
    linkKind: record.linkKind,
    submits,
    ...(record.title === undefined ? {} : { title: record.title }),
    bodyFile: record.bodyFile,
    bodyDigest: record.bodyDigest,
    author,
    nextPermittedAction: action,
  });
}

/** Quoted values keep untrusted text from spoofing status lines. */
export function renderHandoffStatus(status: HandoffStatus): string {
  return Object.entries(status)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

const drivenJournals = new WeakSet<Journal>();

/** Serial controller driver; the journal directory is controller-owned, never worker storage. */
export class HandoffDriver {
  private state: HandoffState;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journal: Journal,
    private readonly deps: HandoffDeps,
    initial: { run: RunRecord; contributionId: string }
  ) {
    if (drivenJournals.has(journal)) throw new HandoffError('journal_in_use');
    const events = journal.read().filter((event) => !isRecoveryEvent(event));
    if (!events.length) {
      const event: Event = {
        v: 1,
        type: 'handoff_run',
        run: restoreRun(initial.run),
        contributionId: initial.contributionId,
      };
      this.state = reduce(undefined, event);
      journal.append(event);
    } else {
      this.state = replayHandoffs(events);
      if (this.state.contributionId !== initial.contributionId) fail();
      const directory = path.resolve(deps.bodyDirectory);
      for (const record of this.state.handoffs.values())
        if (path.dirname(record.bodyFile) !== directory) fail();
      this.observeRun(initial.run);
    }
    drivenJournals.add(journal);
  }

  snapshot(): HandoffState {
    return { ...this.state, handoffs: new Map(this.state.handoffs) };
  }

  status(): HandoffStatus | null {
    return handoffStatus(this.state);
  }

  /** Record lifecycle progress made elsewhere by the controller. */
  observeRun(value: RunRecord): void {
    const run = continuation(this.state.run, value);
    if (run.history.length !== this.state.run.history.length)
      this.persist({ v: 1, type: 'handoff_run_update', run });
  }

  private persist(event: Event): void {
    const next = reduce(this.state, event);
    this.journal.append(event);
    this.state = next;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  /** Resume reconciles before anything else; it never issues a new link. */
  resume(): Promise<HandoffOutcome | null> {
    return this.serial(async () => {
      const pending = pendingOf(this.state);
      return pending && this.state.run.state === 'awaiting_contributor'
        ? this.reconcile(pending)
        : null;
    });
  }

  /** Prefilled pull request for the verified, pushed candidate. */
  issuePr(request: { binding: PrBinding; content: PrContentInput }): Promise<HandoffOutcome> {
    return this.serial(async () => {
      const intent = request.content?.intent;
      const prior = await this.reconcileFirst(intent);
      if (prior) return prior;
      const binding = bindingFor(this.state.run, intent, request.binding) as PrBinding;
      const sha = intent.candidateSha;
      if (intent.operationKind !== 'pr_create' || sha === null)
        throw new HandoffError('not_a_handoff');
      if (this.state.run.state !== 'shipping') throw new HandoffError('admission_state');
      // The driver renders the content itself: the receipt it checks is the one in the body.
      const content = buildPrContent(request.content);
      const digest = receiptDigest(parseReceipt(request.content.receipt));
      const { admission } = this.deps;
      await this.check('policy', () => admission.policyFresh());
      await this.check('contributor', () => admission.contributorVerified());
      await this.check('fork_binding', () => admission.forkBindingVerified());
      await this.check('receipt', () => admission.receiptValid(sha, digest));
      await this.check('remote_sha', async () => (await admission.remoteBranchSha()) === sha);
      // Never issue while any PR exists on this head/base, in any state.
      const existing = await reconcilePr(this.deps.read, binding, {
        marker: handoffMarker(intent),
        contributor: this.state.run.contributor,
        candidateSha: sha,
      });
      if (existing.kind === 'unknown') throw new HandoffError('reconciliation_unavailable');
      if (existing.kind !== 'absent') throw new HandoffError('existing_submission');
      const { title, body, commands } = content;
      const link = compareLink(intent, binding, title, body, commands);
      return this.issue(intent, binding, link);
    });
  }

  /** At most one disclosed engagement request per contribution (scenario 2). */
  issueEngagement(request: {
    intent: IntentInput;
    binding: IssueBinding;
    body: string;
  }): Promise<HandoffOutcome> {
    return this.serial(async () => {
      const prior = await this.reconcileFirst(request.intent);
      if (prior) return prior;
      const { intent } = request;
      const binding = bindingFor(this.state.run, intent, request.binding) as IssueBinding;
      if (intent.operationKind !== 'engagement_comment') throw new HandoffError('not_a_handoff');
      if (this.state.run.state !== 'gating') throw new HandoffError('admission_state');
      const { admission } = this.deps;
      await this.check('policy', () => admission.policyFresh());
      await this.check('contributor', () => admission.contributorVerified());
      const existing = await reconcileComment(this.deps.read, binding, {
        marker: handoffMarker(intent),
        contributor: this.state.run.contributor,
      });
      if (existing.kind === 'unknown') throw new HandoffError('reconciliation_unavailable');
      if (existing.kind !== 'absent') throw new HandoffError('existing_submission');
      return this.issue(intent, binding, issueCommentLink(intent, binding, request.body));
    });
  }

  /** A pending hand-off or an earlier request for the same intent wins over a new link. */
  private async reconcileFirst(intent: IntentInput): Promise<HandoffOutcome | null> {
    if (intent?.contributionId !== this.state.contributionId)
      throw new HandoffError('invalid_contribution');
    const pending = pendingOf(this.state);
    if (pending) {
      if (this.state.run.state !== 'awaiting_contributor')
        throw new HandoffError('admission_state');
      return this.reconcile(pending);
    }
    const id = handoffIntentId(intent);
    const earlier = [...this.state.handoffs.values()].find(
      (r) =>
        r.intentId === id ||
        (intent.operationKind === 'engagement_comment' &&
          r.input.operationKind === 'engagement_comment')
    );
    if (!earlier) return null;
    return earlier.status === 'blocked'
      ? { kind: 'blocked', reason: earlier.reason as HandoffBlockReason }
      : {
          kind: 'observed',
          operation: earlier.input.operationKind,
          url: earlier.artifactRef as string,
          ...(earlier.prState === undefined
            ? {}
            : { prState: earlier.prState, number: earlier.number, headSha: earlier.headSha }),
          ci: 'unknown',
        };
  }

  private async check(name: string, probe: () => Promise<boolean>): Promise<void> {
    let ok = false;
    try {
      ok = (await probe()) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new HandoffError(`admission_${name}`);
  }

  private issue(
    intent: IntentInput,
    binding: PrBinding | IssueBinding,
    link: PreparedLink
  ): HandoffOutcome {
    const directory = path.resolve(this.deps.bodyDirectory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bodyFile = path.join(directory, `${handoffIntentId(intent)}.md`);
    const bytes = Buffer.from(link.body, 'utf8');
    // Write-ahead: the body exists before the journal makes the link visible.
    replacePrivate(bodyFile, bytes);
    const run = transitionRun(this.state.run, ReasonCode.ContributorHandoff, this.deps.now());
    this.persist({
      v: 1,
      type: 'link_issued',
      input: intent,
      binding,
      link: link.url,
      linkKind: link.kind,
      ...(link.title === undefined ? {} : { title: link.title }),
      body: link.body,
      bodyFile,
      bodyDigest: digestOf(link.body),
      run,
    });
    return {
      kind: 'awaiting_contributor',
      status: this.status() as HandoffStatus,
      reconciliation: 'not_checked',
    };
  }

  private block(record: HandoffRecord, reason: HandoffBlockReason): HandoffOutcome {
    const run = transitionRun(this.state.run, ReasonCode.PolicyBlocked, this.deps.now());
    this.persist({ v: 1, type: 'handoff_blocked', key: record.key, reason, run });
    return { kind: 'blocked', reason };
  }

  private async reconcile(record: HandoffRecord): Promise<HandoffOutcome> {
    const contributor = this.state.run.contributor;
    const marker = handoffMarker(record.input);
    let url: string;
    let ci: 'pending' | 'unknown' = 'unknown';
    let pr: { prState: PrState; number: number; headSha: string } | undefined;
    if (record.input.operationKind === 'pr_create') {
      const observed = await reconcilePr(this.deps.read, record.binding as PrBinding, {
        marker,
        contributor,
        candidateSha: record.input.candidateSha as string,
        issuedAt: record.issuedAt,
      });
      if (observed.kind === 'ambiguous') return this.waiting('ambiguous', observed.reason);
      if (observed.kind === 'head_mismatch') return this.block(record, 'unexpected_head_sha');
      if (observed.kind !== 'found') return this.waiting(observed.kind);
      url = observed.url;
      pr = {
        prState: observed.merged ? 'merged' : observed.state,
        number: observed.number,
        headSha: observed.headSha,
      };
      if (pr.prState === 'open') ci = 'pending';
    } else {
      const observed = await reconcileComment(this.deps.read, record.binding as IssueBinding, {
        marker,
        contributor,
        since: record.issuedAt,
      });
      if (observed.kind === 'ambiguous') return this.waiting('ambiguous', observed.reason);
      if (observed.kind !== 'found') return this.waiting(observed.kind);
      url = observed.url;
    }
    const run = transitionRun(
      this.state.run,
      observedReason(record.input.operationKind),
      this.deps.now()
    );
    this.persist({
      v: 1,
      type: 'handoff_observed',
      key: record.key,
      artifactRef: url,
      ...pr,
      run,
    });
    return { kind: 'observed', operation: record.input.operationKind, url, ...pr, ci };
  }

  private waiting(
    reconciliation: 'absent' | 'unknown' | 'ambiguous',
    ambiguity?: AmbiguityReason
  ): HandoffOutcome {
    const status = this.status() as HandoffStatus;
    if (reconciliation !== 'ambiguous')
      return { kind: 'awaiting_contributor', status, reconciliation };
    // Hand-off: no new link, nothing recorded; a person resolves it, then resumes.
    return {
      kind: 'awaiting_contributor',
      status: Object.freeze({
        ...status,
        nextPermittedAction:
          'The run cannot tell which submission is yours: more than one matches, one lacks the ' +
          'hidden marker, another account posted it, or the fork no longer resolves. Close or ' +
          'fix the extra or unmarked submission so exactly one marked one remains, then resume. ' +
          'No new link will be issued.',
      }),
      reconciliation,
      ambiguity: ambiguity as AmbiguityReason,
    };
  }
}
