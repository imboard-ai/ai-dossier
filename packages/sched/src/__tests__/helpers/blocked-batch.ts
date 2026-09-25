/**
 * A state holding one gate-BLOCKED batch whose single member was dispatched and
 * committed — the shape `sched attach-pr` (#824) acts on. Built through the real
 * enqueue + transition rails, never a hand-written state literal, so it tracks
 * the state machine. Shared by the sched and CLI attach-pr suites.
 */

import { enqueueEntries } from '../../enqueue';
import { transitionBatch, transitionIssue } from '../../state';
import type { SchedState } from '../../types';

export function withBlockedBatch(
  state: SchedState,
  opts: {
    batchId: string;
    member: number;
    anchor: number;
    branch: string;
    at: Date;
    /** Extra members left `waiting` — never dispatched. */
    undispatched?: number[];
  }
): SchedState {
  const { batchId, member, anchor, branch, at, undispatched = [] } = opts;
  let s = enqueueEntries(
    state,
    [
      { issue: member, mode: 'slot', batch: batchId, anchor },
      ...undispatched.map((issue) => ({ issue, mode: 'slot' as const, batch: batchId })),
    ],
    at
  );
  for (const to of ['classified', 'batched', 'waiting', 'in-work', 'committed'] as const) {
    s = transitionIssue(s, member, to, {}, at);
  }
  for (const issue of undispatched) {
    for (const to of ['classified', 'batched', 'waiting'] as const) {
      s = transitionIssue(s, issue, to, {}, at);
    }
  }
  // `enqueueEntries` lands a freshly-formed batch at `ready` — record the
  // branch on the next legal edge, then block it the way a gate does.
  s = transitionBatch(s, batchId, 'executing', { branch, base_branch: 'main' }, at);
  return transitionBatch(
    s,
    batchId,
    'blocked',
    { blocked_reason: 'gate-inconclusive:test.focused' },
    at
  );
}
