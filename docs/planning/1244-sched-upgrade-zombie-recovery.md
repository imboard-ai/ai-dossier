# Issue #1244: scheduler upgrade, zombie liveness and recovery

## Problem

#1244: scheduler auto-upgrade re-exec discards child-process supervision while batch members remain alive; signal-0 then counts zombie agents as alive, producing agent-unkillable with no batch-preserving recovery. Bound this work to upgrade deferral, zombie-aware liveness/reaping, and an explicit liveness-gated recovery. Investigate the post-handoff stop request using offline reproduction; the lost-output/stall explanation in the report is a hypothesis, not established fact.

Classification-only light plan; dispatch_profile=openai (explicit user override), model=openai/gpt-6.1-sol, prod_data_access=none. The current source traces the trigger through cli/src/commands/sched.ts upgrade handoffs, packages/sched/src/dispatch.ts isAlive, and packages/sched/src/batch-dispatch.ts stopAgentBeforeDeciding. No production inspection is required.

## Acceptance Criteria

- [ ] An auto-upgrade with live member agents does not orphan them (test)
- [ ] A zombie child is reported dead and reaped, never `agent-unkillable` (test)
- [ ] `agent-unkillable` has a documented operator recovery that keeps the batch

## Predicted Files

- `cli/src/commands/sched.ts` — gate upgrades and route recovery.
- `cli/src/__tests__/commands/sched.test.ts` — upgrade and resume regressions.
- `cli/src/__tests__/sched-upgrade-process.test.ts` — live child supervision.
- `cli/src/__tests__/fixtures/sched-upgrade-fixture.mjs` — process fixture.
- `packages/sched/src/dispatch.ts` — zombie-aware liveness.
- `packages/sched/src/__tests__/dispatch.test.ts` — zombie/reaping controls.
- `packages/sched/src/batch-dispatch.ts` — batch recovery and stop evidence.
- `packages/sched/src/__tests__/batch-integration.test.ts` — preserve batch recovery.
- `packages/sched/README.md` — operator recovery.
- `packages/sched/package.json` — patch release.
- `cli/package.json` — patch release.
- `package-lock.json` — release metadata.

## Approach

1. Defer installation/handoff until no slot holds a live agent, including parallel batch members and other agent roles; cover both --once and continuous paths. Preserve the existing no-old-version-writes-after-install guarantee, PID identity checks, leases and worker-thread tick boundaries.
2. Reuse procStatFields to distinguish Z from live processes while retaining PID-start identity and platform fallback. Preserve event-loop child exit/reaping for owned children; do not claim signal-0 or a zombie-state observation itself reaps a child. Use a real process fixture to prove eventual disappearance/reaping rather than only mocked death.
3. Extend sched resume --batch for exactly agent-unkillable: recheck recorded agent identities/liveness under the existing state lock, refuse genuinely live agents, resume the appropriate existing execution position only when gone. Retain batch members, landed work, branches, worktrees and dispatch profile; avoid abandon/dissolve.
4. Reproduce the upgrade-to-stop sequence offline and explain whether stall/wrong-procedure/other evidence requested the stop; do not assume output streams were lost (current dispatch writes stdout/stderr to log files). Add the regression for the demonstrated cause within this lifecycle scope.
5. Keep #1245 separate: no terminal-record quarantine, abandon/dissolve membership invariant repair, state-load relaxation, or state schema migration here. No dependency on #1245 is necessary because recovery preserves the batch. #1243 shares cli/src/commands/sched.ts, CLI command tests and release metadata; coordinate shared edits/serialize integration as needed. #1248 is separate zero-trust recovery-test work, with only root lockfile churn potentially shared. No declared Depends-on edge exists.

## Test Scope

focused

