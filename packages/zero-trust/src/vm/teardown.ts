/** Bounded VM teardown (PRD §5.9, scenario 20). Three failed deletions put the
 * run in `blocked_cleanup`, which has no edge back to execution or shipping. */
import { isAdmitted, type OperationKind } from '../intents';
import type { Journal } from '../journal';
import { ReasonCode, type RunRecord, TERMINAL_STATES, transitionRun } from '../state';
import { appendVmEvent, type VmAdapter, VmCleanupError, type VmHandle } from './adapter';

export const MAX_CLEANUP_ATTEMPTS = 3;

export class PublicationDeniedError extends Error {
  constructor(readonly state: string) {
    super(`Publication denied in run state ${state}`);
    this.name = 'PublicationDeniedError';
  }
}

export type TeardownOutcome =
  | { readonly kind: 'destroyed'; readonly attempts: number; readonly run: RunRecord }
  | {
      readonly kind: 'blocked_cleanup';
      readonly attempts: number;
      readonly run: RunRecord;
      readonly leftoverPids: readonly number[];
      readonly leftoverPaths: readonly string[];
    };

export async function teardownVm(
  adapter: Pick<VmAdapter, 'destroy'>,
  handle: Pick<VmHandle, 'vmId' | 'runId'>,
  run: RunRecord,
  options: {
    /** Dedicated VM event journal (see LocalQemuOptions.journal). */
    journal?: Journal;
    /** Persists the blocked run where the admission fence reads it, e.g.
     * `IntentDriver.observeRun`, before the outcome is returned. */
    observeRun?: (run: RunRecord) => void;
    now: () => Date;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Reconcile an already fenced stop without inventing a new lifecycle edge. */
    reconcileStopped?: boolean;
  }
): Promise<TeardownOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: VmCleanupError | null = null;
  for (let attempt = 1; attempt <= MAX_CLEANUP_ATTEMPTS; attempt++) {
    try {
      await adapter.destroy(handle);
      return { kind: 'destroyed', attempts: attempt, run };
    } catch (error) {
      last =
        error instanceof VmCleanupError
          ? error
          : new VmCleanupError([], [`unknown:${handle.vmId}`], handle.vmId);
      appendVmEvent(options.journal, options.now(), {
        type: 'vm_cleanup_attempt_failed',
        runId: handle.runId,
        vmId: handle.vmId,
        attempt,
        // The error class only: messages can carry paths or guest text.
        cause: error instanceof Error ? error.name : typeof error,
        leftoverPids: last.leftoverPids,
        leftoverPaths: last.leftoverPaths,
      });
      if (attempt < MAX_CLEANUP_ATTEMPTS) await sleep(options.retryDelayMs ?? 1000);
    }
  }
  const failure = last as VmCleanupError;
  // Reconciliation of an already fenced stop must not invent an illegal lifecycle
  // edge or erase a previously recorded terminal outcome.
  const blocked =
    options.reconcileStopped &&
    (run.state === 'blocked_cleanup' || TERMINAL_STATES.includes(run.state))
      ? run
      : transitionRun(run, ReasonCode.CleanupFailed, options.now().toISOString());
  options.observeRun?.(blocked);
  appendVmEvent(options.journal, options.now(), {
    type: 'vm_cleanup_blocked',
    runId: handle.runId,
    vmId: handle.vmId,
    state: blocked.state,
    leftoverPids: failure.leftoverPids,
    leftoverPaths: failure.leftoverPaths,
  });
  return {
    kind: 'blocked_cleanup',
    attempts: MAX_CLEANUP_ATTEMPTS,
    run: blocked,
    leftoverPids: failure.leftoverPids,
    leftoverPaths: failure.leftoverPaths,
  };
}

/** Must be called by the shipping broker before any GitHub write. Delegates to
 * the intent admission table, which admits nothing in `blocked_cleanup`. */
export function assertPublicationPermitted(run: RunRecord, operationKind: OperationKind): void {
  if (!isAdmitted(operationKind, run.state)) throw new PublicationDeniedError(run.state);
}
