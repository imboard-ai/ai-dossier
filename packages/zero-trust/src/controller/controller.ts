/** Credential-free orchestration. Injected steps own durable effect reconciliation. */
import path from 'node:path';
import { type BudgetLedger, isBudgetSessionExhausted } from '../budget';
import type { BudgetEstimate, BudgetObservation, BudgetReservation } from '../budget-types';
import { readPrivate } from '../durable-fs';
import { applyVerification } from '../ecosystem/classify';
import { WITHDRAWAL_REASONS, type WithdrawalReason } from '../github/track';
import { isGitHubLogin } from '../github-login';
import { Journal } from '../journal';
import { canonicalJson } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import {
  isRecord,
  isRunContinuation,
  isTrackerPhase,
  ReasonCode,
  type RunRecord,
  type RunState,
  restoreRun,
  revisionCount,
  sameRunRecord,
  TERMINAL_STATES,
  TRACKING_STATES,
  transitionRun,
} from '../state';
import type { VmAdapter, VmHandle, VmSpec } from '../vm/adapter';
import { type TeardownOutcome, teardownVm } from '../vm/teardown';
import { AuthorApprovalError } from './author-approval';
import {
  type CheckpointBindings,
  type CheckpointPoint,
  checkpointBindings,
  checkpointDue,
  pauseAtCheckpoint,
} from './checkpoints';
import type { RunConfig } from './config';
import {
  acknowledgeControl,
  type ControlRequest,
  controlRefusal,
  readControlRequests,
  requestControl,
} from './control';
import { latestSourceEdit, sourceEditCount } from './edits';
import {
  nextPublicationWait,
  type OpenPublicationWait,
  openWaitUntil,
  publicationWaitTime,
} from './lifecycle-times';
import { RunStore } from './run-store';
import { assembleStatus } from './status';
import { loadVerification, type VerificationRecord } from './verification-record';

export type PhaseStop =
  | { readonly kind: 'hand_off' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'cancelled' };
export type GateOutcome =
  | PhaseStop
  | {
      readonly kind:
        | 'proceed'
        | 'request_permission'
        | 'contributor_handoff'
        | 'fork_missing'
        | 'installation_missing'
        | 'terminate'
        | 'ineligible';
    };
export type AcquireOutcome = PhaseStop | { readonly kind: 'acquired' };
export type PlanOutcome =
  | PhaseStop
  | {
      readonly kind: 'planned';
      readonly bindings: CheckpointBindings & { readonly planDigest: string };
    };
export type ImplementOutcome =
  | PhaseStop
  | {
      readonly kind: 'candidate';
      readonly bindings: CheckpointBindings & { readonly candidateSha: string };
    };
export type ReviewOutcome = PhaseStop | { readonly kind: 'approved' };
export type VerifyOutcome =
  | PhaseStop
  | { readonly kind: 'verified'; readonly record: VerificationRecord };
export type DriftOutcome =
  | PhaseStop
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'advanced';
      readonly bindings: CheckpointBindings & { readonly candidateSha: string };
    };
export type ShipOutcome =
  | PhaseStop
  | {
      readonly kind:
        | 'submitted'
        | 'contributor_handoff'
        | 'fork_missing'
        | 'installation_missing'
        | 'waiting';
    };
export type ResumeHandoffOutcome =
  | PhaseStop
  | {
      readonly kind:
        | 'waiting'
        | 'invited'
        | 'engagement_observed'
        | 'submitted'
        | 'resume_gating'
        | 'resume_shipping'
        | 'declined';
    };
export type ControllerTrackOutcome =
  | PhaseStop
  | {
      readonly kind:
        | 'waiting'
        | 'awaiting_review'
        | 'accepted'
        | 'merged'
        | 'declined'
        | 'revision';
    };

export interface PhaseContext {
  /** The operator explicitly requested a revision (`resume --revise`). */
  readonly revise: boolean;
  /** Logins the operator named (`resume --reviewers`) whose PR remarks count as maintainer
   * feedback although GitHub does not show them as maintainers to this run (#1198). */
  readonly reviewers: readonly string[];
  readonly observeRun: (run: RunRecord) => Promise<void>;
  readonly store: RunStore;
  readonly run: RunRecord;
  readonly ledger: BudgetLedger;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly assertAdmission: () => void;
  /** Acquire must reuse durable source/effects but provision fresh ephemeral resources. */
  readonly replayingAcquisition: boolean;
  /** The only allocation path supplied to steps; reservation precedes create. */
  readonly createVm: (spec: Omit<VmSpec, 'runId' | 'limits'>) => Promise<VmHandle>;
}
export interface PhaseSteps {
  gate(context: PhaseContext): Promise<GateOutcome>;
  acquire(context: PhaseContext): Promise<AcquireOutcome>;
  plan(context: PhaseContext): Promise<PlanOutcome>;
  implement(context: PhaseContext): Promise<ImplementOutcome>;
  review(context: PhaseContext): Promise<ReviewOutcome>;
  verify(context: PhaseContext): Promise<VerifyOutcome>;
  drift(context: PhaseContext): Promise<DriftOutcome>;
  ship(context: PhaseContext): Promise<ShipOutcome>;
  resumeHandoff(context: PhaseContext): Promise<ResumeHandoffOutcome>;
  track(context: PhaseContext): Promise<ControllerTrackOutcome>;
}
export interface ObservingDriver {
  observeRun(run: RunRecord): void;
}
/** Structural interfaces deliberately avoid even type imports from credential modules. */
export interface RecoveryHooks {
  /** True while a pushed revision awaits read-back; resume then only observes. */
  revisionWaiting?(context: PhaseContext): boolean;
  openStore(root: string, runId: string): RunStore;
  openBudget(store: RunStore): BudgetLedger;
  reconcileHold(hold: BudgetReservation, context: PhaseContext): Promise<BudgetObservation | null>;
  /** Explicit accounting/no-charge evidence for previously unfunded destruction.
   * Wiring reconciles the actual charge in the ledger before returning evidence. */
  reconcileCleanup?(vmId: string, context: PhaseContext): Promise<string | null>;
  reconcileVms(context: PhaseContext, cleanup: () => Promise<void>): Promise<void>;
  recoverCredentials(context: PhaseContext): Promise<void>;
  /** Reconcile old credential obligations without identity acquisition or OAuth. */
  cleanupCredentials?(context: PhaseContext): Promise<void>;
  resumeIntents(context: PhaseContext): Promise<undefined | RunRecord>;
  /** Replay/reconcile existing effects only; fresh invitation checks belong to PhaseSteps. */
  resumeHandoff(context: PhaseContext): Promise<undefined | RunRecord>;
  /** Replay/reconcile existing effects only; fresh tracker observations belong to PhaseSteps. */
  resumeTracker(context: PhaseContext): Promise<undefined | RunRecord>;
  killAll(context: PhaseContext): Promise<void>;
  /** Per-run cancellation, distinct from the root-wide incident kill switch. */
  endRun?(context: PhaseContext, reason?: 'completed' | 'cancelled'): Promise<void>;
  reconcileControl?(
    context: PhaseContext,
    kind: 'pause' | 'cancel'
  ): Promise<undefined | RunRecord>;
  prepareCancellation?(context: PhaseContext): Promise<void>;
}
export interface ControllerDependencies {
  /** Persist admission refusals through the composed run artifact store; null retires only
   * this controller's prior refusal. Persistence failures must propagate. */
  readonly recordControllerStop?: (
    context: PhaseContext,
    reason: import('./stop-notice').ControllerRefusalReason | null,
    transitionPending: boolean
  ) => void | Promise<void>;
  readonly trackerAction?: (
    context: PhaseContext,
    request: TrackerActionRequest
  ) => Promise<TrackerActionResult>;
  /** Stop-only external fence. It can revoke admission, never grant authority. */
  readonly incidentRequested?: () => boolean;
  /** Release run-owned journals/credential leases before the RunStore pins close. */
  readonly release?: () => Promise<void>;
  /** Retire driver resources only after late control cleanup/reconciliation joins. */
  readonly retire?: () => void;
  readonly root: string;
  readonly steps: PhaseSteps;
  readonly recovery: RecoveryHooks;
  readonly drivers: readonly ObservingDriver[];
  readonly vm: Pick<VmAdapter, 'create' | 'destroy' | 'listByRun'>;
  readonly estimateVm: (spec: VmSpec, purpose: 'work' | 'teardown') => BudgetEstimate;
  /** null retains an unknown hold; estimates are never invented observations. */
  readonly observeVm: (
    hold: BudgetReservation,
    vm: Pick<VmHandle, 'vmId' | 'runId'>
  ) => Promise<BudgetObservation | null>;
  readonly now: () => Date;
}
export type TrackerActionRequest =
  | { readonly kind: 'edit'; readonly title: string; readonly body: string }
  | {
      readonly kind: 'withdraw';
      readonly reason: WithdrawalReason;
      readonly explanation: string;
    }
  | { readonly kind: 'cancel-action' };
