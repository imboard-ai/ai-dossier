# Reports index

Gate reports and validation records produced for [RFC-0001](../../rfcs/0001-batch-cycles.md) (Batch Cycles), tracked under epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474).

| Report | Gate | Verdict | Date |
|---|---|---|---|
| [`sched-parity.md`](./sched-parity.md) | RFC-0001 Step 1 exit gate (issue #471) | Conditional GO — conditions (#496, #500) cleared 2026-09-01 | 2026-08-30 |
| [`batch-pilot.md`](./batch-pilot.md) | RFC-0001 Step 3 gate (issue #473) | NO-GO — batches not executable (zero ever dispatched) | 2026-09-01 |
| [`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md) | Pilot attempt 2 execution record (issue #526); GO/NO-GO deferred to #529 | 0 of 4 dispatched batches completed end-to-end across three runs (AC1 unmet). Run 1 blocked before dispatch (#535/#539, both since fixed); run 2 dispatched 3 batches and all 3 dissolved — B3a unwarmed batch worktree, B3b `npm test -- --reporter=json` vs a `make`-delegating test script, B3c 1/3 eviction tolerance, B3d null per-issue telemetry (all fixed); run 3 reached execution for the first time — warm worktree in &lt;1 s, both members' agents ran — and dissolved on #579 (`plan validate` exit 128, fixed mid-run by PR #581) and #583 (incremental gate reads INCONCLUSIVE as a member failure, open). First controlled same-issue comparison: −49% cost, ceiling stated | 2026-09-02 |
| [`model-agnostic-fleet.md`](./model-agnostic-fleet.md) | Model-agnostic fleet validation (issue #528) | PARTIAL — Part I: retrospective parity holds (86% vs 86%). Part II: `model × class` axis built and populated; conformance parity sharper (glm 0/73 vs sonnet 9/159 criteria not-met); live run still NOT executed and re-escalated — #528 stays open (ac_met=0/5) | 2026-09-02 |
| [`issue-538-classifier-cost-methodology.md`](./issue-538-classifier-cost-methodology.md) | #538 AC3 cost methodology | PARTIAL — pre-screen hit rate measured on the 15-issue fixture set (7/15 rejected, 0 tokens); post-#538 per-issue cost is still an estimate — live re-measurement pending an ops dispatch run | 2026-09-02 |

Raw evidence backing these reports (baseline tables, agent-log summaries, scheduler event journals, captured corrupt-state files) lives in [`evidence/`](./evidence/).

Not a gate report, but standing alongside them: [`model-scorecard.md`](./model-scorecard.md) is a recurring cost/quality/speed tab per LLM ([#566](https://github.com/imboard-ai/ai-dossier/issues/566)), regenerated weekly (`npm run scorecard`) rather than produced once per gate. Its JSON sidecar lives at [`evidence/model-scorecard.json`](./evidence/model-scorecard.json).
