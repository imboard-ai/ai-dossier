# Reports index

Gate reports and validation records produced for [RFC-0001](../../rfcs/0001-batch-cycles.md) (Batch Cycles), tracked under epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474).

| Report | Gate | Verdict | Date |
|---|---|---|---|
| [`sched-parity.md`](./sched-parity.md) | RFC-0001 Step 1 exit gate (issue #471) | Conditional GO — conditions (#496, #500) cleared 2026-09-01 | 2026-08-30 |
| [`batch-pilot.md`](./batch-pilot.md) | RFC-0001 Step 3 gate (issue #473) | NO-GO — batches not executable (zero ever dispatched) | 2026-09-01 |
| [`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md) | Pilot attempt 2 execution record (issue #526); GO/NO-GO deferred to #529 | 0 of ≥3 batches executed end-to-end (AC1 unmet) — two independent blockers: cohort scarcity (only 1 batch composable) and seal bug #535 (closed) | 2026-09-01 |
| [`model-agnostic-fleet.md`](./model-agnostic-fleet.md) | Model-agnostic fleet validation (issue #528) | PARTIAL — retrospective parity holds (86% vs 86%); pre-registered live run not executed; #528 stays open (ac_met=0/5, decision-pending) | 2026-09-01 |
| [`issue-538-classifier-cost-methodology.md`](./issue-538-classifier-cost-methodology.md) | #538 AC3 cost methodology | PARTIAL — pre-screen hit rate measured on the 15-issue fixture set (7/15 rejected, 0 tokens); post-#538 per-issue cost is still an estimate — live re-measurement pending an ops dispatch run | 2026-09-02 |

Raw evidence backing these reports (baseline tables, agent-log summaries, scheduler event journals, captured corrupt-state files) lives in [`evidence/`](./evidence/).
