---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "fleet-cycle",
  "title": "Fleet Cycle — Orchestrate Multiple Issues",
  "version": "1.7.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-26",
  "objective": "Take a SET of GitHub issues to merged PRs by building a dependency-aware wave plan, dispatching detached full-cycle-issue runs across background agents, and supervising the parked PRs through merge — serial, parallel, or mixed",
  "category": [
    "development"
  ],
  "tags": [
    "github",
    "issues",
    "workflow",
    "autonomous",
    "orchestration",
    "batch",
    "parallel",
    "fleet",
    "full-cycle",
    "dependencies"
  ],
  "risk_level": "high",
  "risk_factors": [
    "modifies_files",
    "network_access",
    "executes_external_code"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Dispatches multiple full-cycle-issue runs, each of which creates branches, worktrees, PRs, and merges code",
    "Spawns background agents that operate autonomously",
    "Merges multiple pull requests"
  ],
  "inputs": {
    "required": [
      {
        "name": "issues",
        "description": "The issue set to process. Explicit list ('1,2,3'), range ('1..9'), or mixed ('1,2,5..8').",
        "type": "string",
        "example": "1..9"
      }
    ],
    "optional": [
      {
        "name": "max_parallel",
        "description": "Maximum number of full-cycle runs dispatched concurrently within a wave. Bounded by worktree-pool capacity.",
        "type": "number",
        "default": 3
      },
      {
        "name": "mode",
        "description": "Override the computed plan. 'auto' = dependency-aware waves (default). 'serial' = one issue at a time in number order. 'parallel' = ignore dependencies, run all at once (unsafe; use only for known-independent issues).",
        "type": "string",
        "default": "auto"
      },
      {
        "name": "warmup_dossier",
        "description": "Warm-worktree dossier passed through to each full-cycle-issue run.",
        "type": "string",
        "default": "imboard-ai/git/warm-worktree"
      },
      {
        "name": "base_branch",
        "description": "Default target branch for issues that do not declare their own. Passed through to each full-cycle-issue run.",
        "type": "string",
        "default": "auto"
      },
      {
        "name": "dispatch_model_tier",
        "description": "Model tier for dispatched full-cycle generation phases: cheap | mid | strong | auto. auto = per-issue by risk signals (labels, title, touched areas): docs/chore→cheap, standard→mid, security/payments/migrations/auth/schema→strong.",
        "type": "string",
        "default": "auto"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md.gz",
        "description": "Gzipped dependency DAG and wave plan, written before dispatch, kept per-project outside the working tree (most recent 20 retained)",
        "format": "markdown+gzip"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "917677d4904cc80578adcf95e44c65ab0c754b82afbff4991db0773f3310b964"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "wey+z2xWurZiof42iwtvuAVi5/hLQtO4v28CEaaiLc8GUev2LTEE8HwIUmGzwfeP7VwBZbb/N0xUTzOZzAIcBw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-26T06:48:18.626Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Fleet Cycle — Orchestrate Multiple Issues

## Objective

Take a **set** of GitHub issues to merged PRs. The orchestration layer **above** `full-cycle-issue`: it does not re-implement the cycle. Each issue is still handled end-to-end by `imboard-ai/git/full-cycle-issue` (gate → setup → plan → implement → review → ship → report); fleet-cycle owns only what a single run cannot — **set resolution, dependency analysis, scheduling, dispatch, supervision, and aggregate reporting** — dispatching one run per issue across background agents, parallel where independent and ordered where dependent.

## Guiding Principle

**Plan, then auto-run.** Resolve the set, build the wave plan, write it to a file, present it — then dispatch automatically without waiting for approval, mirroring full-cycle's no-checkpoint philosophy. The user interrupts only if they disagree with the plan.

Pause to ask only when:
- An issue number is invalid, closed, or does not exist
- A genuine dependency cycle is detected (A needs B and B needs A) that cannot be ordered
- The whole set collides on the same files such that no parallelism is safe AND the serial chain is very long (surface it; let the user decide whether to proceed serially or narrow the set)

Do NOT ask about: wave composition, branch order, concurrency level, or any mechanical scheduling decision.

## Prerequisites

- [ ] `full-cycle-issue` and its sub-dossiers, and `imboard-ai/git/watch-task`, are available in the registry
- [ ] GitHub CLI (`gh`) installed and authenticated; push access to the repo
- [ ] A worktree pool is configured (recommended) so parallel runs get instant worktrees rather than cold-starting and contending
- [ ] The environment can spawn background agents (the orchestrator dispatches one per concurrent issue)

## Phase 1: Resolve the Issue Set

1. Parse `issues` into a concrete list of integers — explicit list `1,2,3` → `[1,2,3]`; range `1..9` → `[1..9]`; mixed `1,2,5..8` → `[1,2,5,6,7,8]`. De-duplicate and sort ascending.
2. For each issue, fetch title, body, labels, linked issues, and state (`gh issue view`).
3. Drop any issue that is closed or non-existent — report it as skipped with the reason. Do not silently omit.

## Phase 2: Build the Dependency Graph

For every pair of issues, determine whether one must merge **before** the other, using explicit signals and judgment. **When uncertain, prefer adding a dependency edge (serialize) over assuming independence** — a false parallel is far more expensive than a false serial.

**Explicit dependency signals (authoritative):**
- "depends on #X", "blocked by #X", "after #X" in the issue body or comments
- GitHub issue links / tracked-by / parent-child (epic → sub-issue)
- A declared `base_branch` that points at another issue's branch or epic

**Inferred dependency signals (judgment):**
- **File-overlap collision** — two issues that will plausibly modify the same files or modules. Per this dossier's policy, **colliding issues are serialized**, not stacked: the later one waits for the earlier to merge and branches from the updated base. Order them by issue number unless the content implies a natural order.
- **Logical/data ordering** — issue B builds on a capability, schema, or API that issue A introduces.
- **Shared migration or config surface** — two issues that both touch migrations, lockfiles, or global config will conflict on merge even if "different features"; serialize them.

Output an internal DAG: nodes = issues, edges = "must merge before". Detect cycles; if a true cycle exists, surface it and ask.

## Phase 3: Compute the Wave Plan

Topologically partition the DAG into **waves**:
- **Wave N** contains every issue whose dependencies have all completed in waves `< N`.
- Within a wave, issues are mutually independent → safe to run in parallel.
- Across waves, execution is gated: wave `N+1` does not start until wave `N` has resolved.

Apply `mode`: `auto` (default) = the wave plan as computed; `serial` = one issue per wave, ascending number order; `parallel` = a single wave with all issues (only when the user asserts independence). Respect `max_parallel`: if a wave has more issues than the cap, dispatch in batches within the wave, refilling as runs finish.

**Write the wave plan to `~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md`** capturing: the resolved set, the dependency edges with their justification (explicit vs inferred), the wave breakdown, the concurrency cap, and the failure policy.
- `{project}` = repo slug `<owner>-<repo>` from `gh repo view --json owner,name -q '.owner.login + "-" + .name'`; if that fails (no remote / no `gh`), fall back to the basename of `git rev-parse --show-toplevel`.
- `{timestamp}` = UTC `YYYYMMDD-HHMMSS`.
- `mkdir -p` the target directory, write the file, then `gzip -f` it in place so the artifact on disk is `FLEET-PLAN-{timestamp}.md.gz`.
- **Retention**: after writing, list `FLEET-PLAN-*.md.gz` in that project's log directory by mtime and delete all but the 20 most recent.
- Present a concise version of the plan in the conversation — the file is for audit/history, not re-read during this run.

## Phase 3.5: Prewarm the Pool

> Pool CLI invocation: always `npx -y @ai-dossier/worktree-pool@^0.5.1 <cmd>`. The bare `npx worktree-pool` only resolves where the package is installed locally (it 404s elsewhere), and versions before 0.5.1 have a data-loss bug in `gc`. Never pin an older version.

Before dispatching each wave, from the **orchestrator** — not the agents (replenish is serial by construction, so one orchestrator prewarm is strictly cheaper than N agents cold-starting behind the pool lock):

```bash
# N = the smaller of this wave's size and max_parallel
N=$(( wave_size < max_parallel ? wave_size : max_parallel ))
npx -y @ai-dossier/worktree-pool@^0.5.1 replenish --count "$N"
```

Then wait until `npx -y @ai-dossier/worktree-pool@^0.5.1 status` shows Warm >= N — as an **armed watch** (one bounded blocking loop, poll every 10s, max 10 min; see Phase 4 rule 0), never an unarmed "check later". If the pool is not configured, say so once and continue — agents fall back to cold worktrees.

## Phase 4: Dispatch and Supervise

For each wave, in order:

0. **Every wait in this phase is an armed watch — run it per `imboard-ai/git/watch-task`.** This is the fleet's known lost-time failure: the orchestrator dispatches, says "waiting", ends its turn — and nothing ever wakes it, so finished runs sit un-tailed and hung runs are never noticed. Between dispatch and wave resolution the orchestrator must always be inside a blocking poll loop, a harness monitor/wait call, or covered by a verified scheduled wakeup — completion notifications alone don't cover hangs, so pair them with a timer. Per watch-task: check commands are the runstate trail + `gh pr view` (read-only); the progress signal is a new milestone or newly pushed commit; the stall timeout is 30 min feeding rule 4b's escalation ladder (its cap = watch-task's `max_recoveries`); watchdog work runs on the cheap tier (rule 1b).

1. Dispatch one **background agent per issue** in the wave (up to `max_parallel` concurrently). Each agent's task is exactly: run `full cycle issue <N>` — i.e. `ai-dossier run imboard-ai/git/full-cycle-issue --pull` for that issue, passing through `warmup_dossier`, the issue's resolved `base_branch`, and **`ship_mode=detached`**.
1b. Dispatch each issue's full-cycle run at its tier per `dispatch_model_tier` (auto = judge per issue from its labels/title/likely paths, using the same risk signals as review tiering). The fleet's OWN work splits by role: dependency analysis and wave planning are judgment — do them at the strongest tier (i.e. the orchestrator itself); supervision, PR polling and tail dispatches are mechanical — tails and any watchdog run cheap.
2. **Detached ship is the fleet default.** A dispatched run ends as soon as its PR is open and parked on auto-merge (full-cycle Phase 5 item 2b): no CI wait, no merge, no teardown, no report. The agent exits there and the orchestrator owns everything after the park.
3. A **dependent** issue must branch from the **updated** base — the merged result, not a stale snapshot. Its dependency must be fully merged before it is dispatched; this is why dependents live in a later wave.
4. Supervise the wave: track every issue in exactly one state — **running** (agent working), **parked** (last milestone is `phase=ship status=awaiting-merge`; PR open on auto-merge, agent exited), **merged** (PR merged AND its tail run finished), **failed**, or **blocked**.
4b. **Escalation ladder.** If a dispatched run stalls (no new milestone AND no new pushed commit for 30+ minutes) or completes a phase without its milestone, redispatch the same issue one tier stronger — the resume protocol carries the work forward. Two escalations per issue, then mark it failed and block dependents.
5. **Poll the parked PRs** every 2–3 minutes, as an armed watch (rule 0):
   ```bash
   gh pr view <pr> --json state,mergedAt,mergeable
   ```
   - **Merged** (`mergedAt` non-null and `state` `MERGED`) → dispatch a **tail run**: one background agent whose task is exactly `full cycle issue <N>`. gate-issue reads the `awaiting-merge` milestone, sees the PR merged, and resumes at `resume_from=ship-teardown` — so the tail does teardown + report only, and posts the final `ship done` and `report done` milestones. Nothing earlier is re-run. The issue counts as **merged** once its tail run finishes.
   - **Open and `MERGEABLE`** → still parked; keep waiting.
   - **`mergeable=CONFLICTING`, closed-unmerged, or the watcher left `auto-merge-blocked`** → mark the issue **failed**, record the reason, and block its dependents (rule 6). Do not self-merge around a conflict.
6. **Failure policy — block dependents.** When an issue fails: mark every issue that depends on it (directly or transitively) as **blocked** and do **not** dispatch them; issues with no dependency on the failure continue normally; record the failure and the blocked set for the final report.
7. **Wave gating is on MERGE, not on park.** A wave is resolved — and wave `N+1` may start — only when every issue in it is merged, failed, or blocked. **A parked PR does not resolve a wave**: dependents must branch from a base that already contains the dependency, and a parked PR is not in the base yet.
8. **An agent exiting is NOT proof of merge.** Under detached ship its exit means *parked*, nothing more. Before marking an issue **merged**, advancing to the next wave, or dispatching dependents, the orchestrator MUST independently verify `gh pr view <pr> --json mergedAt,state` shows `mergedAt` non-null **and** `state` `MERGED`, **and** the issue is CLOSED. Never treat an idle/"done" signal as merge confirmation.

**Runstate is per-run, not per-fleet.** Each run mints its own `run_id` at its gate phase; fleet-cycle neither mints nor passes one. A tail run reuses the parked run's `run_id` automatically (gate-issue reuses the id it finds on resume), so the trail stays continuous. The orchestrator reads runstate, it does not write it.

**Concurrency discipline:** `max_parallel` bounds **live agents**, not open PRs — **parked runs do not count against it**, since their agent has already exited, so tail runs and the next batch dispatch sooner. Two bounds still hold: never exceed worktree-pool capacity (a detached run holds its worktree until its tail run tears it down, so parked runs DO still hold pool slots), and never exceed `max_parallel` live agents counting tails. If the pool is exhausted, queue and dispatch as worktrees free up rather than cold-starting many at once.

## Phase 5: Aggregate Report

A single roll-up across the whole fleet:
- **Per issue**: status (merged / parked / failed / blocked / skipped), PR link, one-line summary, `model=` from its gate milestone(s), and any escalations. A still-**parked** issue at report time means its PR never merged within the run — say what it is waiting on.
- **Merged**: count and PR links.
- **Failed**: each with the failure reason and where it stopped.
- **Blocked**: each with which failed dependency blocked it (so the user can re-run after fixing).
- **The wave plan as executed**, including any divergence from the original plan.
- **Runstate**: a direct link to each issue's LAST `<!-- runstate:v1 -->` comment, so the exact phase each run reached is one click away (including failed and blocked issues).

Post it to the conversation, with direct PR URLs for every merged and failed issue.

## Pitfalls and Decision Points

| Situation | Decision / why |
|---|---|
| Uncertain whether two issues collide, or they merge into the same base and touch the same file | Add a dependency edge (serialize). False serial < false parallel; optimistic independence is the most expensive failure mode — you discover it at merge time after both ran. |
| Issue declares `merges into <branch>` | That branch is its base; honor epic/sub-issue chains. |
| Dependency cycle detected | Surface it and ask — cannot be auto-ordered. |
| Wave wider than `max_parallel` | Batch within the wave; refill as runs complete. |
| An issue fails mid-wave | Block its transitive dependents; let independents continue. Partial fleet success is normal — the report must make the blocked set and its cause explicit so the user can re-run the remainder. |
| A dispatched agent exits with its PR open | Expected — the run is parked, not done. Poll the PR; dispatch the tail run once it merges (Phase 4 rule 8). An un-tailed merge leaves a worktree behind and no completion report. |
| A parked PR goes `CONFLICTING` or gets `auto-merge-blocked` | Mark the issue failed and block dependents. Do not self-merge around it. |
| Wave has parked PRs but no live agents | The wave is NOT resolved. Keep polling; do not start wave N+1 — a parked PR is not in the base branch, so dependents would branch off a base missing their dependency. Parked runs do free up `max_parallel` slots for tails. |
| A dependent branched before its dependency merged | Stale base — it will miss the code and likely conflict. Wave gating exists to prevent this; re-branch from the updated base. |
| More parallel runs than the pool can serve | Cold-start storms and disk pressure. Bound concurrency by `max_parallel` and pool capacity, whichever is smaller; keep `max_parallel` modest (default 3) — many simultaneous runs also hammer the `gh` API and CI queue. |
| A background run goes quiet | Long-running background runs can fail silently. Supervise actively via the armed watch (Phase 4 rule 0) — probe the runstate trail and pushed commits, escalate per the ladder; surface failures as they happen, not only at the end. (Under detached ship, quiet-after-park is expected — verify the PR, don't assume failure.) |
| The orchestrator "waits" with nothing armed | The classic lost-time bug: turn ends after dispatch, no loop, no monitor, no scheduled wakeup — merged PRs sit un-tailed and hung agents run forever. watch-task's Iron Rule: a wait is legitimate only while armed. |
| User passed `mode=parallel` | Trust the assertion of independence; single wave, all at once. |

## Validation

- [ ] Issue set resolved from list/range; closed/missing issues reported as skipped
- [ ] Dependency graph built from explicit + inferred signals; no undetected dependency cycle
- [ ] Wave plan computed and written to `~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md.gz` (gzipped; older entries beyond the most recent 20 pruned)
- [ ] Plan presented before dispatch
- [ ] Each issue dispatched as a background `full-cycle-issue` run with `ship_mode=detached`
- [ ] Each dispatch's generation-phase tier set per `dispatch_model_tier` (auto = risk-based); the fleet's own dependency/wave-planning judgment ran on the strongest tier, supervision/tails/watchdog ran cheap
- [ ] Escalation ladder applied on a stalled or milestone-non-compliant dispatched run (redispatch one tier stronger; cap two escalations per issue, then fail + block dependents)
- [ ] Every wait ran as an armed watch per `watch-task` (blocking loop, monitor call, or verified scheduled wakeup) — at no point did the orchestrator idle on a dispatched wave with nothing armed
- [ ] Parked PRs polled every 2–3 min (`gh pr view --json state,mergedAt,mergeable`)
- [ ] Every merged parked PR got a tail run (`full cycle issue <N>`, resuming at `ship-teardown`) that completed teardown + report
- [ ] Conflicting / closed-unmerged / `auto-merge-blocked` parked PRs marked failed, with dependents blocked
- [ ] Merge independently verified (`mergedAt` non-null, `state` MERGED, issue CLOSED) — never inferred from an agent exiting
- [ ] Concurrency never exceeded `max_parallel` live agents or pool capacity; parked runs were not counted against `max_parallel`
- [ ] Dependents branched from updated base after their dependency merged
- [ ] Failures blocked their transitive dependents; independents continued
- [ ] Wave N+1 gated on wave N being MERGED (not merely parked)
- [ ] Pool prewarmed before each wave (or the missing-pool case reported once)
- [ ] Aggregate report posted with per-issue status, PR links, `model=` per issue, any escalations, and last-runstate-comment links

## Relationship to Other Dossiers

- **Composes**: `imboard-ai/git/full-cycle-issue` (one run per issue); `imboard-ai/git/watch-task` (the armed-watch discipline for all Phase 4 supervision waits).
- **Sits above**: the whole issue-workflow family (`gate`, `setup`, `plan`, `implement`, `review`, `ship`, `report`) — fleet-cycle never calls these directly; it only orchestrates full-cycle runs.
- **See**: `imboard-ai/git/issue-workflows-guide` for the single-issue workflow family.