export interface TrackerActionResult {
  readonly kind: 'edit' | 'withdraw' | 'reopen' | 'cancel-action';
  readonly link: string;
  readonly instructions: string;
  readonly title?: string;
  readonly bodyFile?: string;
}
export class ControllerError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'not_running'
      | 'invalid_outcome'
      | 'revision_unavailable'
      | 'invalid_reviewer'
      | 'invalid_journal'
      | 'step_failed'
      | 'admission_closed'
      | 'driver_failed'
      | 'recovery_failed',
    readonly diagnostic?: {
      readonly phase: keyof PhaseSteps | 'recovery';
      readonly code:
        | 'producer_unavailable'
        | 'contributor_authorization_unavailable'
        | 'invalid_step_artifact'
        | 'missing_step_artifact';
    }
  ) {
    super(`Run controller refused (${code})`);
    this.name = 'ControllerError';
  }
}
type PhaseName = keyof PhaseSteps;
type Outcome = Awaited<ReturnType<PhaseSteps[PhaseName]>>;
const KINDS: Record<PhaseName, readonly string[]> = {
  gate: [
    'proceed',
    'request_permission',
    'contributor_handoff',
    'fork_missing',
    'installation_missing',
    'terminate',
    'ineligible',
  ],
  acquire: ['acquired'],
  plan: ['planned'],
  implement: ['candidate'],
  review: ['approved'],
  verify: ['verified'],
  drift: ['unchanged', 'advanced'],
  ship: ['submitted', 'contributor_handoff', 'fork_missing', 'installation_missing', 'waiting'],
  resumeHandoff: [
    'waiting',
    'invited',
    'engagement_observed',
    'submitted',
    'resume_gating',
    'resume_shipping',
    'declined',
  ],
  track: ['waiting', 'awaiting_review', 'accepted', 'merged', 'declined', 'revision'],
};
const STOP_REASONS: Record<Exclude<PhaseStop['kind'], 'hand_off'>, ReasonCode> = {
  blocked: ReasonCode.PolicyBlocked,
  unsupported: ReasonCode.UnsupportedEnvironment,
  failed: ReasonCode.ExecutionFailed,
  cancelled: ReasonCode.UserCancelled,
};
const REASONS: Partial<Record<Outcome['kind'], ReasonCode>> = {
  proceed: ReasonCode.GatePassed,
  request_permission: ReasonCode.PermissionRequired,
  terminate: ReasonCode.PolicyBlocked,
  ineligible: ReasonCode.PolicyBlocked,
  planned: ReasonCode.PlanApproved,
  candidate: ReasonCode.CandidateReady,
  advanced: ReasonCode.BaseAdvanced,
  submitted: ReasonCode.PublicationObserved,
  contributor_handoff: ReasonCode.ContributorHandoff,
  fork_missing: ReasonCode.ForkMissing,
  installation_missing: ReasonCode.InstallationMissing,
  invited: ReasonCode.MaintainerInvited,
  engagement_observed: ReasonCode.EngagementObserved,
  resume_gating: ReasonCode.ResumeGating,
  resume_shipping: ReasonCode.ResumeShipping,
  declined: ReasonCode.UpstreamDeclined,
  awaiting_review: ReasonCode.ReviewAwaited,
  accepted: ReasonCode.UpstreamAccepted,
  merged: ReasonCode.ObservedUpstreamMerge,
  revision: ReasonCode.RevisionRequested,
  ...STOP_REASONS,
};
/** Tracker and hand-off outcomes that re-observe an already recorded state: when the run already carries
 * the same reason, a repeat observation must not append a duplicate transition. */
const IDEMPOTENT_TRACK_OUTCOMES: readonly Outcome['kind'][] = [
  'contributor_handoff',
  'engagement_observed',
  'revision',
  'submitted',
  'merged',
  'declined',
  'awaiting_review',
  'blocked',
];
const ACTION_KEYS: Record<TrackerActionRequest['kind'], readonly string[]> = {
  edit: ['body', 'kind', 'title'],
  withdraw: ['explanation', 'kind', 'reason'],
  'cancel-action': ['kind'],
};
/** A contributor action is a closed shape; anything else is refused before any effect. */
function assertTrackerAction(action: TrackerActionRequest): void {
  assertSecretFree(action);
  const keys = Object.hasOwn(ACTION_KEYS, action.kind) ? ACTION_KEYS[action.kind] : undefined;
  if (
    !keys ||
    Object.keys(action).sort().join(',') !== keys.join(',') ||
    (action.kind === 'edit' &&
      (typeof action.title !== 'string' || typeof action.body !== 'string')) ||
    (action.kind === 'withdraw' &&
      (!WITHDRAWAL_REASONS.includes(action.reason) || typeof action.explanation !== 'string'))
  )
    throw new ControllerError('invalid_outcome');
}
function stopped(state: RunState): boolean {
  return (
    state.startsWith('awaiting_') ||
    ['paused_user', 'submitted', 'accepted', 'blocked_cleanup'].includes(state) ||
    TERMINAL_STATES.includes(state)
  );
}
function outcome(phase: PhaseName, input: unknown): Outcome {
  assertSecretFree(input);
  if (
    !isRecord(input) ||
    typeof input.kind !== 'string' ||
    ![...KINDS[phase], 'hand_off', ...Object.keys(STOP_REASONS)].includes(input.kind)
  )
    throw new ControllerError('invalid_outcome');
  const extra =
    input.kind === 'verified'
      ? 'record'
      : ['planned', 'candidate', 'advanced'].includes(input.kind)
        ? 'bindings'
        : undefined;
  if (
    Object.keys(input).some((key) => key !== 'kind' && key !== extra) ||
    (extra && !isRecord(input[extra]))
  )
    throw new ControllerError('invalid_outcome');
  return structuredClone(input) as unknown as Outcome;
}

