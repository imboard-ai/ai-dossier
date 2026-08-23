---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "fleet-cycle",
  "title": "Fleet Cycle — Orchestrate Multiple Issues",
  "version": "1.3.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-23",
  "objective": "Take a SET of GitHub issues to merged PRs by building a dependency-aware wave plan and dispatching full-cycle-issue runs across background agents — serial, parallel, or mixed",
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
    "hash": "ed9a7893dccbae0bb63801e1a0f7f014837947659ff7fb0155db06953818f8f2"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "lXL12aTuU7tLJD9RvvltKAU24rXKL7iRFrVQlax/7QgfvIgmyne8r0GWUeSJeeNgAPO+tCRlfA+Qlh8Izn6mCw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T06:37:16.031Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Fleet Cycle — Orchestrate Multiple Issues

## Objective

Take a **set** of GitHub issues to merged PRs. This dossier is the orchestration layer **above** `full-cycle-issue`: it does not re-implement the cycle. It resolves the issue set, builds a dependency-aware **wave plan**, and dispatches one `full-cycle-issue` run per issue across background agents — running independent issues in parallel and dependent issues in order.

Each individual issue is still handled end-to-end by `imboard-ai/git/full-cycle-issue` (gate → setup → plan → implement → review → ship → report). Fleet-cycle owns only what a single run cannot: **set resolution, dependency analysis, scheduling, dispatch, supervision, and aggregate reporting.**

## Guiding Principle

**Plan, then auto-run.** Resolve the set, build the wave plan, write it to a file, present it — then dispatch automatically without waiting for approval. Mirror full-cycle's no-checkpoint philosophy. The user interrupts only if they disagree with the plan.

Pause to ask only when:
- An issue number is invalid, closed, or does not exist
- A genuine dependency cycle is detected (A needs B and B needs A) that cannot be ordered
- The whole set collides on the same files such that no parallelism is safe AND the serial chain is very long (surface it; let the user decide whether to proceed serially or narrow the set)

Do NOT ask about: wave composition, branch order, concurrency level, or any mechanical scheduling decision.

## Prerequisites

- [ ] `full-cycle-issue` and its sub-dossiers are available in the registry
- [ ] GitHub CLI (`gh`) installed and authenticated; push access to the repo
- [ ] A worktree pool is configured (recommended) so parallel runs get instant worktrees rather than cold-starting and contending
- [ ] The environment can spawn background agents (the orchestrator dispatches one per concurrent issue)

## Phase 1: Resolve the Issue Set

1. Parse `issues` into a concrete list of integers:
   - Explicit list: `1,2,3` → `[1,2,3]`
   - Range: `1..9` → `[1,2,3,4,5,6,7,8,9]`
   - Mixed: `1,2,5..8` → `[1,2,5,6,7,8]`
   - De-duplicate and sort ascending.
2. For each issue, fetch title, body, labels, linked issues, and state (`gh issue view`).
3. Drop any issue that is closed or non-existent — report it as skipped with the reason. Do not silently omit.

## Phase 2: Build the Dependency Graph

Determine, for every pair of issues in the set, whether one must merge **before** the other. Use both explicit signals and judgment. **When uncertain, prefer adding a dependency edge (serialize) over assuming independence** — a false parallel is far more expensive than a false serial.

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

Apply `mode`:
- `auto` (default): the wave plan as computed.
- `serial`: collapse to one issue per wave, ascending number order.
- `parallel`: a single wave with all issues (only when the user asserts independence).

Respect `max_parallel`: if a wave has more issues than the cap, dispatch in batches within the wave, refilling as runs finish.

**Write the wave plan to `~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md`** capturing: the resolved set, the dependency edges with their justification (explicit vs inferred), the wave breakdown, the concurrency cap, and the failure policy.
- `{project}` = repo slug `<owner>-<repo>` from `gh repo view --json owner,name -q '.owner.login + "-" + .name'`; if that fails (no remote / no `gh`), fall back to the basename of `git rev-parse --show-toplevel`.
- `{timestamp}` = UTC `YYYYMMDD-HHMMSS`.
- `mkdir -p` the target directory, write the file, then `gzip -f` it in place so the artifact on disk is `FLEET-PLAN-{timestamp}.md.gz`.
- **Retention**: after writing, list `FLEET-PLAN-*.md.gz` in that project's log directory by mtime and delete all but the 20 most recent.
- Present a concise version of the plan in the conversation — the file is for audit/history, not re-read during this run.

## Phase 3.5: Prewarm the Pool

Before dispatching each wave, from the **orchestrator** — not the agents:

```bash
# N = the smaller of this wave's size and max_parallel
N=$(( wave_size < max_parallel ? wave_size : max_parallel ))
npx worktree-pool replenish --count "$N"
```

Then wait until `npx worktree-pool status` shows Warm >= N. Poll every 10s, max 10 min.

Replenish is serial by construction, so one orchestrator prewarm is strictly cheaper than N agents cold-starting behind the pool lock.

If the pool is not configured, say so once and continue — agents fall back to cold worktrees.

## Phase 4: Dispatch and Supervise

For each wave, in order:

1. Dispatch one **background agent per issue** in the wave (up to `max_parallel` concurrently). Each agent's task is exactly: run `full cycle issue <N>` — i.e. `ai-dossier run imboard-ai/git/full-cycle-issue --pull` for that issue, passing through `warmup_dossier` and the issue's resolved `base_branch`.
2. For a **dependent** issue (one whose dependency just merged), its base must be the **updated** base branch — branch from the merged result, not from a stale snapshot. The dependency must be fully merged before the dependent is dispatched; this is why dependents live in a later wave.
3. Supervise the wave: track each run as succeeded (PR merged), failed (CI red, unresolved merge conflict, or escalated review that blocks merge), or still running.
4. **Failure policy — block dependents.** When an issue fails:
   - Mark every issue that depends on it (directly or transitively) as **blocked** and do **not** dispatch them.
   - Issues with no dependency on the failure continue normally.
   - Record the failure and the blocked set for the final report.
