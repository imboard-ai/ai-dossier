---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "ship-issue",
  "title": "Ship Issue — Commit, PR, Merge, Deploy, Teardown",
  "version": "1.5.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Commit changes, push, create a PR, wait for CI, merge, confirm the merge reached production, and clean up the worktree",
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
    "hash": "19710492a8f1781a02af6f6ec7f5e71da3aa69bcb2a6df80b870ce201285e549"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "+gGZ3r4M0C2cIEx7Tj3qOISPh9IT4OFSdxFbFX3EVCt2+BLKQWXl/2gMU1+5WQ/Kq9echASl+pZ76PHUpCljCA==",
    "public_key": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAT5MH6NyHt3zBur6eq+EVSNOA2AZbuSRpov+/BRFzLnY=\n-----END PUBLIC KEY-----\n",
    "signed_at": "2026-08-05T11:04:47.017Z",
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
- review-issue found zero escalated findings. If it found any, the full-cycle
  orchestrator should already have stopped before invoking this dossier — see
  full-cycle-issue's Guiding Principle. This dossier does not create GitHub
  issues; it assumes the diff is ready to ship as-is.
- You are in the worktree/working directory with uncommitted changes
- GitHub CLI (gh) is installed and authenticated
- You have push access

## Actions to Perform

### Step 1: Commit

1. Stage relevant files (never `.env`, credentials, secrets)
2. Commit with conventional commits format:
   ```
   feat|fix|chore: <description>

   Closes #<issue_number>

   Co-Authored-By: Claude <noreply@anthropic.com>
   ```

### Step 2: Push

```bash
git push -u origin <branch-name>
```

### Step 3: Create PR

Create the PR targeting `base_branch`:

