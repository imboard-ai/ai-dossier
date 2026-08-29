---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "ship-issue",
  "title": "Ship Issue — Commit, PR, Merge, Deploy, Teardown",
  "version": "1.11.1",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Commit changes, push, create a PR, then either drive it to a confirmed merge and deploy (attached) or park it on auto-merge and stop (detached)",
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
    "Creates and merges pull request",
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
        "description": "Runstate run id minted by gate-issue; pass through unchanged",
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
        "description": "Per-acceptance-criterion checklist from review-issue's Agent 7 (Conformance) — criterion, verdict, file:line or reason. Used to populate the PR body's Acceptance Criteria section.",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "last_updated": "2026-08-26",
  "checksum": {
    "algorithm": "sha256",
    "hash": "dd1689ca0ff2980c1249287e88ef99fc91c9e074a02862a7625260bfceafdd8f"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "4EpRzoQZ5lkkD847/XHNrsJ/cN+xo1eCCQnA22l9Xs+DMwEq0BYRUWTDkviNkisMphZkd6VaRJ998vNh1ZoyDA==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-26T10:41:16.356Z",
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
- review-issue found zero escalated findings — any escalation stops the run before this dossier (full-cycle-issue's Guiding Principle). This dossier does not create GitHub issues; it assumes the diff is ready to ship as-is.
- You are in the worktree/working directory with uncommitted changes
- GitHub CLI (gh) is installed and authenticated
- `ai-dossier` CLI >= 0.10.0 is installed — both ship milestones are posted through it
- You have push access

## Actions to Perform

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
- Posts TWO runstate milestones to the issue (`phase=ship`: `awaiting-merge` before the CI wait, then `done`) — in `detached` mode only the first, and the tail run posts the second

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| CI fails after fixes | See Step 5 item 7 — after 2 attempts, stop and hand off on the issue (`decision-pending` label + comment). Do not open a new issue. May be an infrastructure issue rather than a code issue — say so in the comment. |
| Phantom success / flaky check status | Never merge on one read — require two consecutive `CLEAN` + zero-pending reads (Step 4). |
| Merge stall / "I'll be notified when CI is done" | Backgrounding the CI wait is this phase's most common failure — the PR goes green but never merges. Never do that; Step 4 is a foreground, same-turn loop. |
| Merge conflicts | Needs human judgment. Stop and hand off on the issue (`decision-pending` label + comment describing the conflicting files and why an automatic resolution isn't safe) — do not guess at a resolution, do not open a new issue. |
| Detached run looks unfinished | It is — by design. A `ship awaiting-merge` milestone with no `ship done` after it is a parked PR, not a failure. The tail run (`full cycle issue <n>`) resumes at `ship-teardown` once the PR merges. |
| `--delete-branch` fails in worktree | Expected — don't use it. Clean up in Step 7. |
| Pool return fails | Not an error — fall back to manual worktree remove. |
