---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "git-sync",
  "title": "Git Sync — Reconcile Local State with Origin",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-04-29",
  "objective": "Triage untracked and modified files and reconcile local branch state with origin: gitignore obvious junk, commit and push real work, surface ambiguous items, and report stray branches and worktrees.",
  "category": [
    "development"
  ],
  "tags": [
    "git",
    "github",
    "sync",
    "commit",
    "gitignore",
    "worktree",
    "cleanup"
  ],
  "risk_level": "medium",
  "requires_approval": false,
  "risk_factors": [
    "modifies_files",
    "deletes_files",
    "network_access"
  ],
  "destructive_operations": [
    "Appends entries to .gitignore for files matching well-known junk patterns",
    "Deletes untracked files matching narrow scratch patterns (tmp/*, scratch/*, *.bak, *~)",
    "Creates commits and pushes them to origin"
  ],
  "estimated_duration": {
    "min_minutes": 1,
    "max_minutes": 5
  },
  "tools_required": [
    {
      "name": "git"
    },
    {
      "name": "gh"
    }
  ],
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "58721c6f0a1be8e4fd6aabbf59f9052824294db94c6d3bc06068a2008ed091fb"
  }
}
---

# Git Sync — Reconcile Local State with Origin

## Objective

Leave the repository in a clean, pushed state — every untracked file deliberately handled, every commit on origin — autonomously when the call is unambiguous, and only asking the user about items that genuinely require judgment. Optimize for the common case: arriving in a repo on any machine, noticing the shell prompt flagging dirty state, and getting back to a clean baseline in under a minute.

## Constraints

### Sensitive paths are never auto-handled

The following paths are treated as potentially secret and **always surfaced**, never auto-committed and never auto-deleted:

- `.env`, `.env.*` (with the explicit exception of `.env.example`, `.env.sample`, `.env.template`)
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt` (when not under a public/known certificate path)
- `id_rsa*`, `id_ed25519*`, `id_dsa*`, `id_ecdsa*`
- Anything under a directory named `secrets/`, `private/`, or `credentials/`

### Hard rules

- **Never delete tracked files.** Only untracked files may be deleted, and only when matching narrow scratch patterns (see Decision Points).
- **Never force-push.** Never `--no-verify`. Never amend a commit that already exists on origin.
- **Never auto-rebase or auto-merge** a diverged or behind branch. Report state and recommend an action; let the user decide.
- **Never operate on sibling worktrees.** Stay within the current working tree.
- **Stray branches and worktrees are reported, not deleted** in this version.
- **Never bypass pre-commit hooks.** If a hook fails, surface the failure with its output; do not retry with `--no-verify`.

### Degraded modes

- **No `origin` remote configured** — perform classification and commit; surface that push is not possible.
- **`gh` not authenticated or not installed** — degrade to `git`-only operations; do not block on PR-related queries.
- **Detached HEAD** — abort with a clear message; user must check out a branch first.
- **Repo with merge or rebase in progress** — abort; do not interfere with an ongoing operation.

## Decision Points

The dossier classifies every finding into one of four buckets: act silently, act after batch confirmation, surface and ask, or report only.

### Untracked files

| Pattern | Action |
|---|---|
| Auto-gitignore patterns (see list below) | Append rule to `.gitignore` silently |
| Inside `tmp/`, `scratch/`, or matching `*.bak`, `*~`, **and** not modified in the last hour | Delete silently |
| Sensitive path match | Surface; never act |
| Anything else (source files, configs, docs the agent cannot classify) | Ask: add / gitignore / delete / leave |

**Auto-gitignore patterns**: `*.log`, `.DS_Store`, `Thumbs.db`, `dist/`, `build/`, `coverage/`, `.next/`, `.cache/`, `.turbo/`, `.parcel-cache/`, `*.tmp`, `*.swp`, `*.swo`, `node_modules/`, editor backups (`*~`), `.pytest_cache/`, `__pycache__/`, `.venv/`, `venv/`.

When appending to `.gitignore`: append; never rewrite or reorder existing rules. If the file does not exist, create it.

### Modified tracked files

| Condition | Action |
|---|---|
| Diff is single-purpose, under ~200 changed lines, no sensitive paths touched | Stage and commit silently with conventional-commits message |
| Diff is large or spans clearly unrelated concerns | Surface a summary; ask whether to commit as one or split |
| Diff touches a sensitive path | Surface; never auto-commit |
| File is also listed in a sensitive-path pattern | Surface; never auto-commit |

**Commit message format** (conventional commits):

```
<type>: <inferred summary>