```bash
gh pr create --base <base_branch> --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

Closes #<issue_number>

## Test plan
- <how to verify>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Step 4: Wait for CI — stable-confirmation gate (stay in this turn)

**You MUST stay in THIS turn until the gate passes — do NOT background the wait.** No
`Monitor`, no `run_in_background` poll, no "I'll be notified when CI finishes," no ending
your turn while checks are still pending. CI here takes ~18–20 minutes (the backend `Tests`
integration job runs on Blacksmith); you wait by re-running
a short foreground poll **batch** yourself, back-to-back, until it reports green or failing.
A backgrounded or deferred wait is the #1 cause of a PR that goes green but **never merges**
because the turn ended before Step 6 — do not do it. (Why a batch and not one long loop: the
Bash tool caps a single call at a few minutes and blocks open-ended foreground `sleep`, so a
single ~20-minute poll loop cannot complete in one call — it gets killed mid-wait. The fix is
to make "keep waiting" an explicit **same-turn re-run** of a short bounded batch.)

**Do NOT merge until checks are CONFIRMED green, and guard against false positives.**
The GitHub check-runs API (and `gh pr checks --watch`) intermittently report a phantom
`completed`/`success` for a job that is still running, and can momentarily show all-pass
*before* a slow required job (e.g. the backend integration suite) has even registered.
Merging on a single transient read ships an unverified build. This has bitten real runs —
treat one green read as **unconfirmed**.

The merge gate has two conditions, **both confirmed on two consecutive reads ≥20s apart**:

1. `mergeStateStatus` is `CLEAN` (via `gh pr view <pr-number> --json mergeStateStatus`).
2. `gh pr checks <pr-number>` shows **zero** checks `pending` and **zero** `fail`/`cancel`.

Run this **bounded poll batch**. It does up to 6 reads (~2.5 min) then EXITS with a
`RESULT=` line — short enough to finish inside the Bash tool timeout. It persists the
consecutive-clean counter to a file so two-in-a-row survives across batch re-runs, and reads
`bucket` from `--json` (machine-readable; `skipping` is correctly ignored, so a skipped job
never blocks and an unreported-checks window never false-greens):

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

When you run it, set the Bash tool `timeout` to `200000` (200s) so the batch isn't cut off
mid-poll. Then act on the `RESULT` line:

- `RESULT=green` ⇒ two consecutive confirmed-clean reads. Go to **Step 6 now, in this same
  turn**.
- `RESULT=failing` ⇒ go to **Step 5**.
- `RESULT=pending` ⇒ **immediately run the batch again. Do NOT yield, do NOT background, do
  NOT end your turn.** Keep re-running back-to-back until it returns green or failing (~8–10
  batches covers a ~20-min CI; do NOT stop polling at the 12-min mark). Each re-run resumes
  the counter from the file.
- `mergeStateStatus` values other than `CLEAN` (`UNSTABLE`, `BLOCKED`, `BEHIND`, `UNKNOWN`)
  reset the counter inside the batch — `UNSTABLE`/`UNKNOWN` usually just means not every check
  has reported yet; keep re-running, do not treat it as a failure on its own.

**Known transient false-blocks (re-run once, don't escalate):** if a required check fails
but the signature is a known-flaky/environmental one *unrelated to the diff* — a codegen
race (e.g. a docs/`.source` "not a module" / missing-property typecheck on a PR that
touches no docs), or a freshly-published dependency advisory the PR never introduced
(OSV-Scanner on a transitive dep) — re-run that job once (`gh run rerun <run-id> --failed`)
before treating it as a real Step-6 failure. If a security advisory is genuinely on `main`
too, the fix is a separate dependency-bump PR, not this one.

### Step 5: Handle CI Failures (max 2 attempts)

If CI fails:

1. Identify which job failed:
   ```bash
   gh pr checks <pr-number>
   ```
2. Get the failed run ID and view logs:
   ```bash
   gh run view <run-id> --log-failed
   ```
3. Read the failure output, identify root cause, fix the code
4. Run the failing command locally first to confirm the fix
5. Commit and push:
   ```bash
   git add <files> && git commit -m "fix: CI failure — <what was wrong>

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```
6. Wait for CI again (go back to Step 4)
7. If CI fails after 2 fix attempts: do not merge a red build. Stop and hand off —
   apply the `decision-pending` label (`gh label create decision-pending --color 5319E7
   --description "Blocked on a human decision" --force`), remove `in-progress`, and
   comment on the ORIGINAL issue with the failing job, the root cause you found, what
   you tried, and why it's still red. Do not open a new issue. End the run here.

### Step 6: Merge

**Only after the Step 4 gate exited with `stable=2`.** Re-confirm with one final read
immediately before merging — `gh pr view <pr-number> --json mergeStateStatus` must still
be `CLEAN`. If it regressed to `UNSTABLE`/`BLOCKED` (a check re-queued or a new push
landed), return to Step 4; never merge on a stale green.

All checks confirmed green — merge:

```bash
gh pr merge <pr-number> --squash
```

Do NOT use `--delete-branch` — it fails from worktrees. Branch cleanup happens in Step 7.

Clean up issue labels:

```bash
gh issue edit <issue_number> --remove-label "in-progress"
```

### Step 6b: Confirm the merge before doing ANYTHING else

**This is a hard gate — do not skip it.** Immediately after Step 6, run:

```bash
gh pr view <pr-number> --json mergedAt,state
```

`mergedAt` MUST be non-null **and** `state` MUST be `MERGED`. If it is not, **you are not
done** — the merge did not happen; return to Step 4 / Step 6 and drive it to a real merge.
Never emit an idle notification, end your turn, or proceed to Teardown (Step 7) or Report
(Phase 6) with an unmerged PR. "PR opened and checks passing" is **not** a completed run.
A background agent that idles green-but-unmerged here is the single most common failure of
this workflow — this gate exists to stop it.

A confirmed merge is **necessary but NOT sufficient**: it puts code on the default branch,
not in front of users. Continue to Step 6c — do not treat this gate as the finish line.

### Step 6c: Confirm the merge REACHED PRODUCTION

**A merge is not a release.** Step 6b proves the code is on the default branch; it does
NOT prove a single user can see it. Treat "merged" as done and you will report success on
code that is live to nobody.

This is not hypothetical. On a repo whose merges are performed by a bot token, GitHub
deliberately does NOT fire `on: push` workflows for those pushes — so the deploy pipeline
never runs, and the merged code sits on the default branch until some *unrelated* human
push happens to carry it out. Observed 2026-07-17 (imboard #2714): four PRs merged green,
`MERGE_COMMIT` captured, zero deploys; they reached production hours later bundled into a
stranger's push. Every signal this workflow checks said "shipped".

**Skip this step and the workflow's success token is a lie.**

1. **Find the project's deploy mechanism.** Do not assume it exists or that it is
   automatic. Look for a deploy workflow (`gh workflow list`), a `deploy`/`release`
   script, or a documented runbook in the repo guide. If the project has NO deploy step
   (a library, a docs site auto-built on push, an app deployed by an external system you
   cannot observe), record `DEPLOYED=N/A — <reason>` and move on. That is a legitimate
   outcome; silence is not.

2. **Check whether a deploy already carries your merge.** A successful deploy run whose
   commit CONTAINS `MERGE_COMMIT` (it need not equal it — a later deploy carrying your
   commit still ships it):

   ```bash
   # newest successful deploy runs, with the SHA each one shipped
   gh run list --workflow <deploy-workflow> --limit 5 \
     --json headSha,status,conclusion,createdAt \
     --jq '.[] | select(.conclusion=="success") | .createdAt + " " + .headSha'
   # is your merge contained in what shipped?
   git fetch origin --quiet
   git merge-base --is-ancestor <MERGE_COMMIT> <deployed_sha> && echo SHIPPED || echo NOT-SHIPPED
   ```

3. **If nothing ships it within ~5 minutes, dispatch the deploy yourself**, then confirm
   it succeeded:

   ```bash
   gh workflow run <deploy-workflow> [-f environment=production]   # inputs vary — read the workflow
   ```

   Deploying deliberately is SAFER than the default. The merged code is going to
   production regardless — the only question is whether it goes at a moment nobody chose,
   unattended, bundled with an unrelated change, and attributed to whoever pushed next.

4. **A failed deploy is a hard blocker.** Escalate on the issue (comment + remove
   `in-progress`) with the run URL. Do NOT report the run as complete. Do NOT retry blindly
   more than once — a red deploy on the default branch may be affecting live users and is a
   human's call.

5. **Record `DEPLOYED`** — the shipped SHA + the run URL — and pass it to Phase 6.

**Only now is the work shipped.**

### Step 7: Teardown

**Prerequisite: Step 6b (merge confirmed) AND Step 6c (deploy confirmed or `N/A`) must be
complete.** Do not tear down before the
merge is confirmed.

1. `cd` back to `original_dir` (if provided)
2. **Try to return the worktree to the pool** (if `pool_claimed` is true):
   ```bash
   npx worktree-pool return --path <worktree_path> 2>/dev/null
   ```
   - If succeeds: worktree recycled for reuse. Skip steps 3-5.
   - If fails: continue with manual cleanup.
3. Remove the worktree:
   ```bash
   git worktree remove <worktree_path>
   ```
4. Delete local branch if it still exists:
   ```bash
   git branch -d <branch-name> 2>/dev/null || git branch -D <branch-name>
   ```
5. Clean up remote branch if it still exists:
   ```bash
   git push origin --delete <branch-name> 2>/dev/null || true
   ```

## Output

- `pr_number`: the created PR number
- `pr_url`: the PR URL
- `merge_status`: merged | failed
- `target_branch`: the branch merged into
- `cleanup`: pool_returned | worktree_removed | skipped

## Validation

- [ ] Changes committed with conventional commits format
- [ ] Branch pushed to remote
- [ ] PR created targeting correct base_branch
- [ ] CI passed (or failures fixed within 2 attempts)
- [ ] CI confirmed green on two consecutive stable polls — not a single transient success
- [ ] CI wait done in-turn (foreground batch re-runs) — never backgrounded or deferred
- [ ] PR merged (squash)
- [ ] Merge confirmed: `gh pr view` shows `mergedAt` non-null and `state` `MERGED` (Step 6b)
- [ ] Deploy confirmed: a successful deploy run CONTAINS `MERGE_COMMIT`, or `DEPLOYED=N/A` with a reason (Step 6c) — merged is not shipped
- [ ] in-progress label removed
- [ ] Worktree returned to pool or removed
- [ ] Returned to original directory

## Troubleshooting

**CI fails after fixes**: See Step 5 item 7 — after 2 attempts, stop and hand off on
the issue (`decision-pending` label + comment). Do not open a new issue. May be an
infrastructure issue rather than a code issue — say so in the comment.

**Phantom success / flaky check status**: the checks API can report a transient
`success` while a required job is still running, or all-pass before a slow job registers.
Never merge on one read — require two consecutive `CLEAN` + zero-pending reads (Step 4).

**Merge stall / "I'll be notified when CI is done"**: the most common failure of this phase
is the agent backgrounding the CI wait (a `Monitor`, a `run_in_background` poll, or just
ending the turn to "wait for notification") — the PR then goes green but never merges. Never
do that. Step 4 is a foreground, same-turn loop: run the bounded batch, and on `RESULT=pending`
run it again immediately. Stay in the turn until `RESULT=green` (→ merge) or `RESULT=failing`.

**Merge conflicts**: Needs human judgment. Stop and hand off on the issue
(`decision-pending` label + comment describing the conflicting files and why an
automatic resolution isn't safe) — do not guess at a resolution, do not open a new issue.

**`--delete-branch` fails in worktree**: Expected — don't use it. Clean up in Step 7.

**Pool return fails**: Not an error — fall back to manual worktree remove.
