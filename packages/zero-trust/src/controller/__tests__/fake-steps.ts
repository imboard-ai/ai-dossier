import path from 'node:path';
import { BudgetLedger } from '../../budget';
import type { BudgetReservation } from '../../budget-types';
import type { RunRecord } from '../../state';
import type {
  AcquireOutcome,
  ControllerTrackOutcome,
  DriftOutcome,
  GateOutcome,
  ImplementOutcome,
  PhaseContext,
  PhaseSteps,
  PlanOutcome,
  RecoveryHooks,
  ResumeHandoffOutcome,
  ReviewOutcome,
  ShipOutcome,
  VerifyOutcome,
} from '../controller';
import { RunStore } from '../run-store';

type Script<T> = T | ((context: PhaseContext) => T | Promise<T>);
export class ScriptedSteps implements PhaseSteps {
  before?: (phase: keyof PhaseSteps, context: PhaseContext) => void;
  readonly calls: (keyof PhaseSteps)[] = [];
  readonly scripts: { [K in keyof PhaseSteps]?: Script<Awaited<ReturnType<PhaseSteps[K]>>>[] } = {};
  constructor(private readonly defaults: PhaseSteps) {}
  private async next<K extends keyof PhaseSteps>(
    phase: K,
    context: PhaseContext
  ): Promise<Awaited<ReturnType<PhaseSteps[K]>>> {
    this.calls.push(phase);
    this.before?.(phase, context);
    const script = this.scripts[phase]?.shift();
    return (
      script === undefined
        ? this.defaults[phase](context)
        : typeof script === 'function'
          ? script(context)
          : script
    ) as Promise<Awaited<ReturnType<PhaseSteps[K]>>>;
  }
  gate(c: PhaseContext): Promise<GateOutcome> {
    return this.next('gate', c);
  }
  acquire(c: PhaseContext): Promise<AcquireOutcome> {
    return this.next('acquire', c);
  }
  plan(c: PhaseContext): Promise<PlanOutcome> {
    return this.next('plan', c);
  }
  implement(c: PhaseContext): Promise<ImplementOutcome> {
    return this.next('implement', c);
  }
  review(c: PhaseContext): Promise<ReviewOutcome> {
    return this.next('review', c);
  }
  verify(c: PhaseContext): Promise<VerifyOutcome> {
    return this.next('verify', c);
  }
  drift(c: PhaseContext): Promise<DriftOutcome> {
    return this.next('drift', c);
  }
  ship(c: PhaseContext): Promise<ShipOutcome> {
    return this.next('ship', c);
  }
  resumeHandoff(c: PhaseContext): Promise<ResumeHandoffOutcome> {
    return this.next('resumeHandoff', c);
  }
  track(c: PhaseContext): Promise<ControllerTrackOutcome> {
    return this.next('track', c);
  }
}

/** Real stores/ledgers with explicit observable recovery sequencing. */
export class ScriptedRecovery implements RecoveryHooks {
  readonly calls: string[] = [];
  reconcile: (hold: BudgetReservation) => ReturnType<RecoveryHooks['reconcileHold']> = async () =>
    null;
  intentRun?: RunRecord;
  handoffRun?: RunRecord;
  trackerRun?: RunRecord;
  openStore(root: string, runId: string): RunStore {
    this.calls.push('store');
    return RunStore.open(root, runId);
  }
  openBudget(store: RunStore): BudgetLedger {
    this.calls.push('budget');
    return new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
  }
  async reconcileHold(hold: BudgetReservation) {
    this.calls.push('hold');
    return this.reconcile(hold);
  }
  async reconcileVms(_c: PhaseContext, cleanup: () => Promise<void>) {
    this.calls.push('vm');
    await cleanup();
  }
  async recoverCredentials() {
    this.calls.push('credentials');
  }
  async resumeIntents() {
    this.calls.push('intents');
    return this.intentRun;
  }
  async resumeHandoff() {
    this.calls.push('handoff');
    return this.handoffRun;
  }
  async resumeTracker() {
    this.calls.push('tracker');
    return this.trackerRun;
  }
  async killAll() {
    this.calls.push('kill');
  }
}
