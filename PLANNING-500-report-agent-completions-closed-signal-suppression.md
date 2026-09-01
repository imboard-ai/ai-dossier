# Issue #500: bug(sched): report-agent completion's closed-signal suppression is defeated by phase-updated — units complete without a report milestone

## Type
bug

## Problem Statement
Found during #471 (sched fleet-parity validation, W1, imboard#3891).

## Evidence (events.jsonl)

```
01:19:06 merge-accepted issue:3891 (PR #3925)          ← issue closes at merge
01:19:07 teardown-failed (bug #496)
01:19:07 report-dispatched  tier=mechanical (pid 16211)
01:20:06 exit-detected → verify-incomplete (no report milestone) → redispatched tier=mid (pid 17204)
01:21:06 phase-updated issue:3891 phase=ship           ← slot.phase overwritten 'report'→'ship'
01:22:06 exit-detected (agent B exits "waiting for the deploy run") → verify-complete
```

Result: the unit completed at 01:22:06 with no `report done` milestone on the issue (last milestone is `ship/awaiting-merge`). A rich "## Final Report" comment exists (posted by one of the report agents), but the runstate trail never records the tail.

## Root cause

`engine.ts` `effectiveClosedSignal()` suppresses the issue-closed completion signal for report agents via `slot.phase === 'report'` — "a report agent's issue is already closed (closed AT MERGE), so for report-phase slots the closed signal is suppressed — only the report milestone can complete them." But `applyProgressSignals()` journals `phase-updated` and overwrites `slot.phase` with the ISSUE's latest milestone phase (`ship`, post-park) on every reconcile tick. By the time a report agent exits, `slot.phase` is `ship`, the suppression no longer applies, `truth.closed` is true (closed at merge), and `isVerifiedComplete()` passes without any report milestone.

So the "only the report milestone can complete a report agent" invariant never actually holds in production: any report agent that exits without posting its milestone (crash, #497-style exit-while-waiting) still completes the unit silently.

## Fix direction

Track the agent ROLE (report vs cycle) as its own field that `phase-updated` never overwrites (or key the suppression off the assignment detail `report agent`), so the suppression survives phase tracking.

Filed per #471 scope (findings filed, not fixed inline). Related: #496 (teardown), #497 (exit-while-waiting — this is what the report agent did).