Named regressions: cli/src/__tests__/commands/sched.test.ts; cli/src/__tests__/sched-upgrade-process.test.ts (with its existing fixture); packages/sched/src/__tests__/dispatch.test.ts; packages/sched/src/__tests__/batch-integration.test.ts. Exercise active parallel members blocking upgrade, upgrade after drain, real child exit/reaping, zombie-vs-live and PID-reuse controls, genuine unkillable refusal, and batch-preserving resume after death. Assert retained member/work/profile state and no duplicate dispatch. Run relevant CLI/scheduler builds and repository release-version validation during implementation; the batch's normal aggregate gate remains applicable. This plan records intended verification only; no tests or implementation were performed during classification.

## Plan Reuse

Validated prior trusted artifact (author has write access); five commits since its head do not supersede the lifecycle approach. Predicted file explanations shortened without changing paths. #1243/#1245 are now merged on base. The original plan remains linked in the issue.

## Reachability Evidence

`prod_data_access=none`: no production access by policy. Concrete triggers: a tick dispatches agents and invokes staleness handling; process.execve retains the parent PID but loses libuv child watchers. A terminated child remains Z until its parent processes SIGCHLD. stopAgentBeforeDeciding only runs for member terminal/wrong-procedure decisions, not lost output streams. Recovery begins at an existing executing-member block with retained slots.

## Reusable Code

procStatFields, slotsForBatch, transitionBatch, SchedStore.withLock, existing upgrade process fixture and batch integration harness.

## Risk Areas

Keep PID-reuse/platform fallbacks, owned child event-loop reaping and worker ownership intact. A slot may be released while its agent still exits, so slot-only liveness needs scrutiny. Trap index: durable plan lives here because PLANNING files are ignored; keep release versions above base tip; mock CLI source alias, not compiled CommonJS.

## Open Questions

None blocking. The historical stop trigger cannot be attributed from issue timestamps alone; offline tests will distinguish terminal/wrong-procedure input from mere restart.

### Investigation result

Offline existing real-agent regressions reproduce both stop inputs: a full-cycle-shaped milestone triggers `wrong-procedure`; a parallel member's valid review-done milestone triggers `member-complete` before landing. There is no output/stall check on either path. The incident's timestamps alone cannot distinguish these two; new `reason` fields on member-stop-requested record the exact input. Zombie liveness was reproduced red on isolated base b96c77a (signal 0 succeeds, old isAlive returns true), green on this branch with actual /proc disappearance after yielding to libuv.

Implementation also touches the tick worker/runner and their existing tests to carry owned-child drain evidence across thread boundaries, exports the recovery helper through index.ts, and adds a dedicated real-process liveness test file. These are lifecycle coverage refinements to the predicted files.

Verification: all workspace suites and root script tests passed. Initial make test hit the outer 20-minute timeout in the large unchanged zero-trust suite; the retry with two workers and a 60-second per-test timeout passed (5,039 tests). Scheduler 1,433 tests and CLI 2,245 tests passed. No CI-parity shell script exists; make check, make lint and make build-all are the local gates.

### Review refinements

The blind review reproduced zombies inherited across old-image execve and tick-worker death. Node cannot wait for a child whose libuv wait handle no longer exists. At completed tick boundaries, Linux task-child enumeration now fences inherited live children too; when every agent and known callback drains but unknown zombies remain, both once/continuous callers exit 75 (not execve). OS reparenting reaps them and the supervisor starts fresh on retained state. New real-process fixtures prove /proc disappearance for both ownership-loss paths and exercise the production CLI caller, including its compiled continuous tick worker. This runs independently of the auto-upgrade setting to recover old-image incidents.

The ineffective-kill stamp no longer suppresses an interrupted batch-block transition. Upgrade deferrals carry deduplicated slot/PID/child diagnostics and a drained event. CLI README, autonomous-pipeline guide and help now describe post-tick drain instead of live-agent handoff. Existing runstate fence liveness remains outside this issue's changed agentAlive/upgrade/member-recovery surface; the DRY review's independent boundPidAlive drift was dismissed as out-of-diff rather than broadening fence semantics here.

## Visual Review

- [x] Not required (backend/CLI only)

## Base Branch

`main`
