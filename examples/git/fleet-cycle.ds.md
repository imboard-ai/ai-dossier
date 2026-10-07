---
name: 'fleet-cycle'
description: 'Take a SET of GitHub issues to merged PRs by building a dependency-aware wave plan, dispatching full-cycle-issue runs across background agents (detached where the repo can merge a parked PR, attached otherwise), and supervising every PR through merge — serial, parallel, or mixed'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Fleet Cycle — Orchestrate Multiple Issues'
  dossier.version: '1.9.2'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Draft'
  dossier.last_updated: '2026-10-06'
  dossier.objective: 'Take a SET of GitHub issues to merged PRs by building a dependency-aware wave plan, dispatching full-cycle-issue runs across background agents (detached where the repo can merge a parked PR, attached otherwise), and supervising every PR through merge — serial, parallel, or mixed'
  dossier.category: '["development"]'
  dossier.tags: '["github","issues","workflow","autonomous","orchestration","batch","parallel","fleet","full-cycle","dependencies"]'
  dossier.risk_level: 'high'
  dossier.risk_factors: '["modifies_files","network_access","executes_external_code"]'
  dossier.requires_approval: 'false'
  dossier.destructive_operations: '["Dispatches multiple full-cycle-issue runs, each of which creates branches, worktrees, PRs, and merges code","Spawns background agents that operate autonomously","Merges multiple pull requests"]'
  dossier.inputs: '{"optional":[{"default":3,"description":"Maximum number of full-cycle runs dispatched concurrently within a wave. Bounded by worktree-pool capacity.","name":"max_parallel","type":"number"},{"default":"auto","description":"Override the computed plan. ''auto'' = dependency-aware waves (default). ''serial'' = one issue at a time in number order. ''parallel'' = ignore dependencies, run all at once (unsafe; use only for known-independent issues).","name":"mode","type":"string"},{"default":"imboard-ai/git/warm-worktree","description":"Warm-worktree dossier passed through to each full-cycle-issue run.","name":"warmup_dossier","type":"string"},{"default":"auto","description":"Default target branch for issues that do not declare their own. Passed through to each full-cycle-issue run.","name":"base_branch","type":"string"},{"default":"auto","description":"Model tier for dispatched full-cycle generation phases: cheap | mid | strong | auto. auto = per-issue by risk signals (labels, title, touched areas): docs/chore→cheap, standard→mid, security/payments/migrations/auth/schema→strong.","name":"dispatch_model_tier","type":"string"}],"required":[{"description":"The issue set to process. Explicit list (''1,2,3''), range (''1..9''), or mixed (''1,2,5..8'').","example":"1..9","name":"issues","type":"string"}]}'
  dossier.outputs: '{"files":[{"description":"Gzipped dependency DAG and wave plan, written before dispatch, kept per-project outside the working tree (most recent 20 retained)","format":"markdown+gzip","path":"~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md.gz"}]}'
  dossier.authors: '[{"name":"Yuval Dimnik"}]'
  dossier.checksum: '{"algorithm":"sha256","hash":"76863d05303c69d4cd2e9a62a1212529121b5a6403ca5556abd6b414298d76aa"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"P71mTDmaiuAvx80ZBqqfD56NjivbFPbX4qv9XpBB8CQa3zNc2O6tEcxc+qiyp41RzbEftAWSv9SO7bZcQFrJBA==","signed_at":"2026-10-07T11:58:48.197Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
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

**Write the wave plan to `~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md`** capturing: the resolved set, the dependency edges with their justification (explicit vs inferred), the wave breakdown, the concurrency cap, the chosen `ship_mode` with its evidence (Phase 3.25), and the failure policy.
- `{project}` = repo slug `<owner>-<repo>` from `gh repo view --json owner,name -q '.owner.login + "-" + .name'`; if that fails (no remote / no `gh`), fall back to the basename of `git rev-parse --show-toplevel`.
- `{timestamp}` = UTC `YYYYMMDD-HHMMSS`.
- `mkdir -p` the target directory, write the file, then `gzip -f` it in place so the artifact on disk is `FLEET-PLAN-{timestamp}.md.gz`.
- **Retention**: after writing, list `FLEET-PLAN-*.md.gz` in that project's log directory by mtime and delete all but the 20 most recent.
- Present a concise version of the plan in the conversation — the file is for audit/history, not re-read during this run.

## Phase 3.25: Choose the Ship Mode — can this repo merge a parked PR?

