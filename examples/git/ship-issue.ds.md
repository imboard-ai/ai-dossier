---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "ship-issue",
  "title": "Ship Issue — Commit, PR, Merge, Deploy, Teardown",
  "version": "1.12.1",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Commit changes, push, create a PR, then either drive it to a confirmed merge and deploy (attached) or park it on auto-merge and stop (detached); in batch mode (batch_id set): ship the batch PR from the batch branch — per-member PR sections, Closes #N per member, rebase-merged so one commit per member issue lands on the base branch",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "ship",
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
    "Pushes branch to remote",
    "Creates and merges pull request (squash for per-issue PRs; rebase for batch PRs — one commit per member issue lands on the base branch)",
    "Deletes branch after merge"
  ],
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number",
        "type": "number"
      }
    ],
    "optional": [
      {
        "name": "base_branch",
        "description": "Target branch for the PR",
        "type": "string",
        "default": "main"
      },
      {
        "name": "worktree_path",
        "description": "Path of the worktree to clean up after merge",
        "type": "string",
        "default": ""
      },
      {
        "name": "original_dir",
        "description": "Directory to return to after teardown",
        "type": "string",
        "default": ""
      },
      {
        "name": "pool_claimed",
        "description": "Whether the worktree was claimed from the pool (affects cleanup)",
        "type": "boolean",
        "default": false
      },
      {
        "name": "run_id",
        "description": "Runstate run id minted by gate-issue; pass through unchanged. In batch mode this is the batch's run id (minted against the anchor issue).",
        "type": "string"
      },
      {
        "name": "ship_mode",
        "description": "attached (default) = open the PR, wait for CI, merge, confirm the deploy, and tear down in this run. detached = open the PR, park it on auto-merge, post the awaiting-merge milestone, and STOP — a later run (gate resumes at ship-teardown) finishes it.",
        "type": "string",
        "default": "attached"
      },
      {
        "name": "ac_results",
        "description": "Per-acceptance-criterion checklist from review-issue's Agent 7 (Conformance) — criterion, verdict, file:line or reason. Used to populate the PR body's Acceptance Criteria section. Per-issue mode only.",
        "type": "string"
      },
      {
        "name": "batch_id",
        "description": "Batch id slug (e.g. b-2026-08-29-01). When set, run BATCH MODE: ship the batch PR from the batch branch against the batch ANCHOR issue (issue_number is the anchor number) — per-member PR sections, Closes #N per member, rebase-merge. Unset = ordinary per-issue ship.",
        "type": "string"
      },
      {
        "name": "members",
        "description": "Batch mode only: comma-separated member issue numbers (e.g. 101,102,104). Drives the PR body's per-member sections and the Closes #N list. Default: derived from the batch branch's per-issue commits.",
        "type": "string"
      },
      {
        "name": "member_verdicts",
        "description": "Batch mode only: per-member per-AC conformance verdicts from slot-cycles, passed through by review-issue's aggregate mode (Agent 7's format: 'ACn <criterion> — met <file:line> | not-met <why> | unverifiable <what test would prove it>'). Populates the PR body's per-member Acceptance Criteria checkboxes. Fallback when absent: the per-member verdict comment a prior aggregate review posted on the anchor.",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "last_updated": "2026-08-29",
  "checksum": {
    "algorithm": "sha256",
    "hash": "a6971650c42a5bebfe74226b0e24e08cf5db1b1ee5ce875a30b29b703e2c4b6a"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "1g01Z7whScjj/awQlkDhVZoEfrBlIALtlSdlCJ8CmbxYl2O38Ufaa4d1UHqN17My1EeC4lQ6wXrsEjbgfdPKBw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T19:30:17.036Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Ship Issue — Commit, PR, Merge, Teardown

## Objective

Ship the implementation: commit, push, create PR, wait for CI, merge, and clean up.

## Prerequisites

- All code changes are ready (implemented, tested, reviewed)
- review-issue found zero escalated findings — any escalation stops the run before this dossier (full-cycle-issue's Guiding Principle). This dossier does not create GitHub issues; it assumes the diff is ready to ship as-is. In batch mode: review-issue's AGGREGATE mode found zero escalated findings (the anchor's `batch-review` milestone carries `escalated=0`).
- You are in the worktree/working directory with uncommitted changes (per-issue) or on the clean batch branch (batch mode)
- GitHub CLI (gh) is installed and authenticated
- `ai-dossier` CLI >= 0.10.0 is installed — both ship milestones are posted through it (batch mode needs >= 0.14.0 for the `batch-ship` phase)
- You have push access

## Mode Selection

`batch_id` set → run **Batch Mode** below, then stop — the per-issue flow ("Actions to Perform") does not run. Unset → the ordinary per-issue flow.

## Batch Mode (Batch PR — rebase-merge) — RFC-0001 C.5

Ship the batch: ONE PR from the batch branch, per-member body sections, `Closes #N` per member, **rebase-merged** so each member's issue-boundary commit lands individually on the base branch (squash would collapse them and break eviction/bisect/traceability — RFC-0001 constraint 4). `issue_number` is the batch ANCHOR number; milestones post on the anchor. The scheduler dispatches this mode after `batch-review` posted `escalated=0`.

**The per-issue steps below are the semantic spec for the batch equivalents**: the CI-trigger gate (Step 2.5), phantom-green defense (Step 4), CI-failure handling (Step 5, max 2 attempts), merge confirmation (Step 6b), deploy-confirm (Step 6c), and teardown (Step 7) apply VERBATIM to the batch PR and batch worktree. Deviations are explicit here; everywhere else read the per-issue text with `<issue_number>` as "the members" and `<branch-name>` as "the batch branch".

### Batch Step 0: Assert the rebase-merge prerequisites (hard abort)

Batch PRs must rebase-merge. Assert, never assume — the external coordination item (repo settings + watcher support, imboard-ai/imboard-monorepo#3902) must be PRESENT, not presumed. Each failure posts `ai-dossier runstate post --issue <anchor_number> --phase batch-ship --status blocked --run <run_id> --kv batch=<batch_id> --kv reason=<slug>` plus ONE comment on the anchor naming the remediation, and STOPS — the batch waits intact on its branch; members' commits are untouched.

0. **Input shapes** (before any command interpolates them): `batch_id` matches `^[a-z0-9][a-z0-9._-]*$`; `members` (when provided) is comma-separated issue numbers. Violation: `reason=bad-inputs`.

1. **Repo allows rebase merging** (always asserted):
   ```bash
   gh api repos/{owner}/{repo} --jq .allow_rebase_merge
   ```
   Must be `true`. A failed or erroring `gh api` call is NOT a `false` — retry once; still erroring → `reason=assert-unavailable` (name gh/network as the problem — never send an operator chasing repo settings for a transient API failure). A confirmed `false` → `reason=rebase-not-allowed`; comment: enable Settings → Pull Requests → "Allow rebase merging" (external prerequisite, imboard-ai/imboard-monorepo#3902) — squash is not an acceptable fallback for a batch PR.

2. **The auto-merge watcher supports batch-epic rebase** (asserted when the TARGET repo has a watcher — a watcher without rebase support would SQUASH the batch PR on the `auto-merge` label, silently destroying per-issue attribution, the worst failure mode). The watcher runs from the BASE branch, so assert against the base branch's copy — never the batch branch's own copy, which the batch under review controls (self-attestation proves nothing):
   ```bash
   git fetch origin <base_branch>
   git cat-file -e "origin/<base_branch>:.github/workflows/auto-merge-watcher.yml" && echo watcher-present
   git show "origin/<base_branch>:scripts/auto-merge-watcher.sh" | grep -q 'batch-epic'
   git show "origin/<base_branch>:scripts/auto-merge-watcher.sh" | grep -q -- '--rebase'
   ```
   Each marker checked independently — both must succeed (a combined count cannot prove both are present; a watcher mentioning `batch-epic` in a comment while never calling `--rebase` is exactly the would-squash failure this gate exists to catch). Workflow file present but the script is missing at its canonical path or either marker is absent → `reason=watcher-no-rebase`; comment: update the watcher to rebase-merge `batch-epic`-labeled PRs (reference implementation: imboard-ai/imboard-monorepo#3902).
3. **Detached mode needs a watcher at all**: no `.github/workflows/auto-merge-watcher.yml` on the base branch AND `ship_mode=detached` → `reason=no-watcher` (nothing would ever merge the parked PR). Attached mode without a watcher self-merges with `--rebase` (Batch Step 6) — only assertion 1 applies there.

### Batch Step 1: Commit — nothing to commit

Every member landed its issue-boundary commit (slot-cycle contract) and aggregate review landed at most one clean batch-level fix commit; the tree is clean. Step 1's planning-doc removal and ci-parity run do NOT apply: the batch worktree carries no `PLANNING-*` files, and the full suite + ci-parity are batch-validate's job (the scheduler runs them on the combined diff before review) — ship does not repeat them. If `git status --porcelain` is NOT empty, something violated the contract: post `reason=dirty-worktree` and stop.

### Batch Step 2: Push

```bash
git push origin <batch-branch>
```

(Usually a no-op — members and review already pushed; this carries any straggler.)

### Batch Step 2.5: CI-Trigger Gate — VERBATIM

Same regex, same empty-commit remedy, same blocking `CI-TRIGGER-OK` requirement immediately before `gh pr create`. Slot-cycle commits carry no skip markers by contract and review's aggregate fix commit is clean by contract — a marker on the head means someone violated those contracts; the gate exists precisely so the violation cannot silently open a CI-less PR. The empty-commit remedy (`chore: enable CI for PR head`) is rebase-safe: a clean empty commit landing on the base branch is harmless.

### Batch Step 3: Create the Batch PR

Per-member material comes from the batch branch and `member_verdicts`:

```bash
git fetch origin <base_branch>
git log origin/<base_branch>..HEAD --format=%s | sed -n 's/^.* (#\([0-9][0-9]*\))$/\1/p'   # one (#N)-trailed member commit per line
```

The trailer anchor matters — a subject like "fix: crash from #99 (#101)" must yield 101, not 99. When BOTH the `members` input and this derivation exist and disagree → post `reason=members-mismatch` and stop (never silently prefer one); dedupe the list. Members empty after input + derivation → post `reason=no-members` and stop — never open a batch PR that closes nothing.

**Build the PR body with your file-write tool, never by interpolating network-derived text into a shell string** (member one-liners and AC criteria originate in issue bodies — untrusted; a substituted line reading exactly `EOF` would terminate a heredoc early and execute the rest as shell). Write it to a scratch file OUTSIDE the worktree (e.g. `$TMPDIR`), then:

```bash
gh label create batch-epic --color "5319E7" \
  --description "Batch cycle PR — watcher rebase-merges (keeps one commit per member issue)" --force
gh pr create --base <base_branch> --title "Batch <batch_id>: <N> issues" --body-file "$TMPDIR/batch-pr-body.md"
gh api -X POST repos/{owner}/{repo}/issues/<pr-number>/labels -f "labels[]=batch-epic"   # then CONFIRM the label is present
```

The body's shape — Summary, one section per member, Test plan:

```markdown
## Summary
Batch <batch_id> — <one-line batch summary>. Members: #<m1>, #<m2>, …

Rebase-merge: one commit per member issue lands on <base_branch> (eviction/bisect/traceability — RFC-0001 C.5).

## Members

### #<m1> — <one line from its boundary commit>
- [x] AC1 <criterion> — met <file:line>
- [ ] AC2 <criterion> — not met / unverifiable: <reason>
Closes #<m1>

### #<m2> — <one line from its boundary commit>
- [x] AC1 <criterion> — met <file:line>
Closes #<m2>

## Test plan
- batch-validate: full suite + ci-parity on the combined diff
- per-member: focused tests + changed-file lint + per-issue blind conformance (slot-cycles)
```

The per-member AC checkboxes come from `member_verdicts` (checked + `file:line` for `met`, unchecked with reason otherwise) — same mapping as per-issue Step 3; when the input is absent, fall back to the per-member verdict comment a prior aggregate review posted on the anchor. `Closes #N` per member (never the anchor — anchors are scheduler-owned and nothing in the batch flow may auto-close the anchor issue). Apply ONLY `batch-epic` at PR creation — the watcher's rebase trigger. **Do NOT apply `auto-merge` here**: it is the watcher's merge trigger and is applied only after Step 3a confirms CI actually ran (Batch Step 3c for detached, Batch Step 6 for attached-with-watcher; never on the attached-no-watcher self-merge path). Re-read the PR labels and confirm `batch-epic` is present before continuing — without it the watcher would squash-merge.

### Batch Step 3a: Confirm CI Actually Triggered — VERBATIM

Same proof (≥1 `pull_request`-triggered run for the head sha, or the repo provably has none). This is doubly load-bearing for a batch: the watcher's presence-of-checks floor refuses zero-check PRs, and the batch carries N issues per CI run.

### Batch Step 3b: Runstate Milestone (awaiting-merge) — on the ANCHOR

```bash
ai-dossier runstate post --issue <anchor_number> --phase batch-ship --status awaiting-merge --run <run_id> \
  --kv batch=<batch_id> \
  --kv pr=<pr-number> \
  --kv head=<short sha of the pushed commit> \
  --kv ci_fix_attempts=0 \
  --kv members=<comma list> \
  --kv strategy=rebase \
  --next batch-ship
```

`--next batch-ship` is the mid-phase override (same purpose as per-issue's `--next ship`): the milestone is mid-phase, so the next phase is still batch-ship. The CLI stamps `at=` itself.

### Batch Step 3c: ship_mode — attached or detached

**`attached` (default)** — continue to Batch Step 4 and drive the phase to its end (CI wait, merge, merge confirmation, deploy confirmation, teardown, final milestone). Without a watcher, self-merge with `--rebase` (Batch Step 6); with a watcher, hand the merge to it exactly as per-issue Step 3c/detached does.

**`detached`** — park the PR and stop. Preconditions: Batch Step 0 assertions passed (including the watcher, which detached requires) and Step 3a passed. Apply the `auto-merge` label via the REST-safe call (Step 3c item 1), CONFIRM it is present (retry once, then escalate as a hard blocker — never fall back to polling CI yourself), confirm `batch-epic` is still present, and print the handoff line and STOP:

```
Ship detached: batch PR #<pr-number> parked on auto-merge (rebase — batch-epic); run the batch tail (teardown + report) after merge.
```

Do NOT wait for CI, merge, tear down, or report. Leave the batch worktree in place. The watcher rebase-merges the `batch-epic` PR; the scheduler (or a tail run) resumes at teardown from the `awaiting-merge` milestone.

### Batch Step 4: Wait for CI — VERBATIM

Same stable-confirmation gate, same bounded poll batches, same same-turn discipline. One CI run now carries N issues — the phantom-green defense matters more, not less.

### Batch Step 5: Handle CI Failures — VERBATIM (max 2 attempts)

Same identify → fix → push → re-wait loop against the AGGREGATE. Failing-test-to-member attribution (revert, evict, force-push rebuild) is the scheduler's F.3 machinery, NOT this mode's — ship fixes the aggregate or, after 2 attempts, hands off (`decision-pending` on the anchor, same as per-issue Step 5 item 5).

### Batch Step 6: Merge — rebase, never squash

- **Repo with a watcher**: hand the merge to the watcher — apply and confirm the `auto-merge` label (Batch Step 3c), then poll `gh pr view <pr-number> --json mergedAt` as an armed watch (~3–5 min intervals, up to ~25 min). The watcher rebase-merges because the PR carries `batch-epic`. Do NOT self-merge while a watcher owns merges, and do NOT remove `batch-epic` — that would flip the watcher to squash. Past ~25 min unmerged: inspect the watcher (`gh run list --workflow auto-merge-watcher.yml --limit 3`) — watcher run FAILED → post `phase=batch-ship status=blocked reason=watcher-failed` with the run URL and stop (never self-merge over a watcher that owns merges — it may still fire); runs green but no merge → re-verify both labels are present, poll ONE more window, then post `blocked reason=watcher-merge-timeout` and hand off.
- **Attached, no watcher**: after the Step 4 gate passes,
  ```bash
  gh pr merge <pr-number> --rebase
  ```
  Never `--squash` for a batch PR, and no `--delete-branch` (worktrees; cleanup is Batch Step 7). There is no `--subject`/`--body` to pass — a rebase merge replays the members' own commit messages, which is the point.

### Batch Step 6b: Confirm the Merge — VERBATIM

`gh pr view <pr-number> --json mergedAt,state` — `mergedAt` non-null, `state` `MERGED`, before anything else.

### Batch Step 6c: MERGE_COMMIT and deploy-confirm under rebase-merge

**N commits land, not one.** A rebase merge replays every batch-branch commit onto the base branch as a linear range — each member's `(#N)`-trailed commit lands individually (individually revertable — the traceability the strategy exists for), and the commits get NEW shas on the base branch (rebase replays; member shas recorded in slot milestones are branch shas, not main shas — traceability on the base branch is the `(#N)` trailers, never the shas).

- **`MERGE_COMMIT` = the merge head**: `gh pr view <pr-number> --json mergeCommit --jq '.mergeCommit.oid'` — the LAST commit of the replayed range on the base branch. Do not assume a single squash sha (report-issue 1.7.1's batch variant already expects this: "record the batch PR's merge head SHA").
- **Deploy-confirm uses the branch-head containment check, unchanged**: `git fetch origin --quiet && git merge-base --is-ancestor <MERGE_COMMIT> <deployed_sha>` — the merge head CONTAINS every member commit (the range is linear), so any deploy carrying the merge head ships the entire batch. Find the deploy mechanism, check whether a deploy already carries the merge, dispatch it yourself if nothing does within ~5 minutes, escalate a failed deploy — all VERBATIM from per-issue Step 6c. Where a bot token merges, `on: push` does not fire and the deploy NEVER runs by itself — the batch makes this worse (N issues live to nobody), so the dispatch is not optional.

### Batch Step 7: Teardown — the batch worktree

Same order and verification discipline as per-issue Step 7, scoped to the batch:

1. `scripts/ensure-test-env.sh --teardown` if the repo has it (batch test resources leak the same way).
2. `cd` back to `original_dir` (if provided).
3. Pool return if `pool_claimed` (setup's batch mode claims with the anchor issue) — `npx -y @ai-dossier/worktree-pool@^0.5.1 return --path <worktree_path>`; verify with pool `status` AND `git worktree list` before claiming `cleanup=pool_returned`.
4. Else remove the worktree and delete the batch branch (local + remote). Deleting the branch after a rebase merge is safe — every commit was replayed onto the base branch; the replayed range is the durable artifact.
5. Remove the `in-progress`-style labels only per the anchor's flow (the scheduler/report owns anchor closure).

### Batch Step 8: Final Runstate Milestone — on the ANCHOR

```bash
ai-dossier runstate post --issue <anchor_number> --phase batch-ship --status done --run <run_id> \
  --kv batch=<batch_id> \
  --kv pr=<pr-number> \
  --kv merge_commit=<short sha of the merge head> \
  --kv ci_fix_attempts=<n> \
  --kv deploy=<confirmed-sha|n/a|blocked-<reason>> \
  --kv cleanup=pool_returned|worktree_removed|skipped \
  --kv test_env=torn-down|none \
  --kv members=<comma list> \
  --kv strategy=rebase
```

The CLI computes `next=batch-report` — report-issue's batch variant continues from this milestone (it reads the trail for traps evidence and takes the merge head from the PR itself). `merge_commit=` empty is the same failure it is per-issue: a batch report over an unmerged PR is a failed run, never a clean one.

## Actions to Perform

*The per-issue flow — skip entirely when `batch_id` is set (Batch Mode above).*

### Step 1: Commit

**PR-head skip-marker guard.** By protocol the tree may already be clean (all work landed as `wip … [skip ci]` commits). GitHub evaluates CI skip markers **per commit, against the head commit only** — if the branch head carries one, the whole `pull_request` event is suppressed and the PR opens with ZERO `pull_request`-triggered runs. It fails silently: no red check, no failed run, nothing for an auto-merge watcher that only looks for failures to catch, so the PR merges untested. This has shipped CI-less merges more than once. So: if the tree is clean, or the commit you are about to make would carry a skip marker, make the final commit empty instead — `git commit --allow-empty -m "<type>: <summary>"` — and never put a skip marker in ship's own commit message. Step 2.5 re-checks this as a blocking gate; do not rely on remembering it here.

**Remove the planning doc before committing**: `git rm -f PLANNING-<issue_number>-*.md` — planning files never land on the base branch (they are already preserved in the branch history and the issue trail).

0. **If `scripts/ci-parity.sh` exists in the repo, run `bash scripts/ci-parity.sh` before committing.** It is the project's own definition of what CI enforces. Fix and re-run until it passes. If the script does not exist, skip this and commit as usual.
1. Stage relevant files (never `.env`, credentials, secrets)
2. Commit with conventional commits format:
   ```
   feat|fix|chore: <description>

   Closes #<issue_number>

   Co-Authored-By: Claude <noreply@anthropic.com>
   ```

   This lands on top of the earlier phases' `wip(...)` commits (WIP sync rule); Step 6's squash-merge collapses the whole branch history into one commit on the base branch.

### Step 2: Push

```bash
git push -u origin <branch-name>
```

### Step 2.5: CI-Trigger Gate (BLOCKING — nothing goes between this and `gh pr create`)

The branch head at the moment the PR is created decides whether CI runs at all. Every phase before ship pushes `wip(<phase>): … [skip ci]` commits (WIP Sync Rule) — correct while the run is in flight, fatal if one is still the head when the PR opens. Run this last, after the push, immediately before Step 3:

```bash
SKIP_RE='\[(skip[ -]ci|ci[ -]skip|no[ -]ci|skip[ -]actions|actions[ -]skip)\]|skip-checks: *true'
if git log -1 --format=%B | grep -Eqi "$SKIP_RE"; then
  git commit --allow-empty -m "chore: enable CI for PR head" && git push
fi
git log -1 --format=%B | grep -Eqi "$SKIP_RE" && echo "CI-TRIGGER-BLOCKED" || echo "CI-TRIGGER-OK"
```

**Do NOT run `gh pr create` until that last line prints `CI-TRIGGER-OK`.** `CI-TRIGGER-BLOCKED` means the empty commit did not land (a commit hook rejected it, detached HEAD, wrong directory) — diagnose and fix it; never proceed anyway, and never resolve it by re-adding a skip marker to the new commit.

Two rules on the remedy:

- **Empty commit on top, never `git commit --amend`.** Amending rewrites the head sha, and the `head=` shas recorded in earlier phases' runstate milestones stop being ancestors of the branch — which breaks gate-issue's remote check (`git merge-base --is-ancestor <head> FETCH_HEAD`) on any later resume. Appending is free and keeps the ancestry intact.
- **This gate applies on every entry into Step 3**, including a resumed run that skipped Steps 1–2 because the branch was already pushed. That resume path is exactly how a `wip(review): … [skip ci]` commit reaches a PR head.

### Step 3: Create PR

Create the PR targeting `base_branch`:

```bash
gh pr create --base <base_branch> --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

Closes #<issue_number>

## Acceptance Criteria
- [x] AC1 <criterion> — <file:line>
- [ ] AC2 <criterion> — not met / unverifiable: <reason>

## Test plan
- <how to verify>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

The Acceptance Criteria boxes come from `ac_results` (review-issue's Agent 7 output, passed through by full-cycle-issue): a checked box with `file:line` for each `met` AC, an unchecked box with the reason for `not-met`/`unverifiable`. If `ac_results` is empty (Agent 7 was skipped — no AC list existed), omit this section.

### Step 3a: Confirm CI Actually Triggered

Step 2.5 is the prevention; this is the proof. Run it right after the PR exists, before anything else:

```bash
HEAD_SHA=$(gh pr view <pr-number> --json headRefOid -q .headRefOid)
sleep 45
gh api "repos/{owner}/{repo}/actions/runs?head_sha=$HEAD_SHA" \
  --jq '[.workflow_runs[] | select(.event=="pull_request")] | length'
```

Expect **>= 1**. A `0` is only acceptable if the repo has no `pull_request`-triggered workflow at all — prove that with `grep -rl "pull_request" .github/workflows` returning nothing before accepting it. Otherwise: `git commit --allow-empty -m "chore: enable CI for PR head" && git push`, wait, and re-check (once; if it is still 0, escalate as a hard blocker).

Do not post the `awaiting-merge` milestone, apply the `auto-merge` label, or hand off in `detached` mode until this passes. Detached mode never reaches the Step 5 CI wait, so this is the only point in the run where a CI-less PR can still be caught.

### Step 3b: Runstate Milestone (awaiting-merge)

Post this BEFORE the CI wait — it is what tells a later reader that a PR exists and the run is parked on CI, even if this session dies mid-wait. Comments are append-only: never edit or delete a prior milestone.

```bash
ai-dossier runstate post --issue <issue_number> --phase ship --status awaiting-merge --run <run_id> \
  --kv pr=<pr-number> \
  --kv head=<short sha of the pushed commit> \
  --kv ci_fix_attempts=0 \
  --next ship
```

The CLI stamps `at=` itself; never hand-write the comment. `--next ship` is the one place a dossier overrides the computed `next=` — this milestone is mid-phase, so the next phase is still ship.

In `ship_mode=detached` this is the run's LAST milestone (Step 3c) — it is what a later gate reads to resume at `ship-teardown`.

### Step 3c: Ship Mode — attached or detached

`ship_mode` decides whether this run drives the merge or hands it off.

**`attached` (default)** — continue to Step 4 and run the phase to its end: CI wait, merge, merge confirmation, deploy confirmation, teardown, final milestone. Nothing below changes.

**`detached`** — park the PR and end the run here. Precondition: Step 3a passed. Handing a PR with zero `pull_request` runs to the watcher is how a change reaches the base branch with no CI at all — do not apply `auto-merge` until Step 3a is satisfied.

1. Hand the merge to the watcher / merge queue via REST — on repos with Projects-classic, `gh pr edit --add-label` fails on a GraphQL deprecation: `gh api -X POST repos/{owner}/{repo}/issues/<pr-number>/labels -f "labels[]=auto-merge"` (create the label first if missing: `gh label create auto-merge --color 0E8A16 --force`). Then CONFIRM the label is present in the response. On a repo with a merge queue, enqueue instead. Same deprecation hits `gh pr view`/`gh issue view` without field selection — always pass `--json <fields>`.
2. **Confirm the label is applied** — re-read the PR labels. If the apply failed, retry once; if it still fails, that is a hard blocker to escalate (do NOT fall back to waiting on CI yourself).
3. The Step 3b `awaiting-merge` milestone is already posted — that is the durable state.
4. Print the handoff line and STOP:

   ```
   Ship detached: PR #<pr-number> parked on auto-merge; run `full cycle issue <issue_number>` after merge to finish (resumes at ship-teardown), or let the fleet supervisor do it.
   ```

Do NOT wait for CI, do NOT merge, do NOT tear down, do NOT run report. **Leave the worktree in place** — the work is already pushed (WIP sync rule), and the tail run reuses or re-materializes it.

gate-issue maps a merged PR on this milestone to `resume_from=ship-teardown` (still-open → `ship-wait`), so the tail run re-enters at Step 6b/Step 7 and finishes with the final milestone and the report.

Steps 4 through 8 below are the **attached** path (and the tail run's path on resume).

### Step 4: Wait for CI — stable-confirmation gate (stay in this turn)

**You MUST stay in THIS turn until the gate passes — do NOT background the wait.** No
`Monitor`, no `run_in_background` poll, no "I'll be notified when CI finishes," no ending
your turn while checks are still pending. CI here takes ~18–20 minutes; you wait by re-running
a short foreground poll **batch** yourself, back-to-back, until it reports green or failing.
A backgrounded or deferred wait is the #1 cause of a PR that goes green but **never merges**
because the turn ended before Step 6 — do not do it: the Bash tool caps a call at a few minutes and blocks open-ended foreground `sleep`, so "keep waiting" must be an explicit **same-turn re-run** of a short bounded batch.

**Do NOT merge until checks are CONFIRMED green, and guard against false positives.** The
check-runs API (and `gh pr checks --watch`) intermittently report a phantom `success` for a
job still running, and can show all-pass before a slow required job has registered. Treat one
green read as **unconfirmed**.

Merge gate — two conditions, **both confirmed on two consecutive reads ≥20s apart**: (1) `mergeStateStatus` is `CLEAN` (`gh pr view <pr-number> --json mergeStateStatus`); (2) `gh pr checks <pr-number>` shows **zero** `pending` and **zero** `fail`/`cancel`.

Run this **bounded poll batch** — up to 6 reads (~2.5 min), then it EXITS with a `RESULT=` line. It persists the consecutive-clean counter to a file so two-in-a-row survives across re-runs, and reads `bucket` from `--json`, so a skipped job never blocks and an unreported-checks window never false-greens:

```bash
SF=/tmp/ship-stable-<pr-number>; stable=$(cat "$SF" 2>/dev/null || echo 0); i=0
while [ "$i" -lt 6 ]; do
  i=$((i + 1))
  mss=$(gh pr view <pr-number> --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null)
  checks=$(gh pr checks <pr-number> --json bucket 2>/dev/null)
  if [ -z "$checks" ]; then pend=1; fail=0; else      # no checks reported yet => not ready
    pend=$(printf '%s' "$checks" | jq '[.[]|select(.bucket=="pending")]|length')
    fail=$(printf '%s' "$checks" | jq '[.[]|select(.bucket=="fail" or .bucket=="cancel")]|length')
  fi
  echo "read $i/6: mss=$mss pending=$pend failing=$fail stable=$stable"
  if [ "$fail" -gt 0 ]; then echo 0 >"$SF"; echo "RESULT=failing"; exit 0; fi
  if [ "$mss" = "CLEAN" ] && [ "$pend" -eq 0 ]; then stable=$((stable + 1)); else stable=0; fi
  if [ "$stable" -ge 2 ]; then echo 0 >"$SF"; echo "RESULT=green"; exit 0; fi
  [ "$i" -lt 6 ] && sleep 25
done
echo "$stable" >"$SF"; echo "RESULT=pending stable=$stable"
```

Set the Bash tool `timeout` to `200000` (200s) so the batch isn't cut off mid-poll. Then:

- `RESULT=green` ⇒ two consecutive confirmed-clean reads. Go to **Step 6 now, in this same turn**.
- `RESULT=failing` ⇒ **Step 5**.
- `RESULT=pending` ⇒ **immediately run the batch again. Do NOT yield, do NOT background, do
  NOT end your turn.** Keep re-running back-to-back until it returns green or failing (~8–10
  batches covers a ~20-min CI; do NOT stop polling at the 12-min mark). Each re-run resumes
  the counter from the file.
- `mergeStateStatus` values other than `CLEAN` (`UNSTABLE`, `BLOCKED`, `BEHIND`, `UNKNOWN`)
  reset the counter inside the batch — `UNSTABLE`/`UNKNOWN` usually just means not every check
  has reported yet; keep re-running, do not treat it as a failure on its own.

**Known transient false-blocks (re-run once, don't escalate):** a required check failing with a known-flaky/environmental signature *unrelated to the diff* — a codegen race (e.g. a docs/`.source` "not a module" / missing-property typecheck on a PR touching no docs), or a freshly-published dependency advisory the PR never introduced (OSV-Scanner on a transitive dep). Run `gh run rerun <run-id> --failed` once before treating it as a real Step-6 failure. If the advisory is genuinely on `main` too, the fix is a separate dependency-bump PR, not this one.

### Step 5: Handle CI Failures (max 2 attempts)

1. Identify the failed job: `gh pr checks <pr-number>`; view its logs: `gh run view <run-id> --log-failed`
2. Read the failure output, find the root cause, fix the code, and run the failing command locally to confirm the fix
3. Commit and push:
   ```bash
   git add <files> && git commit -m "fix: CI failure — <what was wrong>

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```
4. Wait for CI again (go back to Step 4)
5. If CI fails after 2 fix attempts: do not merge a red build. Stop and hand off —
   apply the `decision-pending` label (`gh label create decision-pending --color 5319E7
   --description "Blocked on a human decision" --force`), remove `in-progress`, and
   comment on the ORIGINAL issue with the failing job, the root cause you found, what
   you tried, and why it's still red. Do not open a new issue. End the run here.

### Step 6: Merge

**Only after the Step 4 gate exited with `stable=2`.** Re-confirm with one final read
immediately before merging — `gh pr view <pr-number> --json mergeStateStatus` must still
be `CLEAN`. If it regressed to `UNSTABLE`/`BLOCKED` (a check re-queued or a new push
landed), return to Step 4; never merge on a stale green.

All checks confirmed green — merge, then clean up issue labels:

```bash
gh pr merge <pr-number> --squash --subject "<conventional PR title> (#<pr-number>)" --body "Closes #<issue_number>"
gh issue edit <issue_number> --remove-label "in-progress"
```

Always pass an explicit `--subject`/`--body`: the default squash body concatenates the wip commit messages, and a leaked `[skip ci]` in the merge commit silently suppresses EVERY push-triggered workflow on the base branch (publishes, deploys) — this stalled two npm releases. Do NOT use `--delete-branch` — it fails from worktrees. Branch cleanup happens in Step 7.

### Step 6b: Confirm the merge before doing ANYTHING else

**This is a hard gate — do not skip it.** Immediately after Step 6, run:

```bash
gh pr view <pr-number> --json mergedAt,state
```

`mergedAt` MUST be non-null **and** `state` MUST be `MERGED`. If it is not, **you are not
done** — the merge did not happen; return to Step 4 / Step 6 and drive it to a real merge.
Never emit an idle notification, end your turn, or proceed to Teardown (Step 7) or Report
(Phase 6) with an unmerged PR. "PR opened and checks passing" is **not** a completed run. A confirmed merge is **necessary but NOT sufficient** — it puts code on the default branch, not in front of users. Continue to Step 6c; do not treat this gate as the finish line.

### Step 6c: Confirm the merge REACHED PRODUCTION

**A merge is not a release.** Step 6b proves the code is on the default branch, NOT that a single user can see it. Where merges are performed by a bot token, GitHub does NOT fire `on: push`, so the deploy never runs and merged code sits until an unrelated human push carries it out (imboard#2714). **Skip this step and the workflow's success token is a lie.**

1. **Find the project's deploy mechanism.** Do not assume it exists or is automatic: look for a deploy workflow (`gh workflow list`), a `deploy`/`release` script, or a documented runbook. If the project has NO deploy step (a library, a docs site auto-built on push, an app deployed by an external system you cannot observe), record `DEPLOYED=N/A — <reason>` and move on — a legitimate outcome; silence is not.

2. **Check whether a deploy already carries your merge** — a successful deploy run whose commit CONTAINS `MERGE_COMMIT` (it need not equal it; a later deploy carrying your commit still ships it):

   ```bash
   # newest successful deploy runs, with the SHA each one shipped
   gh run list --workflow <deploy-workflow> --limit 5 \
     --json headSha,status,conclusion,createdAt \
     --jq '.[] | select(.conclusion=="success") | .createdAt + " " + .headSha'
   # is your merge contained in what shipped?
   git fetch origin --quiet
   git merge-base --is-ancestor <MERGE_COMMIT> <deployed_sha> && echo SHIPPED || echo NOT-SHIPPED
   ```

3. **If nothing ships it within ~5 minutes, dispatch the deploy yourself**, then confirm it succeeded:

   ```bash
   gh workflow run <deploy-workflow> [-f environment=production]   # inputs vary — read the workflow
   ```

4. **A failed deploy is a hard blocker.** Escalate on the issue (comment + remove `in-progress`) with the run URL. Do NOT report the run as complete. Do NOT retry blindly more than once — a red deploy on the default branch may be affecting live users and is a human's call.

5. **Record `DEPLOYED`** — shipped SHA + run URL — and pass it to Phase 6.

**Only now is the work shipped.**

**Deploy exists but you cannot trigger it** (permission/classifier-blocked dispatch): this is NOT a blocker and NOT a failed deploy — post ship `done` with `--kv deploy=blocked-<short-reason>`, and the report's Shipped line must read `NOT DEPLOYED — <the exact command a human must run>`.

### Step 7: Teardown

**Prerequisite: Step 6b (merge confirmed) AND Step 6c (deploy confirmed or `N/A`) must be complete.** Do not tear down before the merge is confirmed.

**Step 7.0 — release per-worktree test resources first.** If the repo has `scripts/ensure-test-env.sh` (or `main/scripts/ensure-test-env.sh`), run `bash scripts/ensure-test-env.sh --teardown` from the worktree BEFORE removing it. This drops the worktree's isolated test database and S3 prefix; skipping it leaks one database per run, and a shared-tier Atlas cluster caps at 500 collections cluster-wide — once full, every integration test fails with `cannot create a new collection -- already using 500 collections of 500`. Record `test_env=torn-down|none` in the final ship milestone.

**Verify cleanup before claiming it.** `cleanup=pool_returned` may only be posted after confirming it: `npx -y @ai-dossier/worktree-pool@^0.5.1 status` no longer lists the entry as assigned AND `git worktree list` no longer contains the path. If the return errored or the state is inconsistent, post `cleanup=failed-<step>` instead — a milestone claiming completion is not proof of completion (imboard#3692, ai-dossier#453).

1. `cd` back to `original_dir` (if provided).
2. **Try to return the worktree to the pool** (if `pool_claimed` is true) — on success the worktree is recycled, skip steps 3-5; on failure continue with manual cleanup:
   ```bash
   npx -y @ai-dossier/worktree-pool@^0.5.1 return --path <worktree_path> 2>/dev/null
   ```
3. Remove the worktree and clean up the branches (deleting the remote branch also drops the run's WIP history — intended; the squash-merge commit on the base branch is the durable artifact):
   ```bash
   git worktree remove <worktree_path>
   git branch -d <branch-name> 2>/dev/null || git branch -D <branch-name>
   git push origin --delete <branch-name> 2>/dev/null || true
   ```

### Step 8: Runstate Milestone (final)

Post the second and final ship milestone, after merge and teardown. (Not reached in `ship_mode=detached` — the tail run posts it.) This is the last step of the phase — if ship aborts (CI red after 2 attempts, merge conflict, failed deploy), post `--status blocked --kv reason=<short-slug>` instead and stop. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
ai-dossier runstate post --issue <issue_number> --phase ship --status done --run <run_id> \
  --kv pr=<pr-number> \
  --kv merge_commit=<short sha from Step 6b> \
  --kv ci_fix_attempts=<n> \
  --kv deploy=<confirmed-sha|n/a|blocked-<reason>> \
  --kv cleanup=pool_returned|worktree_removed|skipped \
  --kv test_env=torn-down|none
```

Let the CLI stamp `at=` and compute `next=report` — do not pass either; never hand-write the comment. `ci_fix_attempts` is how many Step 5 fix-and-push cycles ran (0 if CI was green first time).

## Output

- `pr_number`: the created PR number
- `pr_url`: the PR URL
- `ship_mode`: attached | detached — which path ran
- `merge_status`: merged | failed | parked (detached: PR open on auto-merge, no merge attempted)
- `target_branch`: the branch merged into
- `cleanup`: pool_returned | worktree_removed | skipped
- `ci_fix_attempts`: number of CI fix-and-push cycles run in Step 5
- Batch mode: `merge_commit` = the rebase merge head (N member commits landed individually), `members`, `strategy=rebase`
- Posts TWO runstate milestones to the issue (`phase=ship`: `awaiting-merge` before the CI wait, then `done`) — in `detached` mode only the first, and the tail run posts the second. Batch mode posts `phase=batch-ship` milestones on the ANCHOR with the same two-step shape.

## Validation

- [ ] Changes committed with conventional commits format; branch pushed to remote
- [ ] Step 2.5 CI-trigger gate printed `CI-TRIGGER-OK` immediately before `gh pr create` — the PR head commit carries no skip marker, and no `git commit --amend` was used to get there
- [ ] Step 3a confirmed >= 1 `pull_request`-triggered workflow run exists for the PR head sha (or the repo provably has no `pull_request` workflow) — checked BEFORE the `auto-merge` label / `awaiting-merge` milestone / detached handoff
- [ ] PR created targeting correct base_branch
- [ ] PR body includes the Acceptance Criteria section from `ac_results` (when non-empty)
- [ ] `ship_mode` was honored: `detached` stopped after the label + `awaiting-merge` milestone with the handoff line printed (no CI wait, no merge, no teardown, no report); `attached` ran through to the final milestone
- [ ] Detached only: the `auto-merge` label was applied and confirmed present, and the worktree was left in place
- [ ] CI passed (or failures fixed within 2 attempts), confirmed green on two consecutive stable polls — not a single transient success
- [ ] CI wait done in-turn (foreground batch re-runs) — never backgrounded or deferred
- [ ] PR merged (squash)
- [ ] Merge confirmed: `gh pr view` shows `mergedAt` non-null and `state` `MERGED` (Step 6b)
- [ ] Deploy confirmed: a successful deploy run CONTAINS `MERGE_COMMIT`, or `DEPLOYED=N/A` with a reason (Step 6c) — merged is not shipped
- [ ] in-progress label removed
- [ ] Worktree returned to pool or removed; returned to original directory
- [ ] `scripts/ci-parity.sh` was run before committing when present
- [ ] Runstate milestones were posted via `ai-dossier runstate post` (`awaiting-merge` before the CI wait — with `--next ship` — and, on the attached/tail path, the final one after teardown)
- Batch mode: rebase prerequisites asserted BEFORE the PR (repo `allow_rebase_merge`, watcher batch-epic rebase support when a watcher exists, watcher presence for detached) — each failure posted `phase=batch-ship status=blocked reason=rebase-not-allowed|watcher-no-rebase|no-watcher` and stopped; PR body has one section per member with its AC checkboxes (from `member_verdicts`) and `Closes #N` per member (never the anchor); `batch-epic` applied and confirmed at PR creation (`auto-merge` applied and confirmed only when parking on or handing the merge to the watcher — never on the attached-no-watcher self-merge path); merged with `--rebase` (never `--squash`); `MERGE_COMMIT` = the merge head, deploy confirmed via the unchanged containment check; teardown returned/removed the BATCH worktree and deleted the batch branch; both milestones posted on the ANCHOR (`batch-ship` awaiting-merge with `--next batch-ship`, then done with `batch=` `pr=` `merge_commit=` `deploy=` `cleanup=` `test_env=` `members=` `strategy=rebase`)

## Troubleshooting

| Symptom | Fix |
|---|---|
| CI fails after fixes | See Step 5 item 5 — after 2 attempts, stop and hand off on the issue (`decision-pending` label + comment). Do not open a new issue. May be an infrastructure issue rather than a code issue — say so in the comment. |
| Phantom success / flaky check status | Never merge on one read — require two consecutive `CLEAN` + zero-pending reads (Step 4). |
| Merge stall / "I'll be notified when CI is done" | Backgrounding the CI wait is this phase's most common failure — the PR goes green but never merges. Never do that; Step 4 is a foreground, same-turn loop. |
| Merge conflicts | Needs human judgment. Stop and hand off on the issue (`decision-pending` label + comment describing the conflicting files and why an automatic resolution isn't safe) — do not guess at a resolution, do not open a new issue. |
| Detached run looks unfinished | It is — by design. A `ship awaiting-merge` milestone with no `ship done` after it is a parked PR, not a failure. The tail run (`full cycle issue <n>`) resumes at `ship-teardown` once the PR merges. |
| `--delete-branch` fails in worktree | Expected — don't use it. Clean up in Step 7. |
| Pool return fails | Not an error — fall back to manual worktree remove. |
| Batch: `reason=rebase-not-allowed` / `watcher-no-rebase` / `no-watcher` | Hard aborts by design — the external prerequisites (imboard-ai/imboard-monorepo#3902) are absent. Fix the repo settings / watcher on the TARGET repo, then re-dispatch; never fall back to squash. |
| Batch: watcher squashed the PR anyway | The `batch-epic` label was missing at merge time (or the watcher predates #3902). Not recoverable post-merge — the per-issue commits are collapsed on the base branch; surface it on the anchor immediately (this is what Batch Step 0 exists to prevent). |
| Batch: `merge_commit` looks like a member commit's sha | Correct — the rebase merge head IS the last replayed commit. It contains every member commit (linear range); the containment check works unchanged. |
| Batch: PR body missing a member section | Derivation from the batch log missed an issue — fall back to the `members` input; never ship a PR whose `Closes #N` list disagrees with the members list. |