<optional body when the diff spans multiple files or needs context>

Co-Authored-By: Claude <noreply@anthropic.com>
```

`<type>` is inferred from the diff: `feat` for new functionality, `fix` for bug fixes, `chore` for tooling/config, `docs` for documentation-only, `refactor` for non-behavior-changing structure, `test` for test-only, `style` for formatting-only.

### Branch and remote state

| Condition | Action |
|---|---|
| Local commits ahead of origin, no divergence | Push silently after any new commits land |
| Local diverged from origin (ahead **and** behind) | Report counts; suggest `git pull --rebase` or merge; do not act |
| Local behind origin, no local commits | Report; suggest `git pull --ff-only`; do not act |
| Local branch has no remote tracking | Report in summary; offer `git push -u origin <branch>` only if the user explicitly opts in |
| Push fails (non-fast-forward, hook rejection, auth) | Surface the error verbatim; do not retry with force |

### Worktree health (current worktree only)

| Condition | Action |
|---|---|
| Current worktree's branch was deleted on origin and locally merged | Report in summary; suggest `git worktree remove` |
| Worktree is on a detached HEAD | Abort the run with a clear message |
| Worktree appears in `git worktree list` but the path is missing on disk | Out of scope; not the current worktree |

## Workflow

The agent runs the following high-level shape; concrete commands are deliberately not prescribed.

1. **Pre-flight.** Confirm a git repo, not detached HEAD, no rebase/merge in progress. `git fetch` to update remote refs (best-effort; do not block on network failure).
2. **Snapshot state.** Collect: `git status --porcelain`, `git rev-list --left-right --count @{upstream}...HEAD` (when upstream exists), `git branch -vv`, `git worktree list --porcelain`.
3. **Classify** each finding per the Decision Points table.
4. **Plan and present.** Group classified actions into: *silent actions* (auto-gitignore, auto-delete, auto-commit, auto-push), *items needing input*, and *report-only items*. Show the user the silent action plan as a single batch summary before executing any deletions or commits — the user can intervene with a single message if anything looks wrong, but no per-item confirmation.
5. **Execute silent actions** in this order: gitignore appends → deletes → stage+commit → push. Stop on any unexpected error and surface it.
6. **Ask** about ambiguous items one at a time, only when the answer is needed (skip questions whose answers don't affect the next action).
7. **Final report.** A compact summary listing: actions taken, items deferred to user, branch/remote state, worktree health notes.

## Known Pitfalls

- **Existing `.gitignore`** — append only; never rewrite, reorder, or deduplicate. Preserve user-authored sections and comments.
- **Pre-commit hooks** — they may modify files (formatters, linters with `--write`). Re-stage modified files transparently before completing the commit, but never bypass on failure.
- **Repos without `origin`** — common for fresh local repos. Do everything except push; surface the gap in the final report.
- **Multi-worktree repos** — `git worktree list` shows siblings; only operate on the current cwd's worktree.
- **`gh` token not loaded** — fall back to git-only; do not assume failure of a `gh` query means the branch state is bad.
- **Newly created branch on first push** — `git push` will fail; offer `git push -u origin <branch>` as an explicit user opt-in, not a silent action.
- **Recently modified scratch files** (`tmp/`, `scratch/`, `*.bak`) — only auto-delete when older than one hour, to avoid clobbering files the user just created.

## Validation

End-of-run state should satisfy:

- [ ] `git status --porcelain` is empty, or contains only items the user was asked about and chose to leave
- [ ] `git rev-list @{upstream}..HEAD` is empty, or there is a surfaced reason (no remote, diverged, push failed)
- [ ] No commit created in this run touches a sensitive path
- [ ] Final report enumerates every silent action and every user-input item

## Out of scope (v1)

Captured here so the dossier's behavior is predictable and so future versions know where to expand:

- Cross-worktree sync (operating on sibling worktrees from a single invocation)
- Auto-deleting local branches that have been merged and pushed
- Resolving lockfile conflicts (`package-lock.json`, `bun.lock`, `yarn.lock`)
- Auto-creating PRs for branches with no PR yet
