---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "full-cycle-issue",
  "title": "Full Cycle Issue Workflow",
  "version": "3.14.1",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-26",
  "objective": "Take a GitHub issue from start to merged PR autonomously — composed from shared sub-dossiers: gate, setup, plan, implement, review, ship, and report",
  "category": [
    "development"
  ],
  "tags": [
    "github",
    "issues",
    "workflow",
    "autonomous",
    "full-cycle",
    "pr",
    "merge"
  ],
  "risk_level": "high",
  "risk_factors": [
    "modifies_files",
    "network_access",
    "creates_pull_request",
    "merges_code"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates new git branch",
    "Creates new git worktree",
    "Pushes branch to remote",
    "Creates pull request and applies the `auto-merge` label (a server-side watcher performs the merge — see Phase 5)",
    "Deletes branch after merge (performed by the auto-merge watcher)"
  ],
  "inputs": {
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Which warm-worktree dossier to use for worktree warmup. Passed through to setup-issue-workflow. Override for project-specific warmup (e.g., imboard-ai/imboard/warm-worktree-pnpm-ssm for pnpm+SSM).",
        "type": "string",
        "default": "imboard-ai/git/warm-worktree"
      },
      {
        "name": "base_branch",
        "description": "Target branch to branch from and merge into. Overrides issue body parsing. Use for epic sub-issues.",
        "type": "string",
        "default": "auto"
      },
      {
        "name": "ship_mode",
        "description": "attached (default) = Phase 5 drives the PR to a confirmed merge and deploy, then Phase 6 reports. detached = Phase 5 parks the PR on auto-merge, posts the awaiting-merge milestone, and the run STOPS; a later run resumes at ship-teardown. Fleet-cycle dispatches detached.",
        "type": "string",
        "default": "attached"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "content_scope": "references-external",
  "checksum": {
    "algorithm": "sha256",
    "hash": "5698bcd7df81a6b1f98232e676ac9256c504c17f76719b197472c0995e09e598"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "LZs1JBp4VDULtSfP1HMZhRnUi5horYA6beDv1VRAqivJbW4kx3LZ6EtMie6FB7dE1BY2RvgjJmzouMpkwC0YAw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-26T10:41:17.483Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Full Cycle Issue Workflow

## Objective

Take a GitHub issue from start to merged PR autonomously. For small-to-medium issues with clear requirements. Composed from shared, independently versioned sub-dossiers.

## Guiding Principle

**Do not ask the user interactively, at any phase.** This runs unattended — there may be no one present to answer. If the run cannot complete autonomously, STOP and hand the decision back through the issue itself; never wait on a reply in this conversation.

Stop and hand off when: the issue is too vague to implement · a business/product/design decision is genuinely ambiguous, including anything review escalates (Phase 4) or a CI/merge blocker needing judgment (Phase 5) · tests fail after 2 fix attempts with no clear path · merge conflicts require human judgment.

**How to hand off** (same procedure every time, whichever phase triggers it):
1. Push whatever work exists so nothing is lost; note the branch name in the comment (Step 2).
2. `gh label create decision-pending --color "5319E7" --description "Blocked on a human decision" --force` then `gh issue edit <number> --add-label "decision-pending" --remove-label "in-progress"`.
3. Post ONE comment on the ORIGINAL issue — never a new issue — stating exactly what decision is needed: file/line references, the options, and enough context that a human (or a future run) can act without re-deriving your reasoning.
4. End the run. Do NOT open a PR if one doesn't exist yet, and do NOT proceed to Ship or Report.

**Never open a new GitHub issue as a substitute for this.** One issue in, at most that same issue updated — decision recorded in its comments — never fanned out into follow-up issues.

Do NOT ask about (just proceed): file names, branch names, commit messages, PR descriptions, whether to proceed, or any other mechanical decision.

**Ship attachment.** In fleet context ship runs detached — PR parked on auto-merge, run ends there (Phase 5, `ship_mode`). Solo runs stay attached unless the user passes `--detached`.

### Model routing (by role, not by strength)

| Role | Phases | Tier |
|---|---|---|
| Mechanical | gate, setup, ship tail (teardown/merge-confirm), report, fleet supervision | cheapest available — CLI calls and templates |
| Generation | plan, implement, review agents 1–6, ship (commit/PR/CI-fix) | by issue risk: docs/chore → cheap; standard bug/feature → mid-tier; security, payments/billing, migrations, auth, protocol/schema changes → strong |
| Judgment | conformance review agent, escalation decisions, fleet dependency/DAG planning | ALWAYS the strongest available — the trust anchor, a small fraction of total tokens |

**Escalation ladder.** Dispatch at the tier above; redispatch the SAME run one tier stronger (resume protocol carries the work forward) on any of: milestone non-compliance (a phase finished without its milestone and the milestone gate had to backfill) · a stall (no new milestone and no new pushed commit for 30+ minutes) · conformance `not-met` on the same AC twice · an implausible review (review-issue's duration floor). Cap: two escalations per run, then `status=blocked reason=escalation-cap` and hand off. (Rationale and tuning cadence: `imboard-ai/git/issue-workflows-guide`.)

## Runstate Milestones

Every phase ends by posting ONE milestone comment to the issue — the only run state surviving the session. Nested and fleet-dispatched runs post them too.

**Post milestones ONLY via `ai-dossier runstate post`.** It validates phase/status/keys and refuses malformed milestones. If unavailable, install the CLI (`npm i -g @ai-dossier/cli`) — do not fall back to hand-written comments.

```bash
ai-dossier runstate post --issue <issue_number> --phase <phase> --status <done|partial|blocked|awaiting-merge> \
  --run <run_id> --kv key=value --kv key=value ...
```

Rules:

- `run_id` is minted ONCE by gate-issue (`ai-dossier runstate mint --issue <issue_number>`) and passed to every later sub-dossier exactly like `base_branch`.
- The CLI stamps `at=` and computes `next=`. Pass `--next` only where a sub-dossier overrides it — ship's first milestone uses `--next ship`.
- Append-only. Readers take the LAST milestone (`ai-dossier runstate last --issue <n> --json`). Never edit or delete a prior milestone.
- Values contain no spaces (use `-` or `,`); paths are absolute. The one exception is plan's `ac<n>=` criteria, quoted and verbatim.
- Posting the milestone is the last step of the phase. If a phase aborts, post `--status blocked --kv reason=<short-slug>` before stopping.

Per-phase `--kv` keys:

| phase | status | keys |
|---|---|---|
| gate | done / blocked | `base_branch=` `warnings=<n>` `model=<model id of the executing agent>` (blocked: `reason=closed\|decomposed\|needs-clarification\|epic\|open-dependency-<N>`) |
| setup | done / blocked | `branch=` `worktree=<abs path>` `pool_claimed=true\|false` `base_branch=` `remote=pushed` |
| plan | done / blocked | `planning=<abs path>` `head=<short sha of base at plan time>` `open_questions=<n>` `visual_review=true\|false` |
| implement | done / blocked | `head=<short sha>` `files=<n>` `tests_added=<n>` `tests_run=<n>` `ci_parity=pass\|fail-then-fixed\|blocked-external\|skipped` |
| review | done / partial / blocked | `head=` `fixed=<n>` `escalated=<n>` `tier=micro\|docs\|small\|full` `agents_done=<comma list>` `agents_pending=<comma list or none>` (lists cover only the tier's agents) |
| ship (1st, BEFORE the CI/merge wait) | awaiting-merge | `pr=<n>` `head=<pushed sha>` `ci_fix_attempts=0` |
| ship (2nd, after merge + teardown) | done / blocked | `pr=` `merge_commit=` `ci_fix_attempts=<n>` `cleanup=pool_returned\|worktree_removed\|skipped` |
| report | done | `pr=` `traps_added=<n>` |

`next=` is the following phase: gate → setup → plan → implement → review → ship → report → done.

**Milestone gate (orchestrator duty).** Before each phase, run `ai-dossier runstate last --issue <issue_number> --json` and inspect `.phase` — sub-dossiers sometimes skip the milestone when run inline. If it is not the phase that just finished, post it yourself from the outputs you have before continuing; a run with missing milestones cannot be resumed.

## WIP Sync Rule

**origin/<branch> is the durable copy of the work; the issue is the durable copy of the state.** A phase is not "done" until both are true.

Every phase that changes the working tree syncs to origin BEFORE posting its milestone: `git add -A && git commit -m "wip(<phase>): <one line> [skip ci]" && git push -u origin <branch>` (commit only if there are changes). `git add -A` respects `.gitignore`; never force-add ignored files (`.env` etc). WIP commits are disposable — ship squash-merges, so they never reach the base branch. The milestone's `head=` is the sha ON ORIGIN (`git rev-parse --short HEAD` after the push), never `-dirty`. Ship's commit lands on top of the WIP commits; the squash-merge collapses them into one.

**The `[skip ci]` marker is correct on every WIP commit and forbidden on the PR head.** It exists so a long run does not fire a full CI suite on each intermediate push — keep it. But GitHub evaluates skip markers **per commit, against the head commit only**: if a `wip(...) [skip ci]` commit is still the branch head when `gh pr create` runs, the `pull_request` event is suppressed entirely and the PR opens with ZERO CI runs — silently, with no failed check for an auto-merge watcher to catch. ship-issue Step 2.5 is the blocking gate that must clear this (empty commit on top — never `--amend`, which would break the `head=` ancestry that gate-issue's remote check relies on), and Step 3a is the post-create proof that a `pull_request` run actually exists. Neither is optional, and neither may be satisfied by removing `[skip ci]` from the WIP commits themselves.

## Resuming

Phase order: gate → setup → plan → implement → review → ship → report. Skip every phase preceding `resume_from`.

**Skipping setup**: take `branch`, `pool_claimed`, `base_branch` from `resume_context`, then `git fetch origin <branch>`. If the recorded `worktree=` path exists on THIS machine and its HEAD matches origin, `cd` in. Otherwise create one from the synced branch — `git worktree add <repo>/worktrees/<branch-slug> <branch>` (after `git branch --track <branch> origin/<branch>` if needed) — run the repo's warmup (pool claim does not apply to an existing branch; use the warmup_dossier or `pnpm install`+build equivalent), and `cd` in (hard gate `pwd | grep -q worktree` still applies). Uncommitted work does not exist by protocol; if an inherited worktree has local changes, commit and push them as `wip(recovered): [skip ci]` first. **Skipping plan**: take `planning` from `resume_context` (the planning-file check happens here, after the worktree is materialized — gate-issue Step 1.5). **Review with `agents_pending`** → run only those agents. **`ship-wait`** → ship Step 5 (CI wait) with `pr` from context; **`ship-teardown`** → ship Step 7 post-merge cleanup.

## Prerequisites

- [ ] Git and GitHub CLI (gh) installed, configured, authenticated
- [ ] `ai-dossier` CLI >= 0.10.0 — confirm with `ai-dossier runstate --help`; every phase posts its milestone through it
- [ ] In a git repository with GitHub as a remote, with push access

## Actions to Perform

### Phase 0: Gate

Always runs — it determines `resume_from`.

1. Extract the issue number from user input; run `ai-dossier run imboard-ai/git/gate-issue` with it. If the gate fails, stop — do NOT proceed.
2. Note `base_branch` (a `base_branch` parameter provided in context, and not `"auto"`, wins instead), `run_id` (pass to every subsequent sub-dossier), `resume_from` and `resume_context` — see "## Resuming".

### Phase 1: Setup

**Skip if `resume_from` is later than this phase.**

1. **Pre-flight: clean stale worktrees.** `git worktree list`; a worktree is stale ONLY if ALL hold: its branch is gone from the remote (`git ls-remote --exit-code origin <branch>` fails) AND `git -C <wt> status --porcelain` is empty AND it is not pool-managed (not in `.pool-state.json`) AND its issue has no mid-run runstate trail. In squash-merge repos `merge-base --is-ancestor` is meaningless — never use it as a staleness signal. When unsure, leave the worktree; `git worktree prune` alone is always safe.
2. **Claim the issue** — make it visible that work is in progress:
   ```bash
   gh label create "in-progress" --color "FBCA04" --description "Actively being worked on" --force
   gh issue edit <number> --add-label "in-progress" --add-assignee "@me"
   gh issue comment <number> --body "**Agent pickup** — work started (full-cycle-issue v3.0)"
   ```
3. **Record the original working directory** — you return here after merge.
4. Run `ai-dossier run imboard-ai/git/setup-issue-workflow`, passing `warmup_dossier`, `base_branch`, `run_id`. When asked where to work, always choose option 1 (new git worktree).
5. Note the worktree path, branch name, and `pool_claimed`; `cd` into the worktree.
6. **Verify you are in a worktree** — hard gate:
   ```bash
   pwd | grep -q "worktree" && echo "OK: in worktree" || echo "FAIL: not in worktree"
   ```
   If FAIL: abort, comment on issue, remove in-progress label. Do NOT work in current directory.
7. Update the issue comment with the branch name.

### Phase 2: Plan

**Skip if `resume_from` is later than this phase.**

1. Run `ai-dossier run imboard-ai/git/plan-issue`, passing the issue number, base_branch, worktree path, `run_id`, and `prod_data_access` = "Use the `mongodb-prod` MCP (read-only `count`/`find`/`aggregate`) against the production cluster to confirm a new state/flow actually occurs before building it; 0 occurrences ⇒ don't build, escalate (retro #1632)" — this drives plan-issue's reachability check.
2. **In full-cycle mode: proceed immediately.** Do not checkpoint with the user. If the issue is genuinely ambiguous, apply the Guiding Principle hand-off (stop, don't ask) rather than guessing. **Exception path is the same, not different:** a reachability escalation (new state, 0 prod occurrences) is also a hand-off case — stop and record the decision needed; do not build an unreachable state.

### Phase 3: Implement

**Skip if `resume_from` is later than this phase.** Run `ai-dossier run imboard-ai/git/implement-issue`, passing the planning file path, base_branch, and `run_id`.

### Phase 4: Review

**Skip if `resume_from` is later than this phase.**

1. Run `ai-dossier run imboard-ai/git/review-issue`, passing the issue number and `run_id`.
2. **This is a tiered review (1–7 report-only agents + serial apply), not a fixed parallel fan-out.** review-issue applies a risk floor then per-dimension relevance (`micro`/`docs`/`small`/`full`) and applies fixes itself; no agent edits files. Expect `tier=` and agent lists covering only that tier in the milestone.
3. Collect `review_tier`, `review_fixed`, `review_escalated`, `review_clean`, `ac_results` (per-AC checklist — pass through to Ship for the PR body).
4. **If `review_escalated` is non-empty: apply the Guiding Principle hand-off and STOP — do not proceed to Phase 5.** review-issue restricts escalation to findings that genuinely need a product/business decision, so reaching this step means a real decision is needed, not a fan-out of side issues. List each escalated finding in the comment (file/lines, description, why it needs a human call), grouped by category if more than one.

### Phase 5: Ship

**Skip if `resume_from` is later than this phase.** `ship-wait` enters ship at Step 5 (CI wait) with `pr` from `resume_context`; `ship-teardown` at Step 7 (post-merge cleanup).

**Only reached when `review_escalated` was empty at the end of Phase 4** — ship-issue's own prerequisites assume this and do not create GitHub issues for anything.

1. Run `ai-dossier run imboard-ai/git/ship-issue`.
2. Pass through: issue number, base_branch, worktree_path, original_dir, pool_claimed, `run_id`, `ship_mode`, `ac_results` (from Phase 4 — builds the PR body's Acceptance Criteria section).
2b. **`ship_mode=detached` ends the run here** (ship-issue Step 3c): PR opened, parked on a confirmed `auto-merge` label, `awaiting-merge` milestone posted, run STOPS — no CI wait, no merge, no teardown, **no Phase 6**. The worktree is left in place (work already pushed). gate-issue maps a merged PR on that milestone to `resume_from=ship-teardown`, so a later `full cycle issue <n>` re-enters at teardown and runs Phase 6. Items 3–7 are the **attached** path (and what that tail run executes).
3. **Opening a PR is NOT completion, and neither is merging it. You are done when the merge has REACHED PRODUCTION** (or you have a hard blocker you escalated). A PR left green-but-unmerged is a FAILED run; a PR merged but never deployed is code live to nobody — see ship-issue Step 6c.
**Merge authority**: items 4–5 apply ONLY when the repo has an auto-merge watcher (`.github/workflows/auto-merge-watcher.yml` exists). Without one, attached mode self-merges per ship-issue Step 6 and these items are moot.
4. **Both ship milestones still get posted** on the watcher path: `awaiting-merge` when the PR opens (ship Step 3b), `done` once merge and teardown are confirmed (Step 8) — or `blocked` with a `reason=` if the watcher blocks or the PR is unmerged at hand-off.
5. **Hand off the merge to the auto-merge watcher — do NOT babysit CI and do NOT merge the PR yourself.** An `auto-merge-watcher` Action (every 5 min) squash-merges green, clean PRs server-side and deletes the branch. Your terminal action: apply and **confirm** the `auto-merge` label (ship Step 3c items 1–2 — retry once on failure, then escalate as a hard blocker; do NOT fall back to self-merging / CI polling), then exit the polling loop. Do NOT re-run `gh pr checks` / `statusCheckRollup` in a loop, do NOT `gh pr merge` yourself, do NOT background a CI monitor.
6. **Confirm the merge before reporting done** (passive, not CI babysitting): poll `gh pr view <pr_number> --json mergedAt` every ~3–5 min, up to ~25 min, until non-null — run this as an **armed watch per `imboard-ai/git/watch-task`**: a single bounded blocking poll loop or harness monitor/wait call that holds you until resolution or timeout. Never end the turn "waiting for the watcher" with nothing armed — an unarmed wait strands a green-but-unmerged PR (or a merged one) indefinitely, the run's known lost-time failure. The same rule covers ship's CI wait (Step 5) and the deploy watch in attached mode. Then ship Step 6b must pass, then Step 6c ALSO — a successful deploy must carry `MERGE_COMMIT`, dispatched by you if nothing else does. Where a bot token merges, GitHub does not fire `on: push`, so the deploy NEVER runs by itself. Do not confuse "merged" with "shipped".
7. **If the watcher blocks the merge** (`auto-merge-blocked` label + reason comment, `auto-merge` removed) **or the PR is still unmerged after ~25 min**: apply the Guiding Principle hand-off — the PR exists, so skip the "push work" step, just label and comment. Do NOT silently exit on an unmerged PR. Capture the blocker in the report with `MERGE_COMMIT` empty.

### Phase 6: Report

**Skip if `resume_from` is later than this phase** (`resume_from=done`).

**Only reached on a real completion** — if Phase 4 or 5 stopped via the Guiding Principle hand-off, the run already ended there; do not run this phase. A `ship_mode=detached` run also ends before this phase: the tail run resuming at `ship-teardown` reports instead.

1. Run `ai-dossier run imboard-ai/git/report-issue`, passing: issue number, pr_number, base_branch, review_fixed, review_clean, cleanup_method, `run_id`.
2. **The structured report MUST include a `MERGE_COMMIT` field** — the squash-merge SHA (`gh pr view <pr_number> --json mergeCommit --jq '.mergeCommit.oid'`). Empty / `N/A` / missing is a **FAILURE**, not a success: it means the PR was not merged. Reporting it empty requires that you are also reporting a hard blocker you escalated (Phase 5.7); a clean exit with an unmerged PR is a failed run.
3. **The report MUST also carry `DEPLOYED`** (report-issue's `Shipped` line): the deployed SHA + run URL, `N/A — <reason>` when the project genuinely has no deploy step, or an explicit `NOT DEPLOYED` warning naming what a human must run. `MERGE_COMMIT` present + `DEPLOYED` absent is the failure this field exists to catch — it reads as a clean run while the change is live to nobody.

## Validation

Orchestration-level only — each sub-dossier validates its own phase.

- [ ] Phase 0 gate passed (no hard blocks); issue claimed with in-progress label
- [ ] Branch and worktree created (pool claim or cold), and verified in worktree before proceeding
- [ ] Review tier selected and stated; only that tier's agents ran, all report-only; findings deduped, then applied serially by the review phase (no agent edited files)
- [ ] PR created targeting correct base_branch
- [ ] Zero escalated findings reached Ship — any escalation stopped the run at Phase 4 with a decision-pending hand-off on the issue (Guiding Principle), not a new GH issue
- [ ] `auto-merge` label applied to PR and confirmed present
- [ ] Every in-run wait (CI, merge confirm, deploy) ran as an armed watch per `imboard-ai/git/watch-task` — blocking loop or monitor call, never a turn ended with nothing armed
- [ ] PR merged by the watcher — `MERGE_COMMIT` captured (`mergedAt` non-null, ship Step 6b). Empty `MERGE_COMMIT` = FAILED run unless a hard blocker was escalated
- [ ] Merge REACHED PRODUCTION — a successful deploy carries `MERGE_COMMIT`, and `DEPLOYED` is in the report (ship Step 6c). Merged ≠ shipped; `N/A` only when the project has no deploy step
- [ ] Worktree returned to pool or removed; returned to original working directory; rich report posted to conversation and PR comment
- [ ] A runstate milestone was posted via `ai-dossier runstate post` after every phase (ship posted two — one only, on a detached run)
- [ ] Every phase that touched the working tree synced to origin (WIP Sync Rule) before posting its milestone — `head=` values are pushed shas, never `-dirty`
- [ ] The PR head commit carried NO CI skip marker at `gh pr create` time (ship Step 2.5 printed `CI-TRIGGER-OK`), and >= 1 `pull_request`-triggered run exists for that sha (ship Step 3a). A PR with zero `pull_request` runs is a FAILED run even if it merged green
- [ ] `ship_mode` honored: `detached` ended the run at the `awaiting-merge` milestone with the PR parked on auto-merge (Phase 5 item 2b) and left Phase 6 to the tail run; `attached` drove the merge, deploy, and report
- [ ] On resume, no phase before `resume_from` was re-run; a skipped setup materialized the worktree from origin (cloned fresh if absent on this machine) rather than assuming local state

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh` not found | Install GitHub CLI: https://cli.github.com/ |
| Vague issue · merge conflicts · CI fails after fixes | Apply the Guiding Principle hand-off — do not guess at intent or at a conflict resolution; for CI, say in the comment whether it looks like infrastructure rather than code |
| No test framework detected | Default to vitest (Node.js) or pytest (Python) |
| Pre-existing test failures | Run tests on the base branch to confirm |
| Review fix breaks tests | Revert the fix and reclassify as Escalate (feeds the Phase 4 hand-off, not a new issue) |
| Pool return fails | Fall back to manual `git worktree remove` |
| `auto-merge-blocked` label appeared | The watcher did not merge — read its comment for the reason (failing check, conflict, branch-update failure). Fix the root cause, then re-apply `gh pr edit <pr_number> --add-label "auto-merge"` to re-queue. Do NOT self-merge as a workaround. |
| PR still unmerged after ~25 min | Apply the Guiding Principle hand-off (Phase 5 item 6) — the watcher may be down or the PR may be stuck BEHIND. Do NOT silently exit. |