Detached ship parks each PR on the `auto-merge` label and exits; something ELSE must merge it. Assert that something exists before dispatching anything (ai-dossier#860: the 2026-09-25 ai-dossier fleet dispatched every run detached into a repo with no watcher and no native auto-merge — `autoMergeRequest=null` on every PR — so nothing would ever have merged them, and nothing said so):

```bash
BASE=<the fleet's base_branch>
git fetch origin "$BASE" --quiet
WATCHER=$(git grep -l -e 'auto-merge' "origin/$BASE" -- '.github/workflows/*.yml' '.github/workflows/*.yaml' 2>/dev/null | head -1)
NATIVE=$(gh api repos/{owner}/{repo} --jq '.allow_auto_merge')
echo "watcher=${WATCHER:-none} native_auto_merge=${NATIVE:-unknown}"
```

- **A watcher workflow that acts on the `auto-merge` label** (open `$WATCHER` and confirm it merges labeled PRs — a text match is not proof) → `ship_mode=detached`, the fleet default.
- **No watcher, but `NATIVE=true`** → `ship_mode=detached` is viable ONLY because each run's ship step requests native auto-merge (`gh pr merge --auto`) after its review round AND reads `autoMergeRequest` back as non-null (a label is not proof — ai-dossier#874: #869/#871 had the label and `autoMergeRequest=null`); a run that cannot confirm it falls back to attached and merges the PR itself. Say so in the plan.
- **Neither** → `ship_mode=attached` for every dispatch: each agent drives its own PR through CI, review-gated merge, deploy-confirm and teardown, and there are no tail runs. State it in the plan: `ship_mode=attached — <repo> has no auto-merge watcher and native auto-merge is disabled; parked PRs would never merge`.

Record the chosen `ship_mode` and the evidence (watcher path, `allow_auto_merge`) in the FLEET-PLAN file. **Every ship mode merges only after the full review round** (review-issue `phase=review status=done`, then ship's verdict-freshness gate): detached does not skip review, and neither does a native auto-merge request — an agent that ran `gh pr merge --auto` before its review round was permission-blocked as "Merge Without Review" (#795 / PR #837). A run that reaches ship without a completed review round has failed; never merge or park it by hand.

## Phase 3.5: Prewarm the Pool

> Pool CLI invocation: always `npx -y @ai-dossier/worktree-pool@^0.7.2 <cmd>`. The bare `npx worktree-pool` only resolves where the package is installed locally (it 404s elsewhere), and versions before 0.5.1 have a data-loss bug in `gc`, and `claim` before 0.7.2 hands out a warm entry whose directory was deleted outside the pool, failing as `spawnSync git ENOENT`. Never pin an older version — and bump this range deliberately: a caret range on 0.x never leaves its minor (`^0.5.1` stays on 0.5.x).

Before dispatching each wave, from the **orchestrator** — not the agents (replenish is serial by construction, so one orchestrator prewarm is strictly cheaper than N agents cold-starting behind the pool lock):

```bash
# N = the smaller of this wave's size and max_parallel
N=$(( wave_size < max_parallel ? wave_size : max_parallel ))
npx -y @ai-dossier/worktree-pool@^0.7.2 replenish --count "$N"
```

Then wait until `npx -y @ai-dossier/worktree-pool@^0.7.2 status` shows Warm >= N — as an **armed watch** (one bounded blocking loop, poll every 10s, max 10 min; see Phase 4 rule 0), never an unarmed "check later". If the pool is not configured, say so once and continue — agents fall back to cold worktrees.

## Phase 4: Dispatch and Supervise

For each wave, in order:

0. **Every wait in this phase is an armed watch — run it per `imboard-ai/git/watch-task`.** This is the fleet's known lost-time failure: the orchestrator dispatches, says "waiting", ends its turn — and nothing ever wakes it, so finished runs sit un-tailed and hung runs are never noticed. Between dispatch and wave resolution the orchestrator must always be inside a blocking poll loop, a harness monitor/wait call, or covered by a verified scheduled wakeup — completion notifications alone don't cover hangs, so pair them with a timer. Per watch-task: check commands are the runstate trail + `gh pr view` (read-only); the progress signal is a new milestone or newly pushed commit; the stall timeout is 30 min feeding rule 4b's escalation ladder (its cap = watch-task's `max_recoveries`); watchdog work runs on the cheap tier (rule 1b).

1. Dispatch one **background agent per issue** in the wave (up to `max_parallel` concurrently). Each agent's task is exactly: run `full cycle issue <N>` — i.e. `ai-dossier run imboard-ai/git/full-cycle-issue --pull` for that issue, passing through `warmup_dossier`, the issue's resolved `base_branch`, and **the `ship_mode` chosen in Phase 3.25** (`detached` only where a merge mechanism exists).
1b. Dispatch each issue's full-cycle run at its tier per `dispatch_model_tier` (auto = judge per issue from its labels/title/likely paths, using the same risk signals as review tiering). The fleet's OWN work splits by role: dependency analysis and wave planning are judgment — do them at the strongest tier (i.e. the orchestrator itself); supervision, PR polling and tail dispatches are mechanical — tails and any watchdog run cheap.
2. **Detached ship is the fleet default — where the repo can merge a parked PR.** A dispatched run ends as soon as its PR is open and parked on auto-merge (full-cycle Phase 5 item 2b): no CI wait, no merge, no teardown, no report. The agent exits there and the orchestrator owns everything after the park. After each park, assert the PR has a merge mechanism — a confirmed watcher, or `gh pr view <pr> --json autoMergeRequest` non-null — and if it has neither, fail loudly: mark the issue **failed** with `reason=no-merge-mechanism` (ship posts it too) and redispatch it attached rather than counting it parked. Under `ship_mode=attached` (Phase 3.25 found no mechanism) each agent runs through merge, deploy-confirm and teardown itself: there is no parked state and no tail run, and rule 5's polling reduces to confirming the merge (rule 8) when the agent reports done.
3. A **dependent** issue must branch from the **updated** base — the merged result, not a stale snapshot. Its dependency must be fully merged before it is dispatched; this is why dependents live in a later wave.
4. Supervise the wave: track every issue in exactly one state — **running** (agent working), **parked** (last milestone is `phase=ship status=awaiting-merge` WITHOUT `ship_mode=attached`; PR open with a confirmed merge mechanism, agent exited — a milestone carrying `ship_mode=attached` means the run is still driving the merge itself and is **running**; read `ship_mode=`/`merge_mechanism=`/`ship_evidence=` on it to know whether GitHub or the run merges), **merged** (PR merged AND its tail run finished), **failed**, or **blocked**.
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
| Parked PRs never merge; `autoMergeRequest=null`, no watcher workflow | The repo has no merge mechanism for detached ship (ai-dossier#860). Phase 3.25 should have chosen `ship_mode=attached`; redispatch the issues attached (ship resumes on the existing `pr=`). Never `gh pr merge --auto` a PR whose review round has not completed. |
| A dispatched agent exits with its PR open | Under detached ship: expected — the run is parked, not done. Poll the PR; dispatch the tail run once it merges (Phase 4 rule 8). An un-tailed merge leaves a worktree behind and no completion report. |
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
- [ ] Ship mode chosen at plan time (Phase 3.25): `detached` only with a confirmed auto-merge watcher or native auto-merge that ship will request; otherwise `attached`, stated in the plan with its evidence
- [ ] Each issue dispatched as a background `full-cycle-issue` run with the planned `ship_mode`; every parked PR asserted to have a merge mechanism (watcher or non-null `autoMergeRequest`), else failed loudly as `no-merge-mechanism`
- [ ] No PR merged (or parked, or native-auto-merge-requested) before its full review round completed
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

## Fleet Lessons (proven in the 2026-09 fleets)

- **Reviewer hand-backs live on disk.** When a dispatched agent's review sub-agent finishes but its findings never reach the orchestrator (the agent exited, the notification was dropped, or the summary was truncated), do NOT re-run the review — read the full transcript at `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl` (the last assistant message is the hand-back). Re-running doubles cost and can return a different verdict for the same head.
- **`git stash` is shared across worktrees.** `refs/stash` is one ref for the whole repository, so every worktree in the pool sees the same stash stack: a `git stash pop` in one agent's worktree can apply ANOTHER agent's changes, and a `git stash drop` can destroy them. Fleet agents never use `git stash` — commit WIP on their own branch (the WIP Sync Rule) or copy files outside the worktree instead. If a stash already exists, identify its owner by `git stash list` branch name before touching it.
- **Re-check published versions right before merge.** Parallel runs that bump a package version choose it at implement time; a sibling PR can publish that same version first (or the registry may already carry it). Immediately before the merge — the ship step on attached runs, or before a parked PR's watcher merges — re-run `npm view <package> version` (and `versions --json` for the exact candidate) against the PR's `package.json`; on a collision, rebump on the branch, re-run the gates, and only then merge. A version collision fails the publish AFTER merge, when it is hardest to fix.

## Relationship to Other Dossiers

- **Composes**: `imboard-ai/git/full-cycle-issue` (one run per issue); `imboard-ai/git/watch-task` (the armed-watch discipline for all Phase 4 supervision waits).
- **Sits above**: the whole issue-workflow family (`gate`, `setup`, `plan`, `implement`, `review`, `ship`, `report`) — fleet-cycle never calls these directly; it only orchestrates full-cycle runs.
- **See**: `imboard-ai/git/issue-workflows-guide` for the single-issue workflow family.
