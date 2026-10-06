/** Bounded VM teardown (PRD §5.9, scenario 20). Three failed deletions put the
 * run in `blocked_cleanup`, which has no edge back to execution or shipping. */
import type { Journal } from '../journal';
import { ReasonCode, type RunRecord, transitionRun } from '../state';
import { type VmAdapter, VmCleanupError, type VmHandle } from './adapter';

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
    journal?: Journal;
    now: () => Date;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
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
          : new VmCleanupError([], [`unknown:${handle.vmId}`]);
      options.journal?.append({
        v: 1,
        at: options.now().toISOString(),
        type: 'vm_cleanup_attempt_failed',
        runId: handle.runId,
        vmId: handle.vmId,
        attempt,
        leftoverPids: last.leftoverPids,
        leftoverPaths: last.leftoverPaths,
      });
      if (attempt < MAX_CLEANUP_ATTEMPTS) await sleep(options.retryDelayMs ?? 1000);
    }
  }
  const failure = last as VmCleanupError;
  const blocked = transitionRun(run, ReasonCode.CleanupFailed, options.now().toISOString());
  options.journal?.append({
    v: 1,
    at: options.now().toISOString(),
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

/** Called by the shipping broker before any GitHub write. Only a run that is
 * currently `shipping` may publish; `blocked_cleanup` can never get there. */
export function assertPublicationPermitted(run: RunRecord): void {
  if (run.state !== 'shipping') throw new PublicationDeniedError(run.state);
}
