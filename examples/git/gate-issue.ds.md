---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "gate-issue",
  "title": "Gate Issue — Pre-Flight Safety Check",
  "version": "1.6.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2026-08-29",
  "objective": "Lightweight safety gate that checks issue metadata for hard blocks and soft warnings before starting any workflow; recognizes classify, slot-mode, and batch-anchor runstate trails so a full-cycle run never resumes into a nonexistent batch",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "gate"
  ],
  "risk_level": "low",
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number to check",
        "type": "number"
      }
    ],
    "optional": []
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "content_scope": "references-external",
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "25a3b2ff5a405d9fc7a36d8d915e691e8c12e70149c0413ed7b07e19dc1fc8e1"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "ZdJ2K8bhJ0rgyZu+m/sGphUFxBeqRUH9CtSBCt06vm0amzZR/593GgnF7j77pLnX1K7Jb7GHxh27rT5JOMiZDA==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T18:04:13.029Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Gate Issue — Pre-Flight Safety Check

## Objective

Lightweight safety gate (~30s) — check issue metadata for blockers before committing to a workflow. No codebase exploration.

## Prerequisites

- GitHub CLI (gh) is installed and authenticated
- `ai-dossier` CLI >= 0.10.0 is installed (`ai-dossier runstate --help`) — this phase mints, reads, and posts runstate through it
- You are in a git repository with GitHub as a remote

## Actions to Perform

### Step 1: Fetch Issue Metadata

```bash
gh issue view <issue_number> --json state,labels,body
```

### Step 1b: Mint Run ID

Mint the runstate `run_id` ONCE here; every later phase reuses it unchanged. Pass it to every subsequent sub-dossier exactly like `base_branch`. On a resumed run, Step 1.5 reuses the prior `run_id` instead of this fresh mint — trail continuity matters more than a new id.

```bash
RUN_ID=$(ai-dossier runstate mint --issue <issue_number>)
echo "Run ID: $RUN_ID"
```

### Step 1.5: Resume Detection

Check for runstate history before treating this as a fresh run:

```bash
LAST=$(ai-dossier runstate last --issue <issue_number> --json)
```

No milestone (empty output) → `resume_from=none`: keep the Step 1b `RUN_ID` and continue to Step 2 (Hard Blocks) as today.

Otherwise read `.phase`, `.status`, `.run`, and the phase-specific keys from that JSON. **Reuse `.run` as `RUN_ID`** — discard the one minted in Step 1b. Then VERIFY the claim against reality — never trust the comment alone.

**Run the verification, do not hand-walk it.** `ai-dossier runstate verify --issue <issue_number> --json` performs the entire table below and prints `resume_from` plus the parsed `resume_context` — that is the supported way to resume. Use its answer.

```bash
ai-dossier runstate verify --issue <issue_number> --json
```

**Fresh-entry trails (classify / slot-mode / batch anchors).** Three trail shapes have no full-cycle phases to resume into; `verify` reports them as `resume_from=none` with a `note` (and `slot_trail: true` where marked). Handle each explicitly — never map a resume into a batch:

- **`phase=classify` record** (any `mode=`): a classification verdict, not a run — the cycle dispatched from it mints its own run. Enter FRESH. When `mode=slot`, `verify` also sets `slot_trail=true` (the member was evicted/requeued before any slot milestone landed).
- **Slot-mode member trail** — last milestone carries `mode=slot` or `batch=<id>` (a full-cycle-line phase; **including `status=blocked`** — the state machine that posted it is not the one resuming): the batch worktree is machine-local and an evicted member is requeued as full-cycle from scratch, so there is nothing to resume. Enter FRESH with `slot_trail=true`. This is the requeue-with-context path: carry a pointer to the prior trail (see Step 6) so the plan phase reads the member's plan artifact and failure evidence instead of re-deriving them.
- **Batch anchor trail** — last milestone is a batch phase (`batch-setup`, `batch-validate`, `batch-review`, `batch-ship`, `batch-report`): the issue is a batch ANCHOR, not an implementable issue. Hard block with `reason=batch-anchor` (Step 2) — anchors are driven by the scheduler, never by full-cycle.

On any fresh entry, keep the `run_id` minted in Step 1b — do NOT reuse the trail's `.run` (it belongs to the classify/slot run and its phases). Fresh-entry checks outrank the blocked rule (a blocked slot-mode milestone still enters fresh); only the resume loop cap outranks them.

Verification is **remote-first**: origin/<branch> is the durable copy of the work (WIP sync rule), so every check runs against the remote, not the local worktree. The **remote check** is: the branch exists on origin (`git ls-remote --exit-code origin <branch>`; a local worktree is a bonus, not a requirement) and, for milestones carrying `head`, `git fetch origin <branch>` then `head` equals the `git ls-remote origin <branch>` sha or `git merge-base --is-ancestor <head> FETCH_HEAD` succeeds.

*verify implements this table; run the command, read the table only when debugging.*

