---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "issue-workflows-guide",
  "title": "Issue Workflows Guide",
  "version": "1.5.2",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Reference guide for the issue workflow family — explains when to use each workflow, how they compose from shared sub-dossiers, and available flags",
  "category": [
    "documentation"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "guide",
    "reference"
  ],
  "risk_level": "low",
  "requires_approval": false,
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "last_updated": "2026-08-29",
  "checksum": {
    "algorithm": "sha256",
    "hash": "3e1c35996e0b2dfa428e10695e7e8df4126cebf9739baab8b0b40e1831e1aa2b"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "4njQb+1EZf/Zq3QqGnZxRqHRBgqaWr1SjCc2EgogS4TyinbnM41KK2sGx1immi7uZMctKbbwXDlwtdpxsz/TDQ==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T10:26:15.545Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Issue Workflows Guide

Reference guide for the issue workflow family. The single-issue skills share the same sub-dossiers — improving any sub-dossier improves all workflows. `fleet-cycle` sits one level above and orchestrates many `full-cycle-issue` runs at once.

## Quick Reference

| Trigger phrase | Skill | What happens | When to use |
|---|---|---|---|
| `guided cycle issue 42` | `guided-cycle-issue` | Gate → setup → plan → **discuss** → implement → **[visual review]** → review → ship → rich report | Default for most issues. You want input on the plan or to review FE changes. |
| `full cycle issue 42` | `full-cycle-issue` | Gate → setup → plan → implement → review → ship → rich report (all autonomous) | Confident fire-and-forget. Simple/clear issues. |
| `start issue 42` | `start-issue` | Gate → setup → plan → **stop** | You want full manual control after planning. |
| `fleet cycle issues 1..9` | `fleet-cycle` | Resolve set → dependency DAG → wave plan → dispatch `full-cycle-issue` per issue across background agents (parallel where safe, serial where dependent) → aggregate report | A **list or range** of issues. Runs independent ones in parallel, dependent ones in order. |

## Single Issue vs. Fleet

The first three skills take **one** issue to a merged PR. `fleet-cycle` is the batch layer: give it `1,2,3` or `1..9`, and it builds a dependency-aware **wave plan** and dispatches a `full-cycle-issue` run per issue across background agents. It serializes issues that collide on files, blocks a failed issue's dependents, and presents the plan before auto-running. See `imboard-ai/git/fleet-cycle`.

## Flags

All three skills support:
- `--base <branch>`: Override the target branch (default: parsed from issue body `merges into \`<branch>\``, or `main`)

`guided-cycle-issue` also supports:
- `--review`: Force visual review checkpoint after implementation
- `--no-review`: Skip visual review (even if FE files were changed)

## How They Compose

```
                    gate-issue
                        │
                 setup-issue-workflow
                        │
                    plan-issue
                        │
            ┌───────────┼───────────┐
            │           │           │
       start-issue   guided     full-cycle
       (stops here)  (discuss)  (continues)
                        │           │
                 implement-issue ───┘
                        │
                 [visual review?]     ← guided only, auto-detect FE
                        │
                  review-issue
                        │
                   ship-issue
                        │
                  report-issue
```

## Sub-Dossier Reference

| Name | Registry Path | What it does | Used by |
|---|---|---|---|
| `gate-issue` | `imboard-ai/git/gate-issue` | Safety check (hard blocks, soft warnings, base branch) + **resume detection**: reads the last runstate milestone, verifies it against git/PR reality, emits `resume_from` | all three |
| `setup-issue-workflow` | `imboard-ai/git/setup-issue-workflow` | Branch + worktree (pool or cold) + warmup + claim issue label | all three |
| `plan-issue` | `imboard-ai/git/plan-issue` | Read issue + comments + explore code → write rich `PLANNING-{N}-{slug}.md` | all three |
| `implement-issue` | `imboard-ai/git/implement-issue` | Implement per plan + affected-scoped tests + `scripts/ci-parity.sh` when the repo has it | guided, full-cycle |
| `review-issue` | `imboard-ai/git/review-issue` | 7 parallel review agents (DRY, Security, Supportability, Maintainability, Docs, Convention, **blind Conformance vs the issue's Acceptance Criteria**) + fix findings | guided, full-cycle |
| `ship-issue` | `imboard-ai/git/ship-issue` | ci-parity → commit → push → PR (with AC checklist) → `awaiting-merge` milestone → CI/merge → teardown (incl. `ensure-test-env.sh --teardown`) | guided, full-cycle |
| `report-issue` | `imboard-ai/git/report-issue` | Rich summary → conversation + PR comment; mechanical trap write-back to `docs/agent-traps.md` when a CI fix was needed; deletes the PLANNING file | guided, full-cycle |
| `watch-task` | `imboard-ai/git/watch-task` | Armed-watchdog discipline for every long wait: blocking poll loop / harness monitor / verified scheduled wakeup, stall detection on progress signals, bounded recovery — kills the "waiting with nothing armed" lost-time failure | full-cycle (merge confirm), fleet-cycle (all supervision) |

## Shared Parameter: `base_branch`

All sub-dossiers receive a `base_branch` parameter. This enables epic sub-issues: an issue that merges into `epic/settings-redesign` instead of `main` will correctly branch from, test against, PR into, and merge into the epic branch.

- **Source**: Parsed from issue body (`merges into \`<branch>\``), or explicit `--base` flag
- **Default**: `main`
- **Flow**: gate extracts → setup branches from → plan explores on → implement tests against → ship PRs into → report mentions

## Runstate Milestones & Resume (v3.8+)

Every phase of a full-cycle run appends a `<!-- runstate:v1 -->` comment to the GitHub issue
(`phase= status= run= at=` plus phase keys). The issue is therefore the durable run log:

- **Resume**: re-running `full cycle issue N` after a dead session makes the gate read the last
  milestone, VERIFY it (branch/worktree exist, HEAD matches, PR state), and skip every completed
  phase (`resume_from=`). Ship posts `status=awaiting-merge` BEFORE the CI wait — the likeliest
  death point — so even a mid-merge death resumes in seconds.
- **Spec conformance**: plan extracts Acceptance Criteria; review's blind Conformance agent checks
  the diff against them (`met <file:line>` required); the PR body carries the checked list.
- **Knowledge**: repos may provide `scripts/ci-parity.sh` (exact CI gates, run locally),
  `scripts/ensure-test-env.sh` (remote Atlas/S3 test env, per-worktree isolation + teardown), and
  `docs/agent-traps.md` (grep-first symptom→trap→fix index; plan reads it, report writes it).
- **Fleet prewarm**: fleet-cycle replenishes the worktree pool once per wave via
  `npx -y @ai-dossier/worktree-pool@^0.5.1`; agents never run pool `gc`/`refresh`.

## Visual Review Checkpoint (guided-cycle only)

After implementation, the guided-cycle skill checks if visual review is needed:
1. **Force flag** (`--review` / `--no-review`): always wins
2. **Auto-detect**: If any `.tsx`, `.jsx`, `.css`, `.scss`, `.vue`, `.svelte` files were changed → review required
3. At the checkpoint: agent presents changes, user iterates until satisfied

## Rich Report Format

The `report-issue` sub-dossier produces:
- **What Changed**: 1-3 sentence summary
- **User-Facing Implications**: new screens, changed behaviors, breaking changes
- **Dev/Ops Implications**: new env vars, commands, schema changes, dependencies
- **Review Results**: fixed findings, escalated issues, clean categories
- Posted to both conversation and PR comment

## Design rationale (moved from the executing dossiers)

The dossiers carry the rules; the reasons live here.
- **Verification buys quality, not the generator's raw strength** — why full-cycle routes by role (mechanical cheapest, generation by risk, judgment strongest). The trade: occasional wall-clock loss to a redispatch for large cost cuts, with the runstate CLI, blind conformance, ci-parity, CI and the version-bump guard holding the bar. **Tune tiers** with `ai-dossier runstate stats --issues <set>` every ~20 runs.
- **Why the WIP sync rule exists.** A resuming agent on another machine cannot reach uncommitted work in a local worktree, and a milestone recording a local `worktree=` path is worthless to it — hence origin/<branch> is the durable work copy, the issue the durable state copy.
- **Why `[skip ci]` on WIP commits is right and on the PR head is fatal.** WIP commits carry `[skip ci]` so a long run does not fire a full CI suite on every intermediate push — that part is deliberate, keep it. But GitHub evaluates skip keywords (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, `skip-checks: true`) **per commit, against the head commit only**. If the last `wip(...)` commit is still the branch head when `gh pr create` runs, the `pull_request` event is suppressed entirely: the PR opens with ZERO `pull_request` runs. It fails silently — no red check, no failed run — so an auto-merge watcher that gates on absence-of-failure merges it untested. 8 of 200 merged PRs did exactly this (imboard#3799, 2026-08-25), all with a `wip(review): … [skip ci]` head. Hence ship-issue Step 2.5 (blocking gate before `gh pr create`) and Step 3a (post-create proof a `pull_request` run exists). The remedy is an **empty commit on top, never `git commit --amend`** — amending rewrites the head sha and the `head=` shas in earlier milestones stop being ancestors, breaking gate-issue's remote check on resume. The repo-side half shipped in imboard#3803 (2026-08-26): the imboard watcher now blocks when a required check-run is *absent*, not just failing. Keep the dossier-side gates anyway — a generic dossier may run in a repo whose watcher lacks that guard.
- **Why milestones are CLI-posted, never hand-written.** The comment is the only run state surviving the session, so it must parse. A hand-written milestone that looks right but parses wrong makes the run unresumable; the raw `<!-- runstate:v1 -->` format is reader documentation, not a template.
- **Pool `gc` deleted 29 developer worktrees** (2026-08-23): the pool directory is shared with developer worktrees and `@ai-dossier/worktree-pool` ≤ 0.5.0 removed everything it did not create (ai-dossier#453). Hence `status`/`claim`/`return`/`replenish`/`detect` only, always `@^0.5.1`; maintenance is a human task.
- **Rename-then-repair.** Repurposing renames a worktree's directory, breaking git's internal tracking; `git worktree repair` fixes it.
- **Merged is not shipped.** Where a bot token merges, GitHub does not fire `on: push`, so the deploy never runs on its own — four PRs merged green, zero deploys, 2026-07-17 (imboard#2714). That release gap is why ship-issue has Step 6c and the report's `Shipped` line is mandatory.
- **Review is report-then-apply because parallel writers collide.** Two agents each "fixing" one problem add their own helper; the loser's ships uncalled as dead code (ai-dossier#447). One serial applier is the fix.
- **Cleanup and duration must be verified, not claimed.** A 63-second "full review" and an untrue `cleanup=pool_returned` both looked fine in the trail (imboard#3692) — hence review's duration floor and ship's confirm-before-claiming rule.
- **Detached ship economics.** A parked PR costs nothing to hold; an agent waiting ~20 min on CI costs a concurrency slot. So the run ends at `awaiting-merge` and a cheap tail run does teardown + report — why fleet dispatches detached, and why a quiet fleet agent is normal.
