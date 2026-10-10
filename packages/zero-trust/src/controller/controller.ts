/** Credential-free orchestration. Injected steps own durable effect reconciliation. */
import path from 'node:path';
import { type BudgetLedger, isBudgetSessionExhausted } from '../budget';
import type { BudgetEstimate, BudgetObservation, BudgetReservation } from '../budget-types';
import { readPrivate } from '../durable-fs';
import { applyVerification } from '../ecosystem/classify';
import { Journal } from '../journal';
import { canonicalJson } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import {
  isRecord,
  isRunContinuation,
  ReasonCode,
  type RunRecord,
  type RunState,
  restoreRun,
  sameRunRecord,
  TERMINAL_STATES,
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
} from './control';
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
  readonly revise: boolean;
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
  revisionWaiting?(context: PhaseContext): boolean;
  openStore(root: string, runId: string): RunStore;
  openBudget(store: RunStore): BudgetLedger;
  reconcileHold(hold: BudgetReservation, context: PhaseContext): Promise<BudgetObservation | null>;
  /** Explicit accounting/no-charge evidence for previously unfunded destruction.
   * Wiring reconciles the actual charge in the ledger before returning evidence. */
  reconcileCleanup?(vmId: string, context: PhaseContext): Promise<string | null>;
  reconcileVms(context: PhaseContext, cleanup: () => Promise<void>): Promise<void>;
  recoverCredentials(context: PhaseContext): Promise<void>;
  resumeIntents(context: PhaseContext): Promise<undefined | RunRecord>;
  /** Replay/reconcile existing effects only; fresh invitation checks belong to PhaseSteps. */
  resumeHandoff(context: PhaseContext): Promise<undefined | RunRecord>;
  /** Replay/reconcile existing effects only; fresh tracker observations belong to PhaseSteps. */
  resumeTracker(context: PhaseContext): Promise<undefined | RunRecord>;
  killAll(context: PhaseContext): Promise<void>;
  /** Per-run cancellation, distinct from the root-wide incident kill switch. */
  endRun?(context: PhaseContext): Promise<void>;
  reconcileControl?(
    context: PhaseContext,
    kind: 'pause' | 'cancel'
  ): Promise<undefined | RunRecord>;
  prepareCancellation?(context: PhaseContext): Promise<void>;
}
export interface ControllerDependencies {
  readonly trackerAction?: (
    context: PhaseContext,
    request: TrackerActionRequest
  ) => Promise<TrackerActionResult>;
  /** Stop-only external fence. It can revoke admission, never grant authority. */
  readonly incidentRequested?: () => boolean;
  /** Release run-owned journals/credential leases before the RunStore pins close. */
  readonly release?: () => Promise<void>;
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
      readonly reason: 'maintainer_request' | 'user_instruction';
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
  private control?: ControlRequest | 'invalid';
  private controlCleanup?: Promise<void>;
  private controlReconciled?: Promise<void>;
  private controlReconciledKind?: 'pause' | 'cancel';
  private revise = false;
  private actionResult?: TrackerActionResult;
  private publicationWait?: { sessionId: string; at: string };
  private publicationWaitMs = 0;
  constructor(private readonly deps: ControllerDependencies) {}
  snapshot(): RunRecord {
    if (!this.last) throw new ControllerError('not_running');
    return this.last;
  }
  start(config: RunConfig): Promise<RunRecord> {
    return this.launch(async () => {
      this.store = RunStore.create(this.deps.root, config, this.deps.now());
      this.ledger = this.deps.recovery.openBudget(this.store);
      this.ledger.initialize([], this.store.config.modelProfile.rates);
      const budget = this.store.config.budget;
      this.ledger.startSession({
        id: this.store.budgetSessionId(1),
        ceiling: { currency: budget.currency, minor: budget.ceilingMinor },
        cleanupAllowance: budget.cleanupAllowanceMinor,
        tokenLimit: budget.tokenLimit,
        timeLimitMs: budget.activeMinutes * 60_000,
      });
      this.openJournal(false);
      this.notify(this.store.run);
      return this.loop(false);
    });
  }
  resume(
    runId: string,
    options: { readonly revise?: boolean; readonly action?: TrackerActionRequest } = {}
  ): Promise<RunRecord> {
    const revise = options.revise === true;
    const action = options.action ? structuredClone(options.action) : undefined;
    if (action) {
      assertSecretFree(action);
      const keys =
        action.kind === 'edit'
          ? ['kind', 'title', 'body']
          : action.kind === 'withdraw'
            ? ['kind', 'reason', 'explanation']
            : ['kind'];
      if (
        !['edit', 'withdraw', 'cancel-action'].includes(action.kind) ||
        Object.keys(action).sort().join(',') !== keys.sort().join(',') ||
        (action.kind === 'edit' &&
          (typeof action.title !== 'string' || typeof action.body !== 'string')) ||
        (action.kind === 'withdraw' &&
          (!['maintainer_request', 'user_instruction'].includes(action.reason) ||
            typeof action.explanation !== 'string'))
      )
        throw new ControllerError('invalid_outcome');
    }
    return this.launch(async () => {
      this.revise = revise;
      this.store = this.deps.recovery.openStore(this.deps.root, runId);
      if (
        revise &&
        !['submitted', 'awaiting_review', 'accepted'].includes(this.store.run.state) &&
        !this.store.run.history.some((e) => e.reasonCode === ReasonCode.RevisionRequested)
      )
        throw new ControllerError('invalid_outcome');
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
      const beforeTracker = this.store.run.state;
      if (
        !this.control &&
        !this.incident &&
        (['submitted', 'awaiting_review', 'accepted'].includes(beforeTracker) ||
          this.store.run.history.some((e) => e.reasonCode === ReasonCode.RevisionRequested)) &&
        !TERMINAL_STATES.includes(beforeTracker) &&
        beforeTracker !== 'blocked_cleanup'
      )
        await this.attemptRecovery(
          async () => this.recovered(await this.deps.recovery.resumeTracker(this.context())),
          failures
        );
      if (this.store.run.state !== 'shipping') this.finishPublicationWait();
      this.observeControl();
      this.observeIncident();
      if (this.control) return this.applyControl();
      // A completed publication or unresolved read-back is observation only.
      // Never require credentials, work budget or source reacquisition to confirm it.
      if (
        !this.incident &&
        !failures.length &&
        beforeTracker === 'shipping' &&
        this.store.run.state === 'submitted'
      ) {
        this.ensureRevisionSession();
        return this.store.run;
      }
      if (
        !this.incident &&
        !failures.length &&
        !action &&
        this.deps.recovery.revisionWaiting?.(this.context())
      )
        return this.store.run;
      this.observeIncident();
      if (!this.incident)
        await this.attemptRecovery(
          () => this.deps.recovery.recoverCredentials(this.context()),
          failures
        );
      if (this.incident)
        await this.attemptRecovery(() => this.deps.recovery.killAll(this.context()), failures);
      if (this.incident) return this.cancel();
      if (failures.length) throw failures[0];
      await this.recovered(
        await this.recover(() => this.deps.recovery.resumeIntents(this.context()))
      );
      if (['awaiting_contributor', 'awaiting_maintainer'].includes(this.store.run.state))
        await this.recovered(
          await this.recover(() => this.deps.recovery.resumeHandoff(this.context()))
        );
      this.ensureRevisionSession();
      this.recovering = false;
      if (action) {
        this.assertAdmission();
        if (!this.deps.trackerAction) throw new ControllerError('invalid_outcome');
        this.actionResult = await this.deps.trackerAction(this.context(), action);
        return this.store.run;
      }
      this.needsAcquisition = true;
      if (
        this.store.run.state === 'paused_user' &&
        !['plan', 'patch', 'verification'].some(
          (p) => this.store?.checkpoint(p as CheckpointPoint)?.status === 'open'
        )
      ) {
        const phase = this.store.run.history.at(-1)?.from;
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
        await this.persist(transitionRun(this.store.run, reason, this.deps.now().toISOString()));
      }
      return this.loop(true);
    });
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
    this.controlCleanup = undefined;
    this.controlReconciled = undefined;
    this.controlReconciledKind = undefined;
    this.revise = false;
    this.actionResult = undefined;
    this.publicationWait = undefined;
    this.publicationWaitMs = 0;
    const watcher = setInterval(() => {
      this.observeIncident();
      this.observeControl();
    }, 20);
    // Fence synchronous observer/hook re-entry before invoking any injected code.
    const task = Promise.resolve()
      .then(work)
      .finally(async () => {
        clearInterval(watcher);
        try {
          this.last = this.store?.run ?? this.last;
          await this.deps.release?.();
        } finally {
          this.journal?.close();
          this.store?.close();
          this.store = undefined;
          this.ledger = undefined;
          this.journal = undefined;
          this.running = undefined;
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
    if (this.control !== 'invalid' && this.control.kind === 'cancel')
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
    // Observation-only reconciliation is allowed after stop admission. Never
    // authenticate or authorize a new effect to discover an existing outcome.
    if (selected !== 'invalid') {
      await this.attemptRecovery(
        () => this.reconcileControlOnce(selected?.kind ?? 'pause'),
        failures
      );
      if (selected?.kind === 'cancel')
        await this.attemptRecovery(
          () => this.deps.recovery.endRun?.(this.context()) ?? Promise.resolve(),
          failures
        );
    }
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
          : selected?.kind === 'cancel'
            ? ReasonCode.UserCancelled
            : ReasonCode.UserPaused;
      // Publication may have completed while pausing; no compute means no pause.
      if (reason !== ReasonCode.UserPaused || !controlRefusal(this.held.run, 'pause'))
        await this.persist(transitionRun(this.held.run, reason, this.deps.now().toISOString()));
    }
    if (selected && selected !== 'invalid') {
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
    const count =
      this.held.run.history.filter((e) => e.reasonCode === ReasonCode.RevisionRequested).length + 1;
    const sessions = this.budget.snapshot().sessions;
    if (sessions.length > count || sessions.length < count - 1)
      throw new ControllerError('invalid_journal');
    if (sessions.length === count) return;
    if (this.control || this.incident || TERMINAL_STATES.includes(this.held.run.state)) return;
    const budget = this.held.config.budget;
    this.budget.startSession({
      id: this.held.budgetSessionId(count),
      ceiling: { currency: budget.currency, minor: budget.ceilingMinor },
      cleanupAllowance: budget.cleanupAllowanceMinor,
      tokenLimit: budget.tokenLimit,
      timeLimitMs: budget.activeMinutes * 60_000,
    });
  }
  private context(lease?: symbol, allocations?: Set<Promise<VmHandle>>): PhaseContext {
    const operation = this.operation;
    const store = this.held;
    const ledger = this.budget;
    const sessionId = this.sessionId();
    const signal = this.abort.signal;
    return {
      revise: this.revise,
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
      )
        this.cached.set(
          event.key,
          this.validatedOutcome(event.phase as PhaseName, event.outcome, true)
        );
      else if (
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
        Object.keys(event).length === 6 &&
        typeof event.at === 'string' &&
        Number.isFinite(Date.parse(event.at)) &&
        typeof event.sessionId === 'string' &&
        this.budget.snapshot().sessions.some((s) => s.id === event.sessionId) &&
        (event.operation === 'begin' || event.operation === 'end')
      ) {
        if (event.operation === 'begin') {
          if (this.publicationWait) throw new ControllerError('invalid_journal');
          this.publicationWait = { sessionId: event.sessionId, at: event.at };
        } else {
          if (
            !this.publicationWait ||
            this.publicationWait.sessionId !== event.sessionId ||
            Date.parse(event.at) < Date.parse(this.publicationWait.at)
          )
            throw new ControllerError('invalid_journal');
          if (event.sessionId === this.sessionId())
            this.publicationWaitMs += Date.parse(event.at) - Date.parse(this.publicationWait.at);
          this.publicationWait = undefined;
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
    return `${history.length}:${phase}`;
  }
  private finishPublicationWait(): void {
    if (!this.publicationWait) return;
    const at = this.deps.now().toISOString();
    const elapsed = Date.parse(at) - Date.parse(this.publicationWait.at);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw new ControllerError('invalid_journal');
    this.journal?.append({
      v: 1,
      type: 'publication_wait',
      runId: this.held.runId,
      operation: 'end',
      sessionId: this.publicationWait.sessionId,
      at,
    });
    if (this.publicationWait.sessionId === this.sessionId()) this.publicationWaitMs += elapsed;
    this.publicationWait = undefined;
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
  private async step(phase: PhaseName, reacquire = false): Promise<Outcome> {
    this.assertAdmission();
    if (this.unfundedCleanup.size)
      return stopped(this.held.run.state) ? { kind: 'waiting' } : { kind: 'hand_off' };
    const key = this.key(phase);
    const cached = this.cached.get(key);
    if (cached && !reacquire && !['track', 'ship'].includes(phase)) return cached;
    const status = assembleStatus({
      run: this.held.run,
      now: this.deps.now(),
      budget: this.budget.snapshot(),
      sessionId: this.sessionId(),
      publicationWaitMs: this.publicationWaitMs,
    });
    if (
      (phase !== 'track' &&
        status.activeTimeMs >= this.held.config.budget.activeMinutes * 60_000) ||
      (phase !== 'track' && isBudgetSessionExhausted(this.budget.snapshot(), this.sessionId())) ||
      this.budget
        .snapshot()
        .reservations.some((hold) => hold.status === 'reserved' && this.oldHolds.has(hold.id))
    )
      return stopped(this.held.run.state) ? { kind: 'waiting' } : { kind: 'hand_off' };
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
    if (phase === 'ship' && result.kind === 'waiting' && !this.publicationWait) {
      const at = this.deps.now().toISOString();
      this.journal?.append({
        v: 1,
        type: 'publication_wait',
        runId: this.held.runId,
        operation: 'begin',
        sessionId: this.sessionId(),
        at,
      });
      this.publicationWait = { sessionId: this.sessionId(), at };
    } else if (phase === 'ship' && result.kind !== 'waiting') this.finishPublicationWait();
    return result;
  }
  private async apply(result: Outcome): Promise<boolean> {
    if (['hand_off', 'waiting'].includes(result.kind)) {
      if (
        result.kind === 'hand_off' &&
        this.held.run.state !== 'gating' &&
        !stopped(this.held.run.state)
      )
        await this.persist(
          transitionRun(this.held.run, ReasonCode.UserPaused, this.deps.now().toISOString())
        );
      await this.cleanup();
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
        !(
          ['revision', 'submitted', 'merged', 'declined', 'awaiting_review', 'blocked'].includes(
            result.kind
          ) && this.held.run.reasonCode === reason
        )
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
      } else if (
        resuming &&
        ['submitted', 'awaiting_review', 'accepted'].includes(this.held.run.state)
      ) {
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