5. Do not advance to the next wave until the current wave has fully resolved (all runs either merged, failed, or blocked).
6. **An agent reporting idle or "done" is NOT proof of merge.** Background full-cycle agents routinely idle with the PR green-but-unmerged. Before marking an issue **succeeded**, advancing to the next wave, or dispatching dependents, the orchestrator MUST independently verify `gh pr view <pr> --json mergedAt,state` shows `mergedAt` non-null **and** `state` `MERGED`, **and** the issue is CLOSED. If the PR is green-but-unmerged, merge it directly (`gh pr merge <pr> --squash`) — or re-task the agent — before proceeding. Never treat an idle/"done" signal as merge confirmation.

**Runstate is per-run, not per-fleet.** Each `full-cycle-issue` run mints its own `run_id` at its gate phase; fleet-cycle neither mints nor passes one. The orchestrator reads runstate, it does not write it.

**Concurrency discipline:** never exceed `max_parallel` concurrent runs, and never exceed worktree-pool capacity. If the pool is exhausted, queue and dispatch as worktrees free up rather than cold-starting many worktrees at once.

## Phase 5: Aggregate Report

Produce a single roll-up across the whole fleet:
- **Per issue**: status (merged / failed / blocked / skipped), PR link, one-line summary.
- **Merged**: count and PR links.
- **Failed**: each with the failure reason and where it stopped.
- **Blocked**: each with which failed dependency blocked it (so the user can re-run after fixing).
- **The wave plan as executed**, including any divergence from the original plan.
- **Runstate**: a direct link to each issue's LAST `<!-- runstate:v1 -->` comment, so the exact phase each run reached is one click away (including failed and blocked issues).

Post the roll-up to the conversation. Include direct PR URLs for every merged and failed issue.

## Known Pitfalls

- **Parallel merges into the same base race.** Two PRs that both merge into `main` and touch the same file will conflict even if dispatched "independently." This is why file-overlap is a dependency edge, not a parallel — serialize on any plausible overlap.
- **Stale base for dependents.** A dependent issue branched before its dependency merged will miss the dependency's code and likely conflict. Dependents must wait for the merge and branch from the updated base — enforced by wave gating.
- **Worktree-pool exhaustion.** Dispatching more parallel runs than the pool can serve causes cold-start storms and disk pressure. Bound concurrency by `max_parallel` and pool capacity, whichever is smaller.
- **`gh` / CI rate limits and contention.** Many simultaneous runs hammer the API and CI queue. Keep `max_parallel` modest (default 3).
- **Optimistic independence.** The most expensive failure mode is assuming two issues are independent when they aren't — you discover it at merge time after both ran. When in doubt, serialize.
- **Background agent visibility.** Long-running background runs can fail silently. Supervise actively; surface failures as they happen, not only at the end.
- **Green-but-unmerged idle.** Background full-cycle agents reliably idle with the PR green but unmerged, then emit an idle/"done" signal that looks like progress. The orchestrator must independently verify `mergedAt` is non-null (Phase 4, rule 6) before counting an issue as succeeded — never trust the agent's idle signal as proof of merge.
- **Partial fleet success is normal.** Blocking dependents on failure means a run may end with some issues merged, some failed, some blocked. The report must make the blocked set and its cause explicit so the user can re-run the remainder.

## Decision Points

| Situation | Decision |
|---|---|
| Uncertain whether two issues collide | Add a dependency edge (serialize). False serial < false parallel. |
| Issue declares `merges into <branch>` | That branch is its base; honor epic/sub-issue chains. |
| Dependency cycle detected | Surface it and ask — cannot be auto-ordered. |
| Wave wider than `max_parallel` | Batch within the wave; refill as runs complete. |
| An issue fails mid-wave | Block its transitive dependents; let independents continue. |
| User passed `mode=parallel` | Trust the assertion of independence; single wave, all at once. |

## Validation

- [ ] Issue set resolved from list/range; closed/missing issues reported as skipped
- [ ] Dependency graph built from explicit + inferred signals
- [ ] No undetected dependency cycle
- [ ] Wave plan computed and written to `~/.dossier/logs/fleet-cycle/{project}/FLEET-PLAN-{timestamp}.md.gz` (gzipped; older entries beyond the most recent 20 pruned)
- [ ] Plan presented before dispatch
- [ ] Each issue dispatched as a background `full-cycle-issue` run
- [ ] Concurrency never exceeded `max_parallel` or pool capacity
- [ ] Dependents branched from updated base after their dependency merged
- [ ] Failures blocked their transitive dependents; independents continued
- [ ] Wave N+1 gated on wave N resolution
- [ ] Pool prewarmed before each wave (or the missing-pool case reported once)
- [ ] Aggregate report posted with per-issue status, PR links, and last-runstate-comment links

## Relationship to Other Dossiers

- **Composes**: `imboard-ai/git/full-cycle-issue` (one run per issue).
- **Sits above**: the whole issue-workflow family (`gate`, `setup`, `plan`, `implement`, `review`, `ship`, `report`) — fleet-cycle never calls these directly; it only orchestrates full-cycle runs.
- **See**: `imboard-ai/git/issue-workflows-guide` for the single-issue workflow family.