| last milestone | verify | if verified → | if not → |
|---|---|---|---|
| `gate` done | nothing to verify | `resume_from=setup` | — |
| `setup` done | remote branch check | `resume_from=plan` | `resume_from=setup` |
| `plan` done | remote check incl. `head` | `resume_from=implement` | `resume_from=plan` (or setup if those fail) |
| `implement` done | remote check incl. `head` | `resume_from=review` | `resume_from=implement` |
| `review` done | remote check incl. `head` | `resume_from=ship` | `resume_from=review` |
| `review` partial | remote check incl. `head` | `resume_from=review` with `agents_pending` passed through | `resume_from=review` |
| `ship` awaiting-merge | `gh pr view <pr> --json state,mergedAt,mergeable` | merged → `resume_from=ship-teardown`; open+MERGEABLE → `resume_from=ship-wait`; CONFLICTING/closed-unmerged → `resume_from=ship` | `resume_from=ship` |
| `ship` done | — | `resume_from=report` | — |
| `report` done | issue is CLOSED? | print "already complete" and STOP (status pass, `resume_from=done`) | `resume_from=report` |
| `classify` record | — | `resume_from=none` FRESH (new run id; `slot_trail` when `mode=slot`) | — |
| slot-mode (`mode=slot` or `batch=<id>` on the last milestone, any status) | — | `resume_from=none` FRESH, `slot_trail=true` — never resume into the batch | — |
| batch phase (`batch-*`) | — | batch anchor — not a full-cycle run → hard block `reason=batch-anchor` | — |
| any `blocked` | treat as the phase itself: `resume_from=<that phase>` | | |

The three fresh-entry rows outrank the blocked row — a `status=blocked` slot-mode milestone still enters fresh (the state machine that posted it is not the one resuming). Only the resume loop cap outranks fresh-entry checks.

The planning-file check (`test -f <planning>`) is not in this table — it happens AFTER the worktree is materialized, in full-cycle-issue's "## Resuming", since the worktree may not exist on this machine yet.

When the last milestone carried a `worktree=` path, also check `test -d <worktree>` on this machine and report `local_worktree=present|absent`. Informational only — it never changes the `resume_from` decision, since the remote check is authoritative.

**Loop cap**: if the last THREE runstate milestones are all `status=blocked` on the same phase, hard block with `reason=resume-loop` — add label `decision-pending`, post the abort comment (Step 2), and stop.

**Hard blocks (Step 2) still apply on resume** — EXCEPT "issue is closed", which is not a block when `resume_from` is `report` or `done` (a merged PR auto-closes the issue before report runs).

Carry `resume_context` forward: the parsed key=value lines of the last milestone, for later phases to consume.

### Step 2: Hard Blocks

If ANY of these are true, abort immediately with a comment on the issue:

- **Issue is closed**: `state == "CLOSED"` (not a block when resuming with `resume_from=report` or `resume_from=done` — see Step 1.5)
- **Has label `decomposed`**: Issue was already decomposed into sub-issues by triage
- **Has label `needs-clarification`**: Issue was triaged as not ready
- **Has label `epic`**: Issue is an epic, not directly implementable
- **Has label `batch-epic`**, or its runstate trail ends with a `batch-*` phase: the issue is a batch ANCHOR — driven by the batch scheduler, never by full-cycle
- **Has open dependency**: Body contains `Depends on #N` (case-insensitive) where issue #N is still open — for each one found, `gh issue view <N> --json state --jq '.state'`; state `OPEN` is a hard block.

**On hard block**: Post a comment and stop:

```bash
gh issue comment <issue_number> --body "**Workflow aborted**: <reason>. Resolve the blocker and re-run."
```

Then post the blocked runstate milestone (Step 6) with `--status blocked --kv reason=closed|decomposed|needs-clarification|epic|batch-anchor|open-dependency-<N>`.

Do NOT proceed.

### Step 2b: Duplicate In-Flight Work Check

Search for other open work on the same surface BEFORE committing a run to it:

```bash
gh issue list --state open --search "<2-3 distinctive terms from the title>" --json number,title
gh pr list --state open --search "<same terms>" --json number,title
```

