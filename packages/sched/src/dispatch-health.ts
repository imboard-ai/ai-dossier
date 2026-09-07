/**
 * Confirmed-dispatch-failure health tracking, shared by the per-issue
 * dispatch path (`engine.ts`) AND every batch dispatch path (`batch-
 * dispatch.ts`: tail, member, fix, report) — ai-dossier#629.
 *
 * A dispatch result carrying `api_error_status` or `terminal_reason:
 * "api_error"` (see `parseDispatchApiError` in `@ai-dossier/core`) is a
 * confirmed provider-side wall (a spend/rate limit, an auth failure the
 * provider itself rejected), never an agent that ran and exited without
 * posting a milestone. Both shapes look identical to a reconciler that only
 * checks "did the process exit unverified" — that is exactly why the batch
 * tail respawned nine times in 33 minutes against a spend-limit wall before
 * an operator killed the tick (#629's own incident).
 *
 * This module is deliberately its OWN file, not added to `engine.ts`:
 * `engine.ts` imports from `batch-dispatch.ts` (for `runBatchTick`), so a
 * shared helper placed in `engine.ts` would create a cycle the moment
 * `batch-dispatch.ts` needed it too — exactly the trap `docs/agent-traps.md`
 * already documents for this pair of files ("any engine-side behavior added
 * to per-issue dispatch does NOT automatically apply to batches"). Decoupled
 * from both `TickCtx` (engine.ts) and `BatchDispatchDeps` (batch-dispatch.ts)
 * via a plain journal callback, so neither module needs the other's context
 * type.
 *
 * Deliberately a SEPARATE counter from `consecutive_suspect_dispatches`
 * (#505), not a variant of it: that counter requires a DIFFERENT unit for
 * each consecutive hit (cross-unit correlation rules out one unit's own
 * flakiness, since `suspect-dispatch` is inferred from timing, not a parsed
 * field). A confirmed API error needs no such hedge — the classification
 * itself already proves it, and the real incident was the SAME unit
 * (`batch:<id>`) nine times running. Reuses the SAME pause action and
 * threshold as #505 (`setPaused`, `DISPATCH_UNHEALTHY_THRESHOLD`) — the
 * "existing #505 mechanism" AC2 asks for — just gated on its own counter.
 */

import type { DispatchApiError } from '@ai-dossier/core';
import { setPaused } from './scheduler';
import { DISPATCH_UNHEALTHY_THRESHOLD, type JournalEventName, type SchedState } from './types';

/** Journals one event against a unit — the shape both `engine.ts`'s and `batch-dispatch.ts`'s own journal helpers already satisfy. */
export type DispatchHealthJournal = (
  event: JournalEventName,
  unit: string,
  extra: Record<string, unknown>
) => void;

/**
 * The journal `detail` string for a confirmed dispatch failure — the
 * provider's own message when it reported one, else a status/reason-derived
 * fallback. Never the free-text message alone as the CLASSIFICATION signal
 * (that stays `api_error_status`/`terminal_reason`, in `@ai-dossier/core`);
 * this is purely what an operator reads.
 */
export function dispatchApiErrorDetail(apiError: DispatchApiError): string {
  return (
    apiError.message ??
    `provider API error${apiError.apiErrorStatus !== null ? ` (${apiError.apiErrorStatus})` : ''}`
  );
}

/**
 * The journal/evidence fields a confirmed dispatch failure carries, shared by
 * every emitter (this module's own `dispatch-failure` journal call, and
 * `engine.ts`'s `enterRecovery` evidence for the per-issue path's single
 * emission — see `recordDispatchApiError`'s `journalFailure` option) so a
 * field added to `DispatchApiError` cannot drift between two hand-written
 * copies (#629 review).
 */
export function dispatchApiErrorFields(apiError: DispatchApiError): Record<string, unknown> {
  return {
    ...(apiError.apiErrorStatus !== null ? { api_error_status: apiError.apiErrorStatus } : {}),
    ...(apiError.terminalReason !== null ? { terminal_reason: apiError.terminalReason } : {}),
    ...(apiError.resetAt !== null ? { reset_at: apiError.resetAt } : {}),
    empty_model_usage: apiError.emptyModelUsage,
    is_error: apiError.isError,
  };
}

/**
 * Record a CONFIRMED dispatch failure against the shared #629 streak. At
 * `DISPATCH_UNHEALTHY_THRESHOLD`, pauses new assignments exactly like
 * `recordDispatchOutcome`'s #505 path and journals `dispatch-unhealthy`.
 *
 * `journalFailure` (default `true`) controls whether this function ALSO
 * journals `dispatch-failure` itself. The batch paths have no other emitter,
 * so they keep the default. The per-issue path passes `false`: its caller,
 * `engine.ts`'s `enterRecovery`, journals its own `causeEvent` (=
 * `'dispatch-failure'`) with richer evidence (`slot`, `last_progress_at`)
 * immediately afterward — without the flag, one confirmed error produced TWO
 * `dispatch-failure` entries on that rail and one on the batch rail, silently
 * double-counting any journal-derived tally (#629 review).
 */
export function recordDispatchApiError(
  journal: DispatchHealthJournal,
  state: SchedState,
  unit: string,
  apiError: DispatchApiError,
  options: { journalFailure?: boolean } = {}
): SchedState {
  const count = state.consecutive_dispatch_api_errors + 1;
  let next: SchedState = {
    ...state,
    consecutive_dispatch_api_errors: count,
    // Unconditionally the LATEST error's own reset time, never a fallback to
    // the streak's previous value: a stale reset time from an earlier hit
    // that has already passed is actively misleading once the CURRENT error
    // reports none (#629 review) — null correctly means "no reset time known
    // for the current streak", not "carry the old one forward".
    dispatch_pause_reset_at: apiError.resetAt,
  };

  if (options.journalFailure ?? true) {
    journal('dispatch-failure', unit, {
      detail: dispatchApiErrorDetail(apiError),
      ...dispatchApiErrorFields(apiError),
    });
  }

  if (count >= DISPATCH_UNHEALTHY_THRESHOLD && !next.paused) {
    next = setPaused(next, true);
    journal('dispatch-unhealthy', unit, {
      detail: `${count} consecutive confirmed dispatch failures (${apiError.terminalReason ?? apiError.apiErrorStatus ?? 'api_error'}) — new assignments paused; \`sched resume\` once dispatch is healthy${apiError.resetAt ? ` (provider reset at ${apiError.resetAt})` : ''}`,
    });
  }
  return next;
}

/**
 * A verified completion, a confirmed park, or (since a batch dispatch has no
 * separate escalation ladder to distinguish it from) a successful batch
 * tail/member/report resets the confirmed-failure streak. Deliberately NOT
 * reset by a plain unverified exit on the per-issue rail — unlike
 * `consecutive_suspect_dispatches`, which `recordDispatchOutcome` clears on
 * any non-suspect outcome — because an unverified exit is not evidence the
 * provider wall has cleared, only that this particular dispatch was not
 * ITSELF classified as one (#629 review).
 */
export function resetDispatchApiErrorStreak(state: SchedState): SchedState {
  if (state.consecutive_dispatch_api_errors === 0 && state.dispatch_pause_reset_at === null) {
    return state;
  }
  return { ...state, consecutive_dispatch_api_errors: 0, dispatch_pause_reset_at: null };
}