export class RunController {
  private store?: RunStore;
  private ledger?: BudgetLedger;
  private journal?: Journal;
  private abort = new AbortController();
  private running?: Promise<RunRecord>;
  private incident = false;
  private incidentKill?: Promise<void>;
  private recovering = false;
  private oldHolds = new Set<string>();
  private unfundedCleanup = new Set<string>();
  private operation = Symbol();
  private phaseLease?: symbol;
  private replayingAcquisition = false;
  private needsAcquisition = false;
  private cached = new Map<string, Outcome>();
  private last?: RunRecord;
  private control?: ControlRequest | 'invalid' | 'interrupt';
  private interruptRequested = false;
  private controlApplied = false;
  private finalizationFailed = false;
  private controlCleanup?: Promise<void>;
  private controlReconciled?: Promise<void>;
  private controlReconciledKind?: 'pause' | 'cancel';
  /** The operator passed `--revise`: this invocation may admit a new revision. */
  private revise = false;
  private reviewers: readonly string[] = [];
  private actionResult?: TrackerActionResult;
  private publicationWait?: OpenPublicationWait;
  private controllerStopReason?: import('./stop-notice').ControllerRefusalReason;
  constructor(private readonly deps: ControllerDependencies) {}
  snapshot(): RunRecord {
    if (!this.last) throw new ControllerError('not_running');
    return this.last;
  }
  /** Process termination is a pause, not cancellation. Join the invocation through
   * release so broker-held credentials are swept before its owner exits. */
  async interrupt(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.interruptRequested = true;
    this.observeControl();
    try {
      await running;
    } catch (error) {
      // A pre-interrupt phase error is still returned to its caller, but is not a
      // cleanup failure when the finalizer independently completed the stop.
      if (
        this.finalizationFailed ||
        !this.controlApplied ||
        !this.last ||
        this.last.state === 'blocked_cleanup'
      )
        throw error;
    }
    if (this.last?.state === 'blocked_cleanup') throw new ControllerError('admission_closed');
  }
  start(config: RunConfig): Promise<RunRecord> {
    return this.launch(async () => {
      this.store = RunStore.create(this.deps.root, config, this.deps.now());
      this.ledger = this.deps.recovery.openBudget(this.store);
      this.ledger.initialize([], this.store.config.modelProfile.rates);
      this.ledger.startSession(this.sessionInput(1));
      this.openJournal(false);
      this.notify(this.store.run);
      return this.loop(false);
    });
  }
  resume(
    runId: string,
    options: {
      readonly revise?: boolean;
      readonly reviewers?: readonly string[];
      readonly action?: TrackerActionRequest;
    } = {}
  ): Promise<RunRecord> {
    const revise = options.revise === true;
    const reviewers = Object.freeze([...(options.reviewers ?? [])]);
    if (reviewers.some((login) => !isGitHubLogin(login)))
      throw new ControllerError('invalid_reviewer');
    const action = options.action ? structuredClone(options.action) : undefined;
    if (action) assertTrackerAction(action);
    return this.launch(async () => {
      this.revise = revise;
      this.reviewers = reviewers;
      this.store = this.deps.recovery.openStore(this.deps.root, runId);
      // Only a published PR (or a revision already in progress) can be revised.
      if (revise && !isTrackerPhase(this.store.run))
        throw new ControllerError('revision_unavailable');
      this.recovering = true;
      this.ledger = this.deps.recovery.openBudget(this.store);
      for (const hold of this.ledger
        .snapshot()
        .reservations.filter((row) => row.status === 'reserved')) {
        this.oldHolds.add(hold.id);
        this.ledger.settle(
          hold.id,
          await this.recover(() => this.deps.recovery.reconcileHold(hold, this.context()))
        );
      }
      this.openJournal(true);
      this.observeControl();
      if (this.control) return this.applyControl();
      await this.reconcileCleanupObligations();
      const failures: unknown[] = [];
      try {
        this.notify(this.store.run);
      } catch (error) {
        failures.push(error);
      }
      await this.attemptRecovery(
        () => this.deps.recovery.reconcileVms(this.context(), () => this.cleanup()),
        failures
      );
      // A wrapper cannot bypass actual listByRun/teardown reconciliation.
      await this.attemptRecovery(() => this.cleanup(), failures);
      const beforeTracker = await this.reconcileTracker(failures);
      await this.attemptRecovery(
        () => this.deps.recovery.cleanupCredentials?.(this.context()) ?? Promise.resolve(),
        failures
      );
      this.observeControl();
      this.observeIncident();
      if (this.control) return this.applyControl();
      // A completed publication or unresolved read-back is observation only.
      // Never require credentials, work budget or source reacquisition to confirm it.
      if (
        !this.incident &&
        !failures.length &&
        beforeTracker === 'shipping' &&
        this.store.run.state === 'submitted' &&
        !action
      ) {
        this.ensureRevisionSession();
        return this.store.run;
      }
      // An unconfirmed revision push is observation only: no new work until it is read back.
      const revisionWaiting =
        !action && this.deps.recovery.revisionWaiting?.(this.context()) === true;
      if (!this.incident && !failures.length && revisionWaiting) return this.store.run;
      if (!this.incident && !failures.length && action) {
        this.ensureRevisionSession();
        this.recovering = false;
        return this.performAction(action);
      }
      if (!action && !revisionWaiting) this.finishPublicationWait();
      this.observeIncident();
      if (!this.incident)
        await this.attemptRecovery(
          () => this.deps.recovery.recoverCredentials(this.context()),
          failures
        );
      if (this.incident)
        await this.attemptRecovery(() => this.deps.recovery.killAll(this.context()), failures);
      if (this.incident) return this.cancel();
      this.observeControl();
      if (this.control) return this.applyControl();
      if (failures.length) throw failures[0];
      await this.recovered(
        await this.recover(() => this.deps.recovery.resumeIntents(this.context()))
      );
      if (['awaiting_contributor', 'awaiting_maintainer'].includes(this.store.run.state))
        await this.recovered(
          await this.recover(() => this.deps.recovery.resumeHandoff(this.context()))
        );
      this.observeControl();
      if (this.control) return this.applyControl();
      this.ensureRevisionSession();
      this.recovering = false;
      this.needsAcquisition = true;
      await this.leaveUserPause();
      return this.loop(true);
    });
  }
  /** Reconcile the PR tracker's own effects when it owns the run; returns the state the
   * run was in before, which decides whether resume is observation only. */
  private async reconcileTracker(failures: unknown[]): Promise<RunState> {
    const before = this.held.run.state;
    if (
      !this.control &&
      !this.incident &&
      isTrackerPhase(this.held.run) &&
      !TERMINAL_STATES.includes(before) &&
      before !== 'blocked_cleanup'
    )
      await this.attemptRecovery(
        async () => this.recovered(await this.deps.recovery.resumeTracker(this.context())),
        failures
      );
    if (this.held.run.state !== 'shipping') this.finishPublicationWait();
    return before;
  }
  /** An explicit resume of a user pause (not an open checkpoint) re-enters its phase. */
  private async leaveUserPause(): Promise<void> {
    const run = this.held.run;
    if (
      run.state !== 'paused_user' ||
      ['plan', 'patch', 'verification'].some(
        (p) => this.held.checkpoint(p as CheckpointPoint)?.status === 'open'
      )
    )
      return;
    const phase = run.history.at(-1)?.from;
    const reasons: Partial<Record<RunState, ReasonCode>> = {
      gating: ReasonCode.ResumeGating,
      planning: ReasonCode.ResumePlanning,
      implementing: ReasonCode.ResumeImplementing,
      verifying: ReasonCode.ResumeVerifying,
      shipping: ReasonCode.ResumeShipping,
      revising: ReasonCode.ResumeRevising,
    };
    const reason = phase ? reasons[phase] : undefined;
    if (!reason) throw new ControllerError('invalid_journal');
    await this.persist(transitionRun(run, reason, this.deps.now().toISOString()));
  }
  private async performAction(action: TrackerActionRequest): Promise<RunRecord> {
    try {
      this.assertAdmission();
      if (!this.deps.trackerAction) throw new ControllerError('invalid_outcome');
      const result = await this.deps.trackerAction(this.context(), action);
      this.observeControl();
      this.observeIncident();
      if (this.control) return this.applyControl();
      if (this.incident) return this.cancel();
      this.assertAdmission();
      this.actionResult = result;
      return this.held.run;
    } catch (error) {
      this.observeControl();
      this.observeIncident();
      if (this.control) return this.applyControl();
      if (this.incident) return this.cancel();
      throw error;
    }
  }
  /** The result belongs to this locked invocation, never a prior artifact. A stop
   * request may preempt the command; then no contributor capability is returned. */
  async prAction(runId: string, action: TrackerActionRequest): Promise<TrackerActionResult> {
    await this.resume(runId, { action });
    if (!this.actionResult) throw new ControllerError('admission_closed');
    return structuredClone(this.actionResult);
  }
  private launch(work: () => Promise<RunRecord>): Promise<RunRecord> {
    if (this.running) throw new ControllerError('busy');
    this.abort = new AbortController();
    this.operation = Symbol();
    this.phaseLease = undefined;
    this.replayingAcquisition = false;
    this.needsAcquisition = false;
    this.incident = false;
    this.incidentKill = undefined;
    this.recovering = false;
    this.oldHolds.clear();
    this.unfundedCleanup.clear();
    this.cached.clear();
    this.control = undefined;
    this.interruptRequested = false;
    this.controlApplied = false;
    this.finalizationFailed = false;
    this.controlCleanup = undefined;
    this.controlReconciled = undefined;
    this.controlReconciledKind = undefined;
    this.revise = false;
    this.reviewers = [];
    this.actionResult = undefined;
    this.publicationWait = undefined;
    this.controllerStopReason = undefined;
    const watcher = setInterval(() => {
      this.observeIncident();
      this.observeControl();
    }, 20);
    // Fence synchronous observer/hook re-entry before invoking any injected code.
    const task = Promise.resolve()
      .then(work)
      .finally(async () => {
        try {
          try {
            await this.deps.release?.();
          } finally {
            // A signal can arrive while release awaits token revocation, after work
            // has already resolved or rejected. Keep pins alive until its independent
            // control cleanup is joined and the durable stop is applied.
            // Release can persist a cleanup block even when revocation rejects.
            // Publish that final durable state before the store pins are closed.
            try {
              this.observeControl();
              if (this.control && !this.controlApplied && this.store && this.journal)
                await this.applyControl();
              if (this.store) {
                const final = this.store.run;
                if (!this.last || !sameRunRecord(this.last, final)) this.notify(final);
                else this.last = final;
              }
            } finally {
              try {
                this.deps.retire?.();
              } finally {
                clearInterval(watcher);
                this.journal?.close();
                this.store?.close();
                this.store = undefined;
                this.ledger = undefined;
                this.journal = undefined;
                this.running = undefined;
              }
            }
          }
        } catch (error) {
          this.finalizationFailed = true;
          throw error;
        }
      });
    this.running = task;
    return task;
  }
  private observeIncident(): void {
    if (!this.running || !this.journal || this.incident || !this.deps.incidentRequested?.()) return;
    // incidentStop aborts synchronously before its first await. The launch joins
    // its independent cleanup obligation; observing it here must not await itself.
    void this.incidentStop('Incident root fence').catch(() => {});
  }
  /** Recheck external stop authority synchronously at every admission boundary. */
  assertAdmission(): void {
    this.observeIncident();
    this.observeControl();
    if (this.incident || this.abort.signal.aborted) throw new ControllerError('admission_closed');
  }
  private observeControl(): void {
    if (!this.store || !this.journal || this.control || this.incident) return;
    try {
      // A signal can precede initial store publication. Retain it until the
      // normal control path can durably record and apply the pause.
      if (this.interruptRequested) {
        // No-compute states (including an existing pause during recovery) have
        // no legal pause edge. Fence this invocation without inventing corruption
        // or changing the durable state; independent cleanup still must finish.
        if (controlRefusal(this.store.run, 'pause')) this.control = 'interrupt';
        else
          requestControl(
            this.store,
            { kind: 'pause', reason: 'Process interrupted' },
            this.deps.now()
          );
        this.interruptRequested = false;
      }
      const state = readControlRequests(this.store);
      if (state.invalid) this.control = 'invalid';
      else
        for (const row of state.pending) {
          const refusal = controlRefusal(this.store.run, row.kind);
          if (refusal) {
            acknowledgeControl(this.store, row, refusal);
            continue;
          }
          // Cancellation wins when both requests were durably pending at admission.
          this.control =
            state.pending.find(
              (r) => r.kind === 'cancel' && !controlRefusal(this.held.run, r.kind)
            ) ?? row;
          break;
        }
    } catch {
      this.control = 'invalid';
    }
    if (!this.control) return;
    this.abort.abort();
    this.phaseLease = undefined;
    // Start destruction while the active command/provider promise is blocked.
    if (typeof this.control === 'object' && this.control.kind === 'cancel')
      this.controlCleanup = this.reconcileControlOnce('cancel')
        .catch(() => {})
        .then(() => this.cleanup());
    else this.controlCleanup = this.cleanup();
    void this.controlCleanup.catch(() => {});
  }
  private reconcileControlOnce(kind: 'pause' | 'cancel'): Promise<void> {
    if (this.controlReconciled && this.controlReconciledKind === kind)
      return this.controlReconciled;
    this.controlReconciledKind = kind;
    this.controlReconciled = (async () => {
      await this.recovered(await this.deps.recovery.reconcileControl?.(this.context(), kind));
      if (kind === 'cancel') await this.deps.recovery.prepareCancellation?.(this.context());
    })();
    void this.controlReconciled.catch(() => {});
    return this.controlReconciled;
  }
  private async reconcileCleanupObligations(): Promise<void> {
    for (const vmId of this.unfundedCleanup) {
      const evidence = await this.recover(
        () => this.deps.recovery.reconcileCleanup?.(vmId, this.context()) ?? Promise.resolve(null)
      );
      if (evidence === null) continue;
      assertSecretFree(evidence);
      if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500)
        throw new ControllerError('invalid_outcome');
      this.journal?.append({
        v: 1,
        type: 'cleanup_reconciled',
        runId: this.held.runId,
        vmId,
        evidence,
      });
      this.unfundedCleanup.delete(vmId);
    }
  }
  private async applyControl(): Promise<RunRecord> {
    await this.controlCleanup?.catch(() => {});
    const failures: unknown[] = [];
    let selected = this.control;
    const latest = readControlRequests(this.held);
    if (latest.invalid) selected = 'invalid';
    else if (selected !== 'invalid')
      selected = latest.pending.find((r) => r.kind === 'cancel') ?? selected;
    const kind = typeof selected === 'object' ? selected.kind : 'pause';
    // Observation-only reconciliation is allowed after stop admission. Never
    // authenticate or authorize a new effect to discover an existing outcome.
    if (selected !== 'invalid') {
      await this.attemptRecovery(() => this.reconcileControlOnce(kind), failures);
      if (kind === 'cancel')
        await this.attemptRecovery(
          () => this.deps.recovery.endRun?.(this.context()) ?? Promise.resolve(),
          failures
        );
    }
    // An early resume interrupt can precede normal adapter initialization. A
    // lazy empty inventory is not proof that retained guests are gone.
    await this.attemptRecovery(
      () => this.deps.recovery.reconcileVms(this.context(), () => this.cleanup()),
      failures
    );
    await this.attemptRecovery(() => this.cleanup(), failures);
    await this.attemptRecovery(() => this.reconcileCleanupObligations(), failures);
    if (this.unfundedCleanup.size) failures.push(new ControllerError('admission_closed'));
    for (const hold of this.budget.snapshot().reservations.filter((h) => h.status === 'reserved')) {
      await this.attemptRecovery(
        async () =>
          this.budget.settle(hold.id, await this.deps.recovery.reconcileHold(hold, this.context())),
        failures
      );
    }
    if (
      this.held.run.state !== 'blocked_cleanup' &&
      !TERMINAL_STATES.includes(this.held.run.state)
    ) {
      const reason = failures.length
        ? ReasonCode.CleanupFailed
        : selected === 'invalid'
          ? ReasonCode.PolicyBlocked
          : kind === 'cancel'
            ? ReasonCode.UserCancelled
            : ReasonCode.UserPaused;
      // Publication may have completed while pausing; no compute means no pause.
      if (reason !== ReasonCode.UserPaused || !controlRefusal(this.held.run, 'pause'))
        await this.persist(transitionRun(this.held.run, reason, this.deps.now().toISOString()));
    }
    if (typeof selected === 'object') {
      const refusal =
        selected.kind === 'pause' &&
        this.held.run.state !== 'paused_user' &&
        this.held.run.state !== 'blocked_cleanup'
          ? 'nothing_to_pause'
          : null;
      acknowledgeControl(this.held, selected, refusal ?? 'applied');
      // Drain stop requests without re-admitting work or leaving a stale pause
      // that would unexpectedly stop a later explicit resume.
      for (const row of readControlRequests(this.held).pending) {
        const refusal = controlRefusal(this.held.run, row.kind);
        if (row.kind === 'cancel' && !refusal && this.held.run.state === 'paused_user') {
          this.control = row;
          this.controlCleanup = undefined;
          return this.applyControl();
        }
        if (row.kind === 'pause' || refusal)
          acknowledgeControl(this.held, row, refusal ?? 'applied');
      }
    }
    this.controlApplied = true;
    return this.held.run;
  }
  private get held(): RunStore {
    if (!this.store) throw new ControllerError('not_running');
    return this.store;
  }
  private get budget(): BudgetLedger {
    if (!this.ledger) throw new ControllerError('not_running');
    return this.ledger;
  }
  private sessionId(): string {
    const sessions = this.budget.snapshot().sessions;
    const session = sessions.at(-1);
    if (!session || sessions.some((s, i) => s.id !== this.held.budgetSessionId(i + 1)))
      throw new ControllerError('invalid_journal');
    return session.id;
  }
  /** The tracker transition is durable before allocation. A crash at either boundary
   * recovers the same numbered session, never resets any historical spend. */
  private ensureRevisionSession(): void {
    const count = revisionCount(this.held.run) + 1;
    const sessions = this.budget.snapshot().sessions;
    if (sessions.length > count || sessions.length < count - 1)
      throw new ControllerError('invalid_journal');
    if (sessions.length === count) return;
    if (this.control || this.incident || TERMINAL_STATES.includes(this.held.run.state)) return;
    this.budget.startSession(this.sessionInput(count));
  }
  /** Each numbered session gets the configured ceiling afresh; history is never reset. */
  private sessionInput(n: number) {
    const budget = this.held.config.budget;
    return {
      id: this.held.budgetSessionId(n),
      ceiling: { currency: budget.currency, minor: budget.ceilingMinor },
      cleanupAllowance: budget.cleanupAllowanceMinor,
      tokenLimit: budget.tokenLimit,
      timeLimitMs: budget.activeMinutes * 60_000,
    };
  }
  private context(lease?: symbol, allocations?: Set<Promise<VmHandle>>): PhaseContext {
    const operation = this.operation;
    const store = this.held;
    const ledger = this.budget;
    const sessionId = this.sessionId();
    const signal = this.abort.signal;
    return {
      revise: this.revise,
      reviewers: this.reviewers,
      observeRun: async (run) => {
        // Completed producer observations remain evidence after admission closes.
        // New revision resources/sessions still require an open stop fence.
        await this.recovered(run);
        this.observeControl();
        this.observeIncident();
        if (!this.control && !this.incident) this.ensureRevisionSession();
      },
      store: this.held,
      run: this.held.run,
      ledger: this.budget,
      sessionId: this.sessionId(),
      signal: this.abort.signal,
      assertAdmission: this.assertAdmission.bind(this),
      replayingAcquisition: this.replayingAcquisition,
      createVm: (spec) => {
        if (
          !lease ||
          this.phaseLease !== lease ||
          this.operation !== operation ||
          this.store !== store ||
          signal.aborted
        )
          return Promise.reject(new ControllerError('admission_closed'));
        const task = this.createVm(spec, store, ledger, sessionId, signal);
        allocations?.add(task);
        // Keep a rejection observed even when an injected step forgot to await it.
        void task.catch(() => {});
        return task;
      },
    };
  }
  private notify(run: RunRecord): void {
    this.last = run;
    let failed = false;
    for (const driver of this.deps.drivers) {
      try {
        driver.observeRun(run);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new ControllerError('driver_failed');
  }
  private async persist(run: RunRecord): Promise<void> {
    if (!isRunContinuation(this.held.run, run)) throw new ControllerError('invalid_outcome');
    if (sameRunRecord(run, this.held.run)) return;
    if (run.state !== 'shipping') this.finishPublicationWait();
    // Terminal rows have no CleanupFailed edge. Fence admission and finish cleanup
    // before committing a terminal snapshot; cleanup failure wins instead.
    if (TERMINAL_STATES.includes(run.state)) {
      await this.cleanup();
      if (this.held.run.state === 'blocked_cleanup') return;
      const before = this.held.run;
      try {
        await this.deps.recovery.endRun?.(
          this.context(),
          run.state === 'cancelled' ? 'cancelled' : 'completed'
        );
      } catch (error) {
        const after = this.store?.run ?? before;
        if (after.state !== 'blocked_cleanup')
          this.persistObserved(
            transitionRun(this.held.run, ReasonCode.CleanupFailed, this.deps.now().toISOString())
          );
        else if (!sameRunRecord(before, after)) this.notify(after);
        throw error;
      }
      const after = this.store?.run ?? before;
      if (after.state === 'blocked_cleanup') {
        if (!sameRunRecord(before, after)) this.notify(after);
        return;
      }
    }
    const previous = this.held.run;
    // Recovery drivers may return several transitions. Deliver each, never just the tail.
    let current = previous;
    for (const event of run.history.slice(previous.history.length)) {
      current = transitionRun(current, event.reasonCode, event.timestamp);
      try {
        this.persistObserved(current);
      } catch (error) {
        if (stopped(current.state)) await this.cleanup();
        throw error;
      }
    }
    if (stopped(run.state)) await this.cleanup();
  }
  private async recovered(run: undefined | RunRecord): Promise<void> {
    if (run) await this.persist(restoreRun(run));
  }
  private persistObserved(run: RunRecord): void {
    this.held.persistRun(run);
    this.notify(run);
  }
  private async recover<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.observeIncident();
      return result;
    } catch (error) {
      if (error instanceof AuthorApprovalError) throw error;
      if (error instanceof ControllerError && error.code === 'recovery_failed' && error.diagnostic)
        throw error;
      throw new ControllerError('recovery_failed');
    }
  }
  private async attemptRecovery(work: () => Promise<unknown>, failures: unknown[]): Promise<void> {
    try {
      await this.recover(work);
    } catch (error) {
      failures.push(error);
    }
  }
  private openJournal(resuming: boolean): void {
    const directory = path.join(this.held.storeDirectory('control'), 'controller');
    if (resuming) {
      try {
        readPrivate(path.join(directory, 'events.jsonl'));
      } catch {
        throw new ControllerError('invalid_journal');
      }
    }
    this.journal = new Journal(directory);
    for (const event of this.journal.read()) {
      assertSecretFree(event);
      if (!isRecord(event) || event.v !== 1 || event.runId !== this.held.runId)
        throw new ControllerError('invalid_journal');
      if (
        event.type === 'incident' &&
        typeof event.reason === 'string' &&
        Object.keys(event).length === 4
      )
        this.incident = true;
      else if (
        event.type === 'phase' &&
        typeof event.key === 'string' &&
        typeof event.phase === 'string' &&
        Object.hasOwn(KINDS, event.phase) &&
        Object.keys(event).length === 6
      ) {
        if (
          !(
            sourceEditCount(this.held) &&
            !event.key.endsWith(`:edit-${sourceEditCount(this.held)}`) &&
            ['review', 'verify', 'drift', 'ship'].includes(event.phase)
          )
        )
          this.cached.set(
            event.key,
            this.validatedOutcome(event.phase as PhaseName, event.outcome, true)
          );
      } else if (
        event.type === 'cleanup' &&
        ['pending', 'destroyed', 'blocked_cleanup'].includes(String(event.kind)) &&
        (event.kind !== 'pending' || event.funded === false) &&
        typeof event.vmId === 'string' &&
        typeof event.funded === 'boolean' &&
        Object.keys(event).length === 6
      ) {
        if (!event.funded) this.unfundedCleanup.add(event.vmId);
      } else if (
        event.type === 'publication_wait' &&
        this.budget.snapshot().sessions.some((s) => s.id === event.sessionId)
      ) {
        try {
          this.publicationWait = nextPublicationWait(this.publicationWait, event).open;
        } catch {
          throw new ControllerError('invalid_journal');
        }
      } else if (
        event.type === 'cleanup_reconciled' &&
        typeof event.vmId === 'string' &&
        this.unfundedCleanup.has(event.vmId) &&
        typeof event.evidence === 'string' &&
        event.evidence.trim() &&
        event.evidence.length <= 500 &&
        Object.keys(event).length === 5
      )
        this.unfundedCleanup.delete(event.vmId);
      else throw new ControllerError('invalid_journal');
    }
    const edit = latestSourceEdit(this.held);
    if (
      edit &&
      ![...this.cached].some(
        ([key, value]) =>
          key.endsWith(`:edit-${sourceEditCount(this.held)}`) &&
          (value.kind === 'candidate' || value.kind === 'advanced')
      )
    )
      this.cached.set('user-edit', {
        kind: 'candidate',
        bindings: {
          candidateSha: edit.candidate.record.candidateSha,
          policyDigest: edit.policyDigest,
          reviewDigest: edit.reviewDigest,
          budgetSessionId: this.sessionId(),
        },
      });
  }
  private key(phase: PhaseName): string {
    // A checkpoint's pause/approval pair is not a new phase attempt.
    const history = this.held.run.history.filter(
      (event) =>
        event.reasonCode !== ReasonCode.UserPaused &&
        ![
          ReasonCode.ResumePlanning,
          ReasonCode.ResumeGating,
          ReasonCode.ResumeImplementing,
          ReasonCode.ResumeRevising,
          ReasonCode.ResumeVerifying,
          ReasonCode.ResumeShipping,
        ].includes(event.reasonCode)
    );
    const edits = sourceEditCount(this.held);
    return `${history.length}:${phase}${edits ? `:edit-${edits}` : ''}`;
  }
  private finishPublicationWait(): void {
    if (!this.publicationWait) return;
    const at = this.deps.now().toISOString();
    const elapsed = Date.parse(at) - this.publicationWait.at;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw new ControllerError('invalid_journal');
    this.appendPublicationWait('end', this.publicationWait.sessionId, at);
    this.publicationWait = undefined;
  }
  private appendPublicationWait(operation: 'begin' | 'end', sessionId: string, at: string): void {
    this.journal?.append({
      v: 1,
      type: 'publication_wait',
      runId: this.held.runId,
      operation,
      sessionId,
      at,
    });
  }
  private validatedOutcome(phase: PhaseName, input: unknown, historical = false): Outcome {
    try {
      const result = outcome(phase, input);
      if (result.kind === 'planned' || result.kind === 'candidate' || result.kind === 'advanced') {
        const bindings = checkpointBindings(
          result.bindings,
          result.kind === 'planned' ? 'plan' : 'patch',
          this.held.runId
        );
        if (
          historical
            ? !this.budget.snapshot().sessions.some((s) => s.id === bindings.budgetSessionId)
            : bindings.budgetSessionId !== this.sessionId()
        )
          throw new ControllerError('invalid_outcome');
      } else if (result.kind === 'verified') {
        if (
          typeof result.record.recordDigest !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(result.record.recordDigest)
        )
          throw new ControllerError('invalid_outcome');
        const record = loadVerification(
          this.held.storeDirectory('artifacts'),
          result.record.candidateSha,
          { runId: this.held.runId, expectedDigest: result.record.recordDigest }
        );
        if (canonicalJson(record, 1024 * 1024) !== canonicalJson(result.record, 1024 * 1024))
          throw new ControllerError('invalid_outcome');
        return { kind: 'verified', record };
      }
      return result;
    } catch {
      throw new ControllerError('invalid_outcome');
    }
  }
  private admissionRefusal(
    phase: PhaseName
  ): import('./stop-notice').ControllerRefusalReason | null {
    const observedAt = this.deps.now();
    const status = assembleStatus({
      run: this.held.run,
      now: observedAt,
      budget: this.budget.snapshot(),
      sessionId: this.sessionId(),
      publicationWaitMs: publicationWaitTime(
        this.journal?.read() ?? [],
        this.sessionId(),
        observedAt.getTime(),
        this.held.runId,
        openWaitUntil(this.held.run, observedAt.getTime())
      ),
    });
    return phase !== 'track' &&
      status.activeTimeMs >= this.held.config.budget.activeMinutes * 60_000
      ? 'active_time_exhausted'
      : phase !== 'track' && isBudgetSessionExhausted(this.budget.snapshot(), this.sessionId())
        ? 'budget_exhausted'
        : this.budget
              .snapshot()
              .reservations.some((hold) => hold.status === 'reserved' && this.oldHolds.has(hold.id))
          ? 'hold_unsettled'
          : null;
  }
  private async step(phase: PhaseName, reacquire = false): Promise<Outcome> {
    this.assertAdmission();
    if (this.unfundedCleanup.size)
      return stopped(this.held.run.state) ? { kind: 'waiting' } : { kind: 'hand_off' };
    const key = this.key(phase);
    const cached = this.cached.get(key);
    if (cached && !reacquire && !['track', 'ship'].includes(phase)) return cached;
    let refusal = this.admissionRefusal(phase);
    const transitionPending = this.held.run.state !== 'gating' && !stopped(this.held.run.state);
    try {
      await this.deps.recordControllerStop?.(
        this.context(),
        refusal,
        refusal !== null && transitionPending
      );
      // Retirement can await storage long enough to exhaust time or budget.
      // Recheck before granting the producer its phase/allocation lease.
      if (refusal === null) {
        this.assertAdmission();
        refusal = this.admissionRefusal(phase);
        if (refusal)
          await this.deps.recordControllerStop?.(this.context(), refusal, transitionPending);
      }
    } catch (error) {
      // A diagnostic write is part of admission, never a reason to release a live
      // guest. Preserve cleanup accounting/fences and propagate the original failure.
      this.abort.abort();
      try {
        await this.cleanup();
      } catch {
        // cleanup retains its durable blocked_cleanup/accounting fence. The
        // notice persistence failure remains the invocation's primary error.
      }
      throw error;
    }
    this.assertAdmission();
    if (refusal) {
      this.controllerStopReason = refusal;
      return stopped(this.held.run.state) ? { kind: 'waiting' } : { kind: 'hand_off' };
    }
    // Time parked after a gate hand-off waits on the operator, not the run (#1184).
    if (phase === 'gate') this.finishPublicationWait();
    let result: Outcome;
    const lease = Symbol();
    const allocations = new Set<Promise<VmHandle>>();
    this.phaseLease = lease;
    try {
      const proposed = await this.deps.steps[phase](this.context(lease, allocations));
      this.observeIncident();
      this.observeControl();
      this.phaseLease = undefined;
      const pending = await Promise.allSettled(allocations);
      result = this.validatedOutcome(phase, proposed);
      if (
        pending.some((entry) => entry.status === 'rejected') &&
        !['hand_off', 'blocked', 'unsupported', 'failed', 'cancelled', 'waiting'].includes(
          result.kind
        )
      )
        throw new ControllerError('invalid_outcome');
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      if (error instanceof AuthorApprovalError) throw error;
      throw new ControllerError('step_failed');
    } finally {
      this.phaseLease = undefined;
      await Promise.allSettled(allocations);
    }
    // A completed publication remains evidence even when cancellation races it.
    if ((this.incident || this.control) && result.kind !== 'submitted')
      throw new ControllerError('admission_closed');
    if (!['hand_off', 'waiting'].includes(result.kind)) {
      this.journal?.append({
        v: 1,
        type: 'phase',
        runId: this.held.runId,
        key,
        phase,
        outcome: result,
      });
      this.cached.set(key, result);
    }
    if (
      ((phase === 'ship' && result.kind === 'waiting') ||
        (phase === 'gate' && result.kind === 'hand_off')) &&
      !this.publicationWait
    ) {
      const at = this.deps.now().toISOString();
      const sessionId = this.sessionId();
      this.appendPublicationWait('begin', sessionId, at);
      this.publicationWait = { sessionId, at: Date.parse(at) };
    } else if (phase === 'ship' && result.kind !== 'waiting') this.finishPublicationWait();
    return result;
  }
  private async apply(result: Outcome): Promise<boolean> {
    if (['hand_off', 'waiting'].includes(result.kind)) {
      try {
        if (
          result.kind === 'hand_off' &&
          this.held.run.state !== 'gating' &&
          !stopped(this.held.run.state)
        )
          await this.persist(
            transitionRun(this.held.run, ReasonCode.UserPaused, this.deps.now().toISOString())
          );
        await this.cleanup();
      } finally {
        // Teardown may add a blocked_cleanup transition. Bind only this refusal
        // again to the final durable stop, rather than leaving its predicted pause stale.
        const reason = this.controllerStopReason;
        this.controllerStopReason = undefined;
        if (reason) await this.deps.recordControllerStop?.(this.context(), reason, false);
      }
      return false;
    }
    if (result.kind === 'verified') {
      const record = loadVerification(
        this.held.storeDirectory('artifacts'),
        result.record.candidateSha,
        { runId: this.held.runId, expectedDigest: result.record.recordDigest }
      );
      if (record.candidateSha !== this.latestCandidate().bindings.candidateSha)
        throw new ControllerError('invalid_outcome');
      const run = record.boundaryHeld
        ? applyVerification(this.held.run, record.verdict, this.deps.now().toISOString())
        : transitionRun(this.held.run, ReasonCode.PolicyBlocked, this.deps.now().toISOString());
      await this.persist(run);
    } else {
      const reason = REASONS[result.kind];
      if (
        reason &&
        !(IDEMPOTENT_TRACK_OUTCOMES.includes(result.kind) && this.held.run.reasonCode === reason)
      )
        await this.persist(transitionRun(this.held.run, reason, this.deps.now().toISOString()));
      if (result.kind === 'revision') this.ensureRevisionSession();
    }
    return !stopped(this.held.run.state);
  }
  private async checkpoint(point: CheckpointPoint, bindings: CheckpointBindings): Promise<boolean> {
    if (!checkpointDue(this.held.config.checkpoints, point)) return true;
    const previous = this.held.run;
    pauseAtCheckpoint(this.held, previous, point, bindings, this.deps.now());
    if (!sameRunRecord(previous, this.held.run)) {
      try {
        this.notify(this.held.run);
      } catch (error) {
        await this.cleanup();
        throw error;
      }
    }
    if (this.held.run.state === 'paused_user') {
      await this.cleanup();
      return false;
    }
    return true;
  }
  private async loop(resuming: boolean): Promise<RunRecord> {
    try {
      this.observeControl();
      if (this.control) return await this.applyControl();
      if (this.incident) return await this.cancel();
      if (
        this.held.run.state === 'blocked_cleanup' ||
        TERMINAL_STATES.includes(this.held.run.state) ||
        this.held.run.state === 'paused_user'
      )
        return this.held.run;
      if (
        resuming &&
        ['awaiting_contributor', 'awaiting_maintainer'].includes(this.held.run.state)
      ) {
        if (!(await this.apply(await this.step('resumeHandoff')))) return this.held.run;
      } else if (resuming && TRACKING_STATES.includes(this.held.run.state)) {
        if (!(await this.apply(await this.step('track')))) return this.held.run;
      }
      while (!stopped(this.held.run.state)) {
        if (this.needsAcquisition && this.held.run.state !== 'gating') {
          this.replayingAcquisition = true;
          try {
            if (!(await this.apply(await this.step('acquire', true)))) break;
          } finally {
            this.replayingAcquisition = false;
            this.needsAcquisition = false;
          }
        }
        if (!(await this.dispatchActive())) break;
      }
      if (this.incident) return await this.cancel();
      if (this.control) return await this.applyControl();
      return this.held.run;
    } catch (error) {
      if (this.control) return this.applyControl();
      if (this.incident) return this.cancel();
      if (error instanceof ControllerError && error.code === 'invalid_outcome') {
        this.abort.abort();
        await this.cleanup();
        if (
          this.held.run.state !== 'blocked_cleanup' &&
          !TERMINAL_STATES.includes(this.held.run.state)
        )
          await this.persist(
            transitionRun(this.held.run, ReasonCode.PolicyBlocked, this.deps.now().toISOString())
          );
      }
      throw error;
    }
  }
  private dispatchActive(): Promise<boolean> {
    switch (this.held.run.state) {
      case 'gating':
        return this.step('gate').then((result) => this.apply(result));
      case 'planning':
        return this.planning();
      case 'implementing':
      case 'revising':
        return this.step('implement').then((result) => this.apply(result));
      case 'verifying':
        return this.verifying();
      case 'shipping':
        return this.shipping();
      default:
        throw new ControllerError('invalid_outcome');
    }
  }
  private async planning(): Promise<boolean> {
    if (!(await this.apply(await this.step('acquire')))) return false;
    const plan = await this.step('plan');
    if (plan.kind === 'planned' && !(await this.checkpoint('plan', plan.bindings))) return false;
    return this.apply(plan);
  }
  private async verifying(): Promise<boolean> {
    if (!(await this.checkpoint('patch', this.latestCandidate().bindings))) return false;
    if (!(await this.apply(await this.step('review')))) return false;
    return this.apply(await this.step('verify'));
  }
  private async shipping(): Promise<boolean> {
    const record = this.latestVerification();
    const { reviewDigest: _patchReview, ...candidateBindings } = this.latestCandidate().bindings;
    const bindings = {
      ...candidateBindings,
      verificationDigest: record.recordDigest,
    };
    if (!(await this.checkpoint('verification', bindings))) return false;
    const drift = await this.step('drift');
    if (!(await this.apply(drift))) return false;
    return drift.kind === 'advanced' || this.apply(await this.step('ship'));
  }
  private latestCandidate(): { readonly bindings: CheckpointBindings } {
    const candidate = [...this.cached.values()]
      .reverse()
      .find((value) => value.kind === 'candidate' || value.kind === 'advanced');
    if (!candidate || (candidate.kind !== 'candidate' && candidate.kind !== 'advanced'))
      throw new ControllerError('invalid_journal');
    return candidate;
  }
  private latestVerification(): VerificationRecord {
    const verified = [...this.cached.values()].reverse().find((value) => value.kind === 'verified');
    if (!verified || verified.kind !== 'verified') throw new ControllerError('invalid_journal');
    return verified.record;
  }
  private async createVm(
    input: Omit<VmSpec, 'runId' | 'limits'>,
    store: RunStore,
    ledger: BudgetLedger,
    sessionId: string,
    signal: AbortSignal
  ): Promise<VmHandle> {
    this.assertAdmission();
    if (
      this.incident ||
      this.recovering ||
      this.unfundedCleanup.size > 0 ||
      signal.aborted ||
      stopped(store.run.state)
    )
      throw new ControllerError('admission_closed');
    const spec: VmSpec = {
      ...structuredClone(input),
      runId: store.runId,
      limits: store.config.limits,
    };
    assertSecretFree(spec);
    const hold = ledger.reserve(sessionId, this.deps.estimateVm(spec, 'work'));
    const vm = await this.deps.vm.create(spec);
    if (vm.runId !== spec.runId) throw new ControllerError('invalid_outcome');
    ledger.settle(hold.id, await this.deps.observeVm(hold, vm));
    if (signal.aborted || this.store !== store) {
      await this.cleanup();
      throw new ControllerError('admission_closed');
    }
    return vm;
  }
  private async cleanup(): Promise<void> {
    let vms: Awaited<ReturnType<VmAdapter['listByRun']>>;
    try {
      vms = await this.recover(() => this.deps.vm.listByRun(this.held.runId));
    } catch (error) {
      const run = this.held.run;
      if (run.state !== 'blocked_cleanup' && !TERMINAL_STATES.includes(run.state))
        this.persistObserved(
          transitionRun(run, ReasonCode.CleanupFailed, this.deps.now().toISOString())
        );
      throw error;
    }
    const failures: unknown[] = [];
    let cleanupRun = this.held.run;
    const limits = this.held.config.limits;
    for (const vm of vms) {
      if (vm.runId !== cleanupRun.runId) {
        failures.push(new ControllerError('invalid_outcome'));
        continue;
      }
      cleanupRun = await this.cleanupVm(
        vm,
        { runId: cleanupRun.runId, limits, scope: 'container' },
        cleanupRun,
        failures
      );
    }
    if (failures.length) throw failures[0];
  }
  private cleanupReservation(
    vm: Pick<VmHandle, 'vmId' | 'runId'>,
    spec: VmSpec,
    failures: unknown[]
  ): BudgetReservation | undefined {
    try {
      return this.budget.reserve(
        this.sessionId(),
        this.deps.estimateVm(spec, 'teardown'),
        'teardown'
      );
    } catch {
      this.unfundedCleanup.add(vm.vmId);
      failures.push(new ControllerError('admission_closed'));
      // Write the obligation BEFORE destruction: a crash during destruction must
      // not erase the accounting fence merely because the guest later disappears.
      try {
        this.journal?.append({
          v: 1,
          type: 'cleanup',
          runId: vm.runId,
          vmId: vm.vmId,
          kind: 'pending',
          funded: false,
        });
      } catch (error) {
        failures.push(error);
        try {
          this.persistObserved(
            transitionRun(this.held.run, ReasonCode.CleanupFailed, this.deps.now().toISOString())
          );
        } catch (fenceError) {
          failures.push(fenceError);
        }
      }
      return undefined;
    }
  }
  private recordCleanup(
    vm: Pick<VmHandle, 'vmId' | 'runId'>,
    result: TeardownOutcome,
    current: RunRecord,
    funded: boolean,
    failures: unknown[]
  ): void {
    try {
      this.journal?.append({
        v: 1,
        type: 'cleanup',
        runId: vm.runId,
        vmId: vm.vmId,
        kind: result.kind,
        funded,
      });
    } catch (error) {
      failures.push(error);
    }
    if (
      result.kind === 'blocked_cleanup' &&
      current.state !== 'blocked_cleanup' &&
      !TERMINAL_STATES.includes(current.state)
    ) {
      try {
        this.persistObserved(result.run);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  private async cleanupVm(
    vm: Pick<VmHandle, 'vmId' | 'runId'>,
    spec: VmSpec,
    current: RunRecord,
    failures: unknown[]
  ): Promise<RunRecord> {
    const hold = this.cleanupReservation(vm, spec, failures);
    let result: TeardownOutcome;
    try {
      result = await teardownVm(this.deps.vm, vm, current, {
        now: this.deps.now,
        reconcileStopped: true,
        retryDelayMs: 0,
        sleep: async () => {},
      });
    } catch (error) {
      failures.push(error);
      return current;
    }
    this.recordCleanup(vm, result, current, hold !== undefined, failures);
    if (hold) {
      try {
        this.budget.settle(hold.id, await this.recover(() => this.deps.observeVm(hold, vm)));
      } catch (error) {
        failures.push(error);
      }
    }
    return result.run;
  }
  async incidentStop(reason: string): Promise<RunRecord> {
    if (!this.running || !this.journal) throw new ControllerError('not_running');
    if (this.incident) return this.running;
    assertSecretFree(reason);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500)
      throw new ControllerError('invalid_outcome');
    const task = this.running;
    this.incident = true;
    this.abort.abort();
    try {
      this.journal.append({ v: 1, type: 'incident', runId: this.held.runId, reason });
      this.incidentKill = this.recover(() => this.deps.recovery.killAll(this.context()));
      await this.incidentKill;
    } finally {
      await task;
    }
    return this.snapshot();
  }
  private async cancel(): Promise<RunRecord> {
    // Keep the run lock until the kill hook has joined; a fast aborted step must
    // not release it while global credential/resource revocation is still running.
    await this.incidentKill?.catch(() => {});
    await this.cleanup();
    if (!TERMINAL_STATES.includes(this.held.run.state) && this.held.run.state !== 'blocked_cleanup')
      await this.persist(
        transitionRun(this.held.run, ReasonCode.UserCancelled, this.deps.now().toISOString())
      );
    return this.held.run;
  }
}
