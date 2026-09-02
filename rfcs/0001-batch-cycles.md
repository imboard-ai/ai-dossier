# RFC-0001: Batch Cycles — Deterministic Scheduling and Batched Issue Execution

- **Status**: Accepted (in rollout)
- **Author(s)**: Yuval Dimnik
- **Created**: 2026-08-29
- **Related**: Epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474) (implementation tracking: #458–#473, Step-3 retry #523–#538, model-agnosticism #527/#528, pilot batch 3 anchor [#549](https://github.com/imboard-ai/ai-dossier/issues/549): #540, #542, #543) · full-cycle-issue v3.14.1, fleet-cycle v1.7.0 (registry: imboard-ai/git/*) · Progressive Determinism brief

## Status log

- **2026-08-30** — parity gate [`docs/reports/sched-parity.md`](../docs/reports/sched-parity.md): Conditional GO, contingent on #496/#500 — conditions cleared 2026-09-01.
- **2026-09-01** — pilot attempt 1 [`docs/reports/batch-pilot.md`](../docs/reports/batch-pilot.md): NO-GO — batches not executable (zero batches ever dispatched).
- **2026-09-01** — pilot attempt 2, run 1 [`docs/reports/batch-pilot-2-execution.md`](../docs/reports/batch-pilot-2-execution.md) Part I: 0 of ≥3 batches executed end-to-end — two independent blockers: seal bug #535 (closed 2026-09-01) and a cohort too small to compose 3 batches.
- **2026-09-02** — pilot attempt 2, run 2 [`docs/reports/batch-pilot-2-execution.md`](../docs/reports/batch-pilot-2-execution.md) Part II: 3 batches dispatched (the first real batch executions), 3 dissolved, 0 end-to-end. Four new defects B3a-B3d; first controlled batch-vs-full-cycle comparison (−49% cost on n=2, ceiling stated). GO/NO-GO remains [#529](https://github.com/imboard-ai/ai-dossier/issues/529).
- **2026-09-02** — status raised to Accepted (in rollout) ([#542](https://github.com/imboard-ai/ai-dossier/issues/542)); tracked in epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474).

**Rollout position (§G):** Step 1's machinery shipped and its exit gate passed. Step 0's telemetry shipped (#458/#524/#531), but the baseline measurement itself is still outstanding. Step 2's classifier and batch-prep shipped, but its exit criterion is not yet met — 20.0% slot rate measured against a ~50% target; a misclassification denominator now exists (run 2 contradicted 1 of 4 hand-applied `cycle:slot` labels) ([`docs/reports/batch-pilot-2-execution.md`](../docs/reports/batch-pilot-2-execution.md)). Step 3 (first real batches) has now dispatched batches but not yet carried one end-to-end — its GO/NO-GO is [#529](https://github.com/imboard-ai/ai-dossier/issues/529). Step 4 (widen) is not started.


## Executive summary

The proposal is worth implementing, with four structural changes:

1. **Build the deterministic scheduler first, alone.** Fleet's named failure (slots going idle when a subagent finishes) is a scheduling bug being "fixed" with prompting. A `dossier-sched` state machine fixes it with zero batching risk, and every later piece (batching, escalation, tail runs, capability execution) needs it as a host. Batching built on today's LLM supervision loop would inherit the exact failure it's meant to escape.
2. **`batch-cycles` should not be a dossier.** The top orchestrator is software — the scheduler — with LLM calls at three defined joints (classification, dependency inference, failure triage). Five proposed dossiers become **three** (classifier, batch-prep, slot-cycle) plus the scheduler plus modifications to the existing family.
3. **Keep per-issue blind conformance inside the batch path.** It is the family's trust anchor, it is cheap (one agent), and sharing it would trade exactly the confidence the batch path must preserve. Share the *lifecycle* (setup, full suite, CI, ship, deploy), never the *per-issue verification*.
4. **Batch PRs cannot squash-merge.** Squash collapses per-issue commits into one, destroying issue-level attribution in main history and breaking eviction/bisect. Batch PRs need rebase-merge (repo setting + auto-merge watcher change). This is a small external change with a long lead time — start it first.

Expected steady-state effect for slot-eligible issues: **~2–4× token reduction, CI executions from N per N issues to ~1 + focused runs, throughput bounded by real capacity instead of supervision reliability.** Per-issue *latency* may increase slightly (issues wait for batch-mates); throughput and cost improve. Numbers must be validated against a measured baseline (Phase 0) — at RFC authoring nothing recorded tokens. (Since addressed: `ai-dossier run` records duration/cost/tokens per run (#458) and scheduler-dispatched agents get per-issue telemetry via `ai-dossier sched stats` (#524/#531); the baseline measurement itself is still outstanding.)

---

## A. Current-state architecture

### The single-issue path (full-cycle-issue v3.14.1)

Seven composed sub-dossiers, each an independently versioned, signed registry unit:

| Phase | Dossier | Size | What it does |
|---|---|---|---|
| gate | gate-issue v1.5.2 (now 1.6.1) | 12.4 KB | blocks closed/epic/vague/dup issues; mints `run_id`; derives `resume_from` via `ai-dossier runstate verify` |
| setup | setup-issue-workflow v1.13.1 (now 1.14.1) | 18.9 KB | branch `{type}/{n}-{slug}`; worktree via pool claim (~2 s) or cold (3–5 min + warm-worktree v1.2.0); immediate push |
| plan | plan-issue v1.6.0 (now 1.7.1) | 11.6 KB | PLANNING-{n}-{slug}.md; ACs into the `phase=plan` milestone (`ac<n>=`); prod reachability check |
| implement | implement-issue v1.7.2 (now 1.7.3) | 11.9 KB | code; lint cascade (ci-parity.sh → project script → toolchain detect); diff-scoped tests; pre-existing-failure discrimination |
| review | review-issue v1.11.1 (now 1.12.1) | 23.4 KB | risk floor + per-dimension tier (micro/docs/small/full); 1–7 report-only agents incl. blind conformance (strongest model); serial apply |
| ship | ship-issue v1.11.1 (now 1.12.1) | 27.5 KB | CI-trigger gate (`[skip ci]` head defense ×3); PR; attached = drive merge + deploy-confirm + teardown; detached = park on `auto-merge`, stop |
| report | report-issue v1.6.1 (now 1.7.1) | 11.0 KB | honesty-gated report (`MERGE_COMMIT`, `Shipped`/`DEPLOYED`); agent-traps write-back |

Dossier versions and sizes in the table are those at RFC authoring (2026-08-29); parenthesised `now` values are current as of 2026-09-02. `full-cycle-issue v3.14.1` and `fleet-cycle v1.7.0` above are still the current versions.

State model: **origin/<branch> is the durable work copy; append-only `<!-- runstate:v1 -->` issue comments are the durable state copy** (WIP Sync Rule). Any machine can resume any phase (gate → `runstate verify`). Model routing is role-based (mechanical/generation/judgment) with a 2-step escalation ladder.

### The multi-issue path (fleet-cycle v1.7.0)

LLM orchestrator: resolves set → builds dependency DAG (serialize-when-unsure) → merge-gated waves → dispatches detached full-cycle runs (agent exits at "PR parked") → **LLM supervises** via "armed watch" prose discipline → polls parked PRs → dispatches a *tail full-cycle run* per merged PR for teardown+report → blocks transitive dependents on failure → aggregate report. `max_parallel` (default 3) bounds live agents.

### Supporting machinery (this repo, confirmed)

- **CLI 0.11.0 at RFC authoring, now 0.27.0** (`main/cli/`): `run` (verify → spawn `claude -p` headless; no opencode support in `helpers.ts` auto-detection at authoring — relevant given fleet's OpenCode/Kimi failures; since added, `helpers.ts` auto-detection now falls back to `opencode`, #476), `runstate mint|post|last|verify|stats`, registry ops. Run audit: `~/.dossier/runs.jsonl` — timestamps/dossier/source only, **no tokens, no durations, no commands** (as of RFC authoring; since fixed — duration/cost/tokens per run by #458, and per-issue telemetry for scheduler-dispatched agents by #524/#531).
- **worktree-pool** (`main/packages/worktree-pool/`): `status|claim|return|replenish|refresh|gc|init|detect`; config `.worktree-pool.json` (`base_ref`, `warm_commands`, `target_spares`, `max_pool_size`); pool warm-up is now package-manager-aware (#433).
- **mcp-server orchestration** (`main/mcp-server/src/orchestration/`): graph/journey machinery (`buildExecutionPlan`, `startJourney`/`stepComplete`) — exists but is **not used** by the issue-workflow family. Its granularity is dossier-dependency graphs, not issue scheduling; reviewed and set aside (see C.7 rejected alternatives).
- **Repo-local scripts** (imboard): `scripts/ci-parity.sh`, `scripts/ensure-test-env.sh` — proto-capabilities per the Progressive Determinism brief.
- **External:** auto-merge watcher Action (imboard repo; the presence-of-checks gap (issue #3799 — the watcher merged PR #3797 with zero check-runs) was fixed for default-branch PRs by imboard PR #3803, merged 2026-08-26. Remaining gaps for this plan at authoring — no rebase-merge support, and no presence floor for PRs targeting non-default branches — were covered by imboard#3902, which shipped 2026-08-29 (imboard PR #3905): rebase-merge for `batch-epic`-labelled PRs, and the presence-of-checks floor extended to every PR. The §G Step 3 external prerequisite is therefore cleared).

### Q2 — Where the cost actually is (per issue, today)

| Cost | Repeated per issue? | Shareable? |
|---|---|---|
| Runbook prose loaded into context: ~25–30k tokens/run (ship+review = 36%) | yes | yes — batch amortizes; capabilities (Prog. Det.) delete it |
| Environment: setup + warmup reasoning; cold start 3–5 min when pool empty | yes | yes — once per batch |
| Planning: up to 3× (triage, fleet prep, plan-issue) | yes | yes — plan artifact reuse |
| Review fan-out: 1–7 agents, each loading diff + conventions | yes | mostly — aggregate review once; **conformance stays per-issue** |
| Ship: CI-trigger ceremony, PR, poll loops, merge watch, deploy confirm, teardown | yes | yes — once per batch |
| Full CI suite + deploy pipeline | yes (per PR) | yes — once per batch PR |
| Fleet supervision tokens (LLM polling/dispatching) | per fleet | yes — becomes code ($0) |
| Implementation reasoning; focused tests; per-issue conformance | yes | **no — must stay per-issue** |

No token telemetry exists; `runstate stats` gives phase durations only. **Phase 0 must add measurement before we can claim numbers.** (Since addressed: `ai-dossier run` records duration/cost/tokens per run (#458); scheduler-dispatched agents get per-issue telemetry via `ai-dossier sched stats` (#524/#531).)

### Q3 — Where the latency actually is

1. **Scheduler idle time** — the dominant *fleet* latency and the named bug: a finished subagent's slot stays empty because the LLM loop didn't notice. Unbounded; worst class.
2. **CI/build latency** — per-PR full suite + up-to-25-min merge watch + deploy, ×N issues.
3. **Serial lifecycle overhead** — gate/setup/ship ceremony per issue even when pooled (~minutes each).
4. **Model latency** — phases are serial within a run; review is the one parallel fan-out.
5. **Tail-run ceremony** — a whole re-dispatched full-cycle (gate → resume mapping) to run a deterministic teardown.

Batching attacks 2–3; the scheduler attacks 1 and 5; capabilities attack 3 and the runbook share of 4.

---

## B. Proposed architecture

### One concrete walkthrough first

You hand the system 12 ready issues: `dossier-sched enqueue 101..112`.

1. **Prep** (one LLM run, judgment tier): batch-issues-preparation normalizes the 12, finds one explicit dependency (#108 depends on #104), classifies: #103 touches a migration → `cycle:full`; #109 touches auth → `cycle:full`; the other 10 → `cycle:slot`. It composes two batches from the 10 by predicted file-disjointness and size caps: **B1** = {#101, #102, #104, #106, #107} (5 issues, est. 900 diff lines), **B2** = {#105, #108, #110, #111, #112}. #108's dependency on #104 puts B2 *after* B1 (batch-level edge). It opens two `batch-epic` anchor issues with task lists, posts a `phase=classify` runstate record on every issue, and writes the machine-readable plan to the scheduler queue.
2. **Scheduler** (no LLM): 4 slots configured. It starts full-cycle #103 (slot 1), full-cycle #109 (slot 2), and batch B1 (slot 3). B2 waits on B1's merge. Slot 4 holds for B1's member work (see concurrency, D.3).
3. **Batch B1 executes**: scheduler claims one pool worktree, creates branch `batch/b1-20260829`, then dispatches **slot-cycle agents one at a time, a fresh agent per issue, in the same worktree**: each validates/refines the issue's plan artifact, implements, runs focused tests + changed-file lint (capability `test.focused` where the manifest has it), gets a per-issue blind conformance verdict, and lands **exactly one commit `fix: … (#101)`** pushed at the issue boundary. After each issue the scheduler runs the incremental gate (typecheck + focused tests) — cheap interference detection.
4. **Batch lifecycle once**: full suite + ci-parity → one aggregate review (tiered on the combined diff; per-issue ACs already verified) → ship once: one PR "Batch b1: 5 issues", per-issue sections, `Closes #101 …`, CI runs once, parked on `auto-merge` with rebase-merge strategy. The scheduler (not an agent) watches `mergedAt`, then runs teardown as a script and dispatches one cheap report agent that posts per-issue completion comments + the batch report.
5. **A failure, attributed**: suppose the full suite fails on a test touching files #106 changed. The scheduler maps failing tests → issue by changed-path overlap; ambiguous → deterministic `git bisect` over the 5 issue-boundary commits running only the failing test. #106 gets one bounded fix attempt by a mid-tier agent; still red → scheduler reverts #106's commit, re-runs the suite (green), marks #106 `evicted → requeued as full-cycle`, and B1 ships with 4 issues. Nothing else is thrown away.
6. When B1's PR merges, B2 dispatches (its member #108 now branches from a base containing #104). The two full-cycles ran unchanged in parallel the whole time. Slots never sat idle while runnable work existed, because refill is a state-machine transition, not a remembered instruction.

### The layer diagram

```
                    ┌─────────────────────────────────────────────┐
   deterministic    │  dossier-sched  (new CLI component)         │
   orchestration    │  slots · queue · dispatch · completion ·    │
                    │  stall timers · PR watch · batch state      │
                    │  machine · eviction/bisect · resume         │
                    └───┬──────────────┬──────────────┬───────────┘
                        │ spawns       │ spawns       │ runs
   LLM where            ▼              ▼              ▼
   reasoning        full-cycle     slot-cycle     capabilities /
   is valuable      (unchanged,    (new, per-     scripts
                    the fallback)  issue, in      (.dossier/automation,
                        ▲          batch wt)      ci-parity, pool,
                        │              ▲          teardown, gh ops)
        batch-issues-preparation (new) │
        + issue-cycle-classifier (new) ┘
        (LLM, judgment tier, produces the queue)
```

Deterministic: everything in the top box, plus capability execution.
LLM: prep/classification, DAG inference, slot-cycle work, full-cycle runs, aggregate review, bounded failure-fix attempts, report narrative.

### Q18 — the five-dossier split, restructured

| Proposed in brief | Verdict |
|---|---|
| `issue-cycle-classifier` | **Keep, as a shared component** — a small dossier/prompt with structured output, invoked by batch-prep and reusable by triage. Not a standalone ceremony; its verdict is a `phase=classify` runstate record any consumer reads. |
| `slot-cycle` | **Keep** — the one genuinely new execution dossier. (Naming: "slot" collides with the scheduler's *execution slots*; consider `member-cycle` or `lite-cycle`. Non-blocking.) |
| `batch-issues-preparation` | **Keep** — judgment-heavy, belongs in a dossier. |
| `batch-issues` | **Do not build as a monolithic dossier.** The batch lifecycle is a state machine the scheduler owns; its LLM steps are dispatched individually. A batch-issues *dossier* would re-create fleet's supervision problem inside every batch. |
| `batch-cycles` | **Do not build as a dossier.** This is `dossier-sched`. |

Reused with modification: setup-issue-workflow (batch mode), review-issue (aggregate mode), ship-issue (batch mode), report-issue (batch report), gate-issue (slot-trail awareness). Deprecated after parity: fleet-cycle (becomes a thin alias that enqueues into sched).

---

## C. Component design

### C.1 `dossier-sched` (new; deterministic; in `main/cli/` or a new `packages/sched/`)

- **Purpose:** own every mechanical orchestration decision currently made by fleet-cycle prose: slot filling, completion detection, stall recovery, PR watching, batch sequencing, tail work, resume.
- **Form:** long-running process per project (`ai-dossier sched start`), plus `enqueue`, `status`, `pause`, `resume`, `abandon` subcommands. Also usable one-shot (`sched drain`) for cron-style operation.
- **Inputs:** queue entries (issue → mode, batch membership, deps, tier) written by batch-prep; config (`max_slots`, per-mode caps, stall timeout, escalation ladder tiers).
- **Outputs/persisted state:** `~/.dossier/sched/<project>/state.json` (transactional writes, journal-style) — hot operational truth; GitHub runstate comments + labels — durable/visible truth. On restart: read state.json, **reconcile against GitHub** (gate-issue's remote-first philosophy, now in code): PR merged? milestone advanced? worktree exists with matching head?
- **Dispatch:** spawns agent processes via the existing `run` machinery (`claude -p`, headless, `--model` per tier). **Extend `helpers.ts` LLM detection to support opencode** — fleet's observed OpenCode/Kimi supervision failures make agent-CLI plurality a real requirement.
- **Completion detection (Q15):** three event sources, none of them "an LLM remembers": (1) child-process exit (immediate slot refill candidate), (2) reconciliation tick (~60 s): verify the exited run's claimed state against runstate/GitHub before marking complete — *an agent exiting is not proof of anything* (fleet rule 8, now enforced by code), (3) GitHub poll (~2–3 min) for parked PRs and label changes.
- **Stall/escalation:** per-run timer keyed to last progress signal (new milestone OR new pushed commit — same definition as today); 30 min → redispatch same run one tier stronger (resume protocol carries work forward); cap 2, then failed + dependents blocked. Today's ladder policy, mechanized.
- **Non-responsibilities:** never edits code, never decides *what* an issue means, never resolves ambiguity — those dispatch LLM runs. Never writes runstate for a run (runs post their own); it writes only batch-level milestones on batch anchors and reads everything else.
- **LLM joints:** (a) classification/DAG — dispatched to batch-prep; (b) aggregate-failure fix attempt — one bounded mid-tier agent; (c) anything hitting `decision-pending` — stop, surface, park.

### C.2 `issue-cycle-classifier` (new dossier, small; judgment tier)

- **Input:** issue number (+ optional plan artifact).
- **Output:** structured verdict posted via `ai-dossier runstate post --phase classify`: `mode=full|slot`, `risk=low|med|high`, `est_files=`, `est_diff=`, `areas=` (comma slugs), `test_scope=focused|broad|unknown`, `deps=`, `confidence=`, `rationale_comment=<link>` plus a human-readable rationale comment. Labels `cycle:full` / `cycle:slot` applied.
- **Non-responsibility:** batching. It scores one issue; composition is prep's job.
- Rules in section E. Consumable by triage later (one classification, many consumers — kills one leg of the triple-planning redundancy).

### C.3 `batch-issues-preparation` (new dossier; judgment tier)

- **Input:** issue list/range (potentially hundreds).
- **Does:** normalize + drop closed/missing (reported, per fleet Phase 1); build the dependency DAG (fleet Phase 2 rules verbatim: explicit signals authoritative, serialize-when-unsure); run classifier per issue (parallel, cheap dispatches); ensure each issue has a **plan artifact** (create a light one if triage didn't); compose batches (rules in E); create `batch-epic` anchor issues (task-list body, `batch-epic` label); write the queue (`sched enqueue --from-manifest`).
- **Output:** queue entries; anchors; a FLEET-PLAN-style audit file (reuse fleet's `~/.dossier/logs/` convention); per-issue classify records.
- **Non-responsibilities:** execution, supervision (scheduler's), deep planning (slot/full cycle's).

### C.4 `slot-cycle` (new dossier; generation tier by issue risk)

- **Precondition (provided by scheduler):** worktree exists, batch branch checked out, environment warm, issue's plan artifact + classify record available. **No gate, no setup, no ship, no report phases.**
- **Steps:** (1) *plan-validate*: check the plan artifact against HEAD — referenced files exist, ACs still coherent, no floor-area surprise; deterministic checks + one cheap model sanity pass; refine incrementally, never recreate wholesale. **Misclassification tripwire lives here** (see F.7). (2) *implement*: per implement-issue discipline minus repo-wide ceremony — changed-file lint, typecheck, **focused tests** (capability `test.focused` when available). (3) *conformance*: the blind AC check, per-issue, strongest tier — unchanged from review-issue Agent 7, diff scoped to this issue's changes. (4) *commit*: exactly one commit `<type>: <title> (#N)` at the issue boundary, pushed. (5) milestone: existing phases with `--kv mode=slot batch=<id>` so `runstate verify` and the resume tooling work unchanged.
- **Non-responsibilities:** full suite, CI, PR, merge, deploy, teardown, aggregate review, cross-issue anything.
- **WIP-sync relaxation (explicit policy change):** inside a batch, the durable-push granularity is the *issue boundary*, not every phase. Rationale: cross-machine mid-issue resume of a batch member isn't a supported path (the batch worktree is machine-local under one scheduler); a mid-issue crash loses at most one issue's in-progress work, bounded and cheap to redo. Batch resume from another machine = re-materialize from last pushed issue boundary.

### C.5 Modified existing dossiers

| Dossier | Change | Size |
|---|---|---|
| setup-issue-workflow | batch mode: branch `batch/<id>-<date>` from base, no per-issue naming, no planning scaffold. Mostly a parameter, largely replaceable by `worktree.prepare` capability | small |
| review-issue | aggregate mode: input = combined diff + list of per-issue AC-verdicts (already produced by slot-cycles); skips Agent 7 (done per-issue); tier = max of members' risk + combined-diff floor scan; dimensions run once over the aggregate | medium |
| ship-issue | batch mode: PR body per-issue sections + `Closes` list; **rebase-merge, not squash**; merge-commit ancestry check adjusted; teardown returns the batch worktree; everything else (CI-trigger gate, phantom-green defense, deploy-confirm) applies verbatim to the batch PR | medium |
| report-issue | batch variant: one batch report + one short completion comment per member issue (traceability); `Shipped` line covers the batch deploy | small |
| gate-issue | recognize slot-mode trails: an evicted/requeued issue has `mode=slot` milestones but enters full-cycle fresh (with a pointer to prior context); don't map its resume into a nonexistent batch | small |
| fleet-cycle | after sched parity: thin alias — parse set, invoke batch-prep with `mode=all-full`, enqueue. Eventually deprecated | small |
| full-cycle-issue | **unchanged** (the fallback, per constraints), except plan-issue optionally consumes an existing plan artifact instead of always creating one (Q10) | small |

### C.6 Plan artifacts (Q10)

One canonical per-issue plan, stored **on the issue** as a marked comment (`<!-- plan:v1 head=<sha> -->`: problem, ACs, predicted files, approach, test scope), because batch-prep runs before any branch exists so PLANNING-files can't be the medium. Producers: triage (optional), batch-prep (light), plan-issue (rich — also posts/updates the comment). Consumers **validate then refine, never recreate**: deterministic checks (files exist at HEAD, base distance, floor-area scan of predicted paths) + one cheap model pass; full replan only on validation failure. This preserves the reliability value of re-examination (the brief's caveat) at ~10% of the cost of replanning — the redundancy that caught real issues was the *checking*, not the *recreating*.

### C.7 Rejected alternatives

- **mcp-server journeys** as the orchestrator: request-driven, dossier-granularity, no slots/stall/PR semantics; would be a second framework bent out of shape.
- **GitHub Projects** for batch state: API instability already bit ship-issue (GraphQL label deprecation); labels + anchor issues + runstate need nothing new.
- **GitHub milestones-feature** for batches: single-assignment, clunky for concurrent batches.
- **Local-only batch state:** invisible, violates supportability; GitHub mirror is mandatory.
- **One agent implements the whole batch** (single long-context agent for N issues): context accumulation caps batch size and cross-contaminates issues; fresh-agent-per-issue keeps batch size bounded by *risk*, not context window.

---

## D. State machines

### D.1 Issue

```
queued → classified{full|slot}
  full:  → dispatched → (full-cycle's own phase trail) → shipped → done
  slot:  → batched(b) → waiting → in-work → committed(range) → validated
             → shipped-in-batch → done
failure edges (any state):
  in-work/committed → evicted(reason) → requeued{full}   [misclassified, test-failure, revert-conflict]
  any → blocked(dep-failed) | decision-pending | failed(escalation-cap)
```

### D.2 Batch

```
forming → ready → executing(member i/N) ⟲ → validating → reviewing → shipping
  → awaiting-merge → merged → deployed → reported → done
failure edges:
  validating → attributing → fixing(1 bounded attempt) → validating
             → evicting(revert range) → validating
  evictions > ⅓ OR revert-conflict → dissolving → members requeued (smaller batches / full)
  awaiting-merge: CONFLICTING | auto-merge-blocked → rebasing → re-validating → shipping
                  (2nd failure → dissolved)
```

Batch milestones (`batch-setup`, `batch-validate`, `batch-review`, `batch-ship` awaiting-merge/done, `batch-report`) posted on the anchor issue via the existing `runstate post` — batch resume rides the existing rails.

### D.3 Worker slot

```
idle → assigned(unit) → running(pid, phase, last_progress_at)
  → exited → verifying(reconcile vs GitHub/runstate) → complete → idle
stall: running[30 min no progress] → recovering(redispatch tier+1, ≤2) → running | failed → idle
crash (sched restart): state.json + reconcile → re-arm timers, re-attach or redispatch
```

Concurrency semantics (Q15): `max_slots` bounds **live agent processes** (full-cycle runs, slot-cycle members, prep, fix attempts, report agents). A batch consumes one slot *while a member or batch-LLM-step runs*, zero while the scheduler is doing deterministic work (suite runs, CI waits, PR watches) — the detached-ship economics ("a parked PR costs nothing; a waiting agent costs a slot") generalized to every wait. Worktree-pool capacity is the second bound, checked at claim time; parked/batch worktrees still hold pool slots until teardown (today's rule, kept).

### D.4 What is persisted where (Q16)

| State | Store | Why |
|---|---|---|
| Queue, slots, batch composition, timers, eviction history | `~/.dossier/sched/<project>/state.json` | hot, transactional, machine-local |
| Per-issue phase trail | runstate comments (existing) | durable, cross-machine, human-visible |
| Batch phase trail | runstate comments on anchor | same rails |
| Classification | `phase=classify` record + `cycle:*` labels | consumable by any tool |
| Work | origin branches (existing) | WIP-sync rule (issue-boundary granularity in batches) |
| Audit | FLEET-PLAN-style gz files + `runs.jsonl` + new token/duration telemetry | mining + metrics |

Recovery invariant: **state.json can be deleted and rebuilt** from GitHub (slower, loses only queue ordering preferences) — GitHub remains the system of record, exactly as today.

---

## E. Classification and batching rules (concrete initial heuristics)

### E.1 Classifier — what it can actually inspect

Labels; title/body/comment keywords; the plan artifact's predicted file list (or a quick model estimate + `git grep` probes of named modules); path→area mapping (the review-issue risk-floor list, reused verbatim); linked/parent issues; `runstate stats` history of similar issues (author, area, label) for calibration.

### E.2 Full-cycle floor (any ⇒ `cycle:full`)

Risk-floor areas (auth, payments/billing, migrations, `.github/**`, security/crypto/secrets, infra/terraform — same list as review-issue Stage 1) · schema or data migrations · new package/workspace · deploy-pipeline changes · predicted files > 8 or predicted diff > 400 lines · hard rollback (data mutation, published API contract) · needs visual/browser review · unresolved dependency outside the submitted set · classifier confidence < 0.6. **Uncertainty ⇒ full** — but instrument the slot-rate; if a typical backlog classifies < 40% slot, the floor is too wide and the batch path won't pay for itself (tune in Phase 2 shadow mode against actual diffs).

### E.3 Slot eligibility (all of)

No floor hit · predictable test scope (`test_scope=focused`) · single area or few related files · issue text implies bounded change (bug fix, copy, config, small feature, test addition, docs, refactor-in-place).

### E.4 Batch composition (hard constraints, then packing)

Hard: same `base_branch` · all external deps merged or in earlier batches · combined predicted diff ≤ ~1,200 lines · members ≤ 6 (start 4) · at most one **eviction group** (see below) · no two members with `risk=med`+ touching the same area.
Packing: prefer file-disjoint members (predicted-path intersection = ∅); members with overlapping paths *may* share a batch deliberately (they see each other's changes in the worktree — this **eliminates the cross-PR merge conflicts** fleet serializes around today) but form an *eviction group*: ordered internally by dependency, evicted together if any member's commits can't be cleanly reverted alone.
Ordering within batch: dependency order → ascending risk (safest first, so evicting a late risky member never invalidates early safe ones) → issue number.
Batch-level DAG: an edge A→B between batches if any member edge crosses them; scheduler gates on **merge** (fleet rule 7, kept).
Dispatch trigger: batch dispatches when full OR when its members have waited > a time window (default 30 min) — don't starve small tails of a backlog.

### E.5 Q8 — max batch size: what actually binds

Not context (fresh agent per member) and not issue count per se. The binding constraints, in order: **failure blast radius** (an eviction re-runs the suite; a dissolve re-queues everyone — cost grows superlinearly with N), **aggregate reviewability** (one reviewer pass over the combined diff loses acuity past ~1,000–1,500 lines), **deploy coupling** (one bad member delays N−1; a post-merge incident reverts N issues at once). Hence: cap on *predicted aggregate diff* primarily, member count secondarily. Start 4/≤1,200; raise only with measured eviction rate < 10%.

---

## F. Failure and recovery model

| # | Failure | Handling |
|---|---|---|
| F.1 | **Member's focused tests fail** (during slot-cycle) | implement-issue's existing discipline: 2 bounded fix attempts → evict (no commit yet: just reset; requeue full or decision-pending). Cheapest failure — caught before accumulation. |
| F.2 | **Aggregate suite fails** (batch validate) | Attribute: failing-test ↔ member via changed-path/focused-test overlap; ambiguous → deterministic `git bisect` over issue-boundary commits running only the failing tests (script, no LLM). Then: 1 bounded fix attempt (mid-tier agent) → still red → evict (revert member's range; eviction group reverts together) → re-run suite → requeue member as full-cycle **with its context** (plan artifact + failure evidence attached). > ⅓ evicted or revert conflicts → dissolve batch. |
| F.3 | **CI fails on the batch PR** | ship-issue's existing 2-attempt rule against the aggregate; failure that attribution maps to one member → evict + force-push rebuilt branch (scheduler-controlled, `--force-with-lease`, ancestry note posted) → CI re-runs. Unattributable/infra → decision-pending on the anchor (today's rule). |
| F.4 | **Agent crash / stall** | Scheduler stall timer (30 min no milestone/commit) → redispatch same unit one tier stronger (resume rails carry it), cap 2 → failed. Today's ladder, mechanized; supervision can no longer "forget." |
| F.5 | **Worktree corruption / pool failure** | Reconciler detects (worktree missing / HEAD mismatch vs origin): re-materialize from last pushed issue boundary (cold worktree fallback, per today's resume protocol). Pool failure → cold path + recorded degradation (`pool_note=`, kept). |
| F.6 | **Dependency discovered mid-implementation** | Member posts `blocked reason=dependency-discovered dep=#M` (existing hand-off shape); scheduler: evict without fix attempt, add edge, requeue into a later batch or full-cycle. Batch continues. |
| F.7 | **Issue larger/riskier than classified** (Q12) | Tripwires: plan-validate floor-scan (before any code — cheapest exit) and implement-time (touched files > 2× estimate, or any floor path). Member stops, posts `blocked reason=misclassified`, scheduler reverts any partial commit, requeues as full-cycle carrying the refined plan. Misclassification is a **cheap, expected event** — this loop is also the classifier's training signal (record predicted vs actual on every issue). |
| F.8 | **Partial batch success** (Q13) | The default outcome, not an exception: batch ships whatever survived; evicted members requeue individually; nothing green is discarded. A dissolved batch loses only uncommitted in-progress work (bounded by F.5's issue-boundary pushes). |
| F.9 | **Batch PR conflicts / auto-merge-blocked** (base moved) | Scheduler rebases the batch branch, re-runs the suite (changed base = changed world), re-ships. Second occurrence → dissolve into two half-batches (conflict probability ∝ batch width × base drift). Never self-merge around the watcher (kept). |
| F.10 | **Interrupted/stalled batch, scheduler death** (Q14) | `sched start` → load state.json → reconcile vs GitHub → re-arm. No state.json (new machine): rebuild from anchors + runstate + `cycle:*` labels; batches resume at last batch milestone; members at last pushed issue boundary. |

### Q19 — genuinely new failure modes batching introduces

Cross-issue interference (A breaks B in the same worktree) — caught by the incremental gate + aggregate suite, attributed by F.2. **Deploy coupling** — one deploy carries N issues; a post-merge incident reverts N at once; mitigation: modest batch size, per-issue commits make selective revert possible. **Attribution error** (innocent member evicted) — bisect is deterministic; the evicted issue re-runs as full-cycle, so the cost of a wrong eviction is tokens, never a wrong merge. **Review dilution** — one aggregate pass reads mixed concerns; mitigated by per-issue conformance staying separate + diff-size cap. **Long-ish-lived batch branch drift** — F.9; batch wall-clock target < a few hours. **Traceability thinning** — issue↔PR is now N:1; compensated by per-issue commits in main (rebase-merge), `Closes #N` lines, per-issue report comments, `batch=<id>` milestone keys. **Watcher semantics** — the auto-merge watcher must handle rebase-merge for batch PRs, and its presence-of-checks guards (imboard #3803, default-branch-scoped; extended to all PRs by imboard#3902) must be verified to hold on that new path — batch PRs raise the stakes of a silently-unchecked merge.

---

## G. Migration plan (Full Cycle untouched throughout)

**Step 0 — Measure (prereq for H).** Add token/duration/command telemetry to run spawns (extend `runs.jsonl` schema or a sched-owned log; `claude -p` cost surfaces exist). Baseline: `runstate stats` + new telemetry over the recent ~50 full-cycle/fleet runs. *No architecture change.*

**Step 1 — Scheduler at fleet parity.** `dossier-sched` MVP: queue, slots, dispatch (all-full-cycle, detached), completion verification, stall ladder, PR watch, tail work as **scripts** (teardown stops being a re-dispatched full-cycle — immediate win), resume. Run real fleet workloads side-by-side vs fleet-cycle. Exit criterion: slot-occupancy > 90% while runnable work exists, zero un-tailed merges, over ≥ 3 real fleets. **This step alone fixes the named Fleet weakness and is worth shipping regardless of batching.**

**Step 2 — Classifier + prep in shadow.** Classify and label real backlogs; everything still executes full-cycle. Compare predicted files/diff/risk vs actual outcomes; tune the floor until slot-rate ≥ ~50% with < 10% would-have-been-misclassified. Plan artifacts start being produced/consumed (plan-issue reads them — a token win already).

**Step 3 — First real batches.** Lowest-risk classes only (docs, chore, config, test-only), N ≤ 4, one batch at a time, `max_slots` kept at 3. Requires: setup/review/ship/report batch modes, slot-cycle v1, eviction + bisect, rebase-merge enabled + watcher updated (**start this external change during Step 1 — it has lead time**). Every batch failure requeues to full-cycle — the safety net is structural, not procedural.

**Step 4 — Widen.** Bug-fix/small-feature classes, N→6, concurrent batches, batch-level DAG, dissolve machinery hardened. Deprecate fleet-cycle to an alias. Progressive-determinism capabilities keep landing in parallel (the scheduler is their natural host; `worktree.prepare`, `test.focused`, `lint.run` directly cheapen Steps 3–4) — synergy, not a dependency.

Rollback at every step = stop enqueueing that class; full-cycle path is never modified.

---

## H. Validation plan (Q20)

**Metrics** (collected by sched telemetry + runstate stats + GitHub):

| Metric | Baseline source | Target after Step 4 |
|---|---|---|
| Tokens per completed issue (slot-eligible cohort) | Step 0 measurement | **−40% or better** |
| Wall-clock per issue (dispatch→deployed) & backlog makespan | runstate stats | makespan −30%+; per-issue latency allowed to rise ≤ 25% |
| Slot occupancy while runnable work exists | new | > 90% (vs fleet's stall-prone baseline) |
| Full CI executions per issue | GitHub Actions | 1/N-ish + focused runs (≈ −60%+) |
| Eviction rate / dissolve rate | sched | < 10% / < 2% |
| Misclassification (slot→full escalations) | classify vs outcome records | < 10%, trending down |
| Human interventions (decision-pending per issue) | labels | ≤ baseline |
| Regressions (post-merge revert/hotfix within 7 days) | GitHub | **≤ baseline — hard gate; a token win with worse regressions is a loss** |

**Method:** A/B on comparable slot-eligible cohorts (≥ 20 issues per arm: fleet-of-full-cycles vs batched); Step 2's shadow data validates classification independently of execution. Reliability gate is binding: any regression-rate increase pauses widening (Step 4) until the causal batch pattern is excluded by composition rules.

---

## I. Concrete implementation plan

**Added**
| Item | Where |
|---|---|
| `dossier-sched` (state machine, slots, dispatch, reconcile, PR watch, eviction/bisect, telemetry) | `main/packages/sched/` + CLI wiring |
| Token/duration telemetry | `main/cli/src/run-log.ts` + sched |
| opencode support in agent spawn | `main/cli/src/helpers.ts` |
| `issue-cycle-classifier` dossier | registry (publish via CLI) |
| `batch-issues-preparation` dossier | registry |
| `slot-cycle` dossier | registry |
| `runstate` additions: `phase=classify`, `batch-*` phases, `mode=`/`batch=` keys | `main/cli/` runstate command |
| Plan-artifact comment format (`<!-- plan:v1 -->`) + CLI read/write helper | `main/cli/` |
| Labels: `cycle:full`, `cycle:slot`, `batch-epic`, `evicted` | target repos |

**Modified:** setup-issue-workflow, review-issue, ship-issue, report-issue, gate-issue (batch/slot modes — registry publishes); auto-merge watcher (rebase-merge for `batch-epic` PRs; presence floor extended to all PRs + rebase strategy in imboard#3902, in progress) — *external repo, long lead, start first*; full-cycle's plan-issue (optional plan-artifact consumption).

**Deprecated:** fleet-cycle (→ alias over sched, after Step 1 parity ×3 fleets); full-cycle tail-run pattern (→ sched scripts).

**Step/issue breakdown** (roughly one issue each, dependencies noted): 1. telemetry (—) · 2. sched core: queue/slots/dispatch/state (—) · 3. sched reconcile+stall+PR watch (2) · 4. tail-work scripts (3) · 5. fleet parity validation ×3 (3,4) · 6. watcher rebase-merge + checks-presence fix (—, external) · 7. classifier dossier + runstate classify (1) · 8. batch-prep dossier + enqueue manifest (7) · 9. shadow-mode calibration (5,8) · 10. plan-artifact format + plan-issue consumption (7) · 11. slot-cycle dossier (10) · 12. batch modes: setup/review/ship/report (6) · 13. eviction/bisect machinery (2,12) · 14. first-batches pilot (9,11,12,13) · 15. widen + fleet-cycle deprecation (14).

---

## Recommendation

**Implement it — in the order above, not the brief's order.** The brief's largest single win is disguised as a supporting requirement: the deterministic scheduler. It fixes Fleet's real, named reliability failure with no batching risk, deletes the tail-run ceremony, removes LLM supervision tokens entirely, and is the host every later piece needs. Batching is genuinely valuable (the `N×lifecycle → 1×lifecycle` arithmetic is sound, and in-batch accumulation even *eliminates* the cross-PR merge-conflict class fleet serializes around) — but its ROI depends on measured classification accuracy and eviction rates, which is why it follows the shadow phase rather than leading.

**Change before implementing:** (1) `batch-cycles` and `batch-issues` should not be dossiers — the state machines belong in code, LLM steps dispatched individually. (2) Keep per-issue blind conformance un-batched. (3) Switch batch PRs to rebase-merge and fix the watcher's absence-of-failure gate early — both are external-lead-time items and batching raises their stakes. (4) Relax WIP-sync to issue-boundary granularity inside batches, as an explicit documented policy, not silent drift. (5) Plan reuse should be validate-and-refine, never skip-validation reuse — the redundancy the brief notes "has caught real issues" survives as the cheap validation pass. (6) Consider renaming `slot-cycle` (collides with scheduler slots); `member-cycle` is the most self-describing.

**Biggest risks, honestly:** the scheduler is new software in a system that currently ships behavior as prose — it needs real tests (it is also the *first* component in this architecture that can have real tests, which is the point); and batch economics could disappoint if the backlog classifies mostly-full or evictions run hot — which is exactly what Steps 0/2 measure before Step 3 commits anything. The constraint "avoid an architecture whose operational complexity outweighs the savings" is honored by the kill-switch built into the migration: after Step 2 we hold real numbers, and stopping at Step 1 still leaves the system strictly better than today.