If an open issue or PR plausibly fixes the same root cause, add a **soft warning** naming it (`overlap=<#n,...>` in the milestone) and instruct the plan phase to read it first — two independent fixes for one bug surface as a merge conflict two phases later (#3671/#3650). If the overlap is near-certain (same symptom, same component, PR already open), treat it as a hard block: comment on the issue linking the duplicate and stop.

### Step 3: Soft Warnings

Count how many of these are true:

- Body is empty or less than 50 characters
- Body contains research keywords: `evaluate`, `research`, `explore`, `investigate`, `compare` (case-insensitive)
- Issue has no labels at all

If **2 or more** soft warnings: log a warning line but continue; 0-1 soft warnings: proceed silently.

```
⚠ Gate: 2 soft warnings (short body, no labels) — proceeding with caution
```

### Step 4: Extract Base Branch

Parse the issue body for `merges into \`<branch-name>\`` (case-insensitive):

```bash
BASE_BRANCH=$(gh issue view <issue_number> --json body --jq '.body' | grep -oiP 'merges into `\K[^`]+' | head -1)
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="main"
fi
echo "Base branch: $BASE_BRANCH"
```

### Step 5: Output

```
Gate passed: #<issue_number> — <title>
Base branch: <BASE_BRANCH>
Warnings: <count> (<list or "none">)
```

### Step 6: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — on a hard block, post it with `--status blocked --kv reason=<short-slug>` before stopping. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
ai-dossier runstate post --issue <issue_number> --phase gate --status done --run "$RUN_ID" \
  --kv base_branch=<BASE_BRANCH> \
  --kv warnings=<n> \
  --kv resumed_from=<phase|none> \
  --kv prior_run=<run_id|none> \
  --kv verified=<comma list of checks passed|none> \
  --kv model=<the model id you are running as, e.g. claude-opus-5; use "unknown" only if genuinely undeterminable; strip any context suffix such as `[1m]` — bare model id only> \
  --kv slot_trail=true \
  --kv batch=<batch_id>
```

`model=` makes the trail analyzable by model over time; state it honestly — it is the run's provenance, not a preference.

The last two keys are the **slot-trail context pointer** — add them ONLY on a fresh entry over a slot-mode trail (Step 1.5): `slot_trail=true`, and `batch=<batch_id>` taken from the trail's `resume_context` (omit the key entirely when the trail carries no batch id). The gate milestone's `prior_run=<slot run id>` (the `.run` verify reported, NOT the fresh mint) completes the pointer — the plan phase reads the prior trail's comments for the member's plan artifact and failure evidence instead of re-deriving them. An ordinary fresh run (no trail) keeps `resumed_from=none prior_run=none` and adds neither key.

Let the CLI stamp `at=` and compute `next=` (here `setup`) — do not pass either; never hand-write the comment. On a hard block: `--status blocked --kv reason=<short-slug>` (the CLI then sets `next=done`).

## Output

- `status`: pass | fail
- `run_id`: runstate run id — minted fresh in Step 1b, or reused from a prior run on resume (Step 1.5) — pass to every subsequent sub-dossier
- `base_branch`: resolved base branch (default: `main`)
- `warnings`: list of soft warnings (may be empty)
- `failure_reason`: reason for hard block (only if status=fail)
- `resume_from`: phase to resume from, or `none` for a fresh run
- `resume_context`: parsed key=value lines of the last runstate milestone, for later phases to consume
- `slot_trail`: true when the prior trail was slot-mode (fresh entry — never a resume; pass the pointer keys to plan so it reads the prior trail's plan artifact + failure evidence)
- `local_worktree`: `present` | `absent` | `n/a` — whether the `worktree=` path from resume_context exists on this machine (informational; remote is authoritative)
- Posts runstate milestone to the issue (`phase=gate`)

## Validation

- [ ] Issue metadata fetched; soft warnings counted; base branch extracted from issue body
- [ ] Resume detection (Step 1.5) ran before hard blocks, via `ai-dossier runstate last` + `ai-dossier runstate verify`
- [ ] Fresh-entry trails handled per the decision table: classify → FRESH; slot-mode (`mode=slot`/`batch=`, any status) → FRESH with `slot_trail=true` and the context pointer keys (`prior_run`, `batch`) on the milestone; batch phase → hard block `reason=batch-anchor`
- [ ] On a fresh entry over a slot trail: the Step 1b mint was kept as `run_id` (the trail's `.run` was NOT reused) and the context pointer keys were posted
- [ ] On resume: the prior `run_id` was reused, not re-minted, and the claimed milestone was verified against reality (not trusted blindly)
- [ ] Resume verification is remote-first — `setup`/`plan`/`implement`/`review` milestones are verified against `origin/<branch>` (ls-remote / merge-base ancestor check), not a local worktree
- [ ] `local_worktree=present|absent` was reported when a `worktree=` path existed in `resume_context` (bonus signal only, never gates the resume decision)
- [ ] Resume loop cap enforced — 3 consecutive `blocked` on the same phase is a hard block with `reason=resume-loop`
- [ ] A `run_id` was minted via `ai-dossier runstate mint` (fresh run) or reused (resumed run) and reported
- [ ] All hard blocks were checked (with the resume exception for a closed issue at `resume_from=report`/`done`)
- [ ] On hard block: comment was posted and workflow stopped
- [ ] On pass: output includes status, base_branch, run_id, warnings, resume_from, and resume_context
- [ ] Runstate milestone was posted via `ai-dossier runstate post`, including `resumed_from`/`prior_run`/`verified`

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh` not found | Install GitHub CLI: https://cli.github.com/ |
| `ai-dossier runstate` not found | The CLI is older than 0.10.0 — install it (`npm i -g @ai-dossier/cli`). Do not fall back to hand-written milestone comments. |
| Issue not found | Verify the issue number and repository access |
| Dependencies check slow | Only checks issues explicitly referenced with "Depends on #N" |
