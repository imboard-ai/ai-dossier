# Agent Traps

Grep-first symptom → trap → fix index. `plan-issue` reads this file in full and greps it
for terms from the issue title and affected paths before planning (Step 4.5); `report-issue`
appends a row here when a run required a CI fix or surfaced a trap a future agent should
search for first.

| Symptom (grep this) | What went wrong | Fix | PR |
|---|---|---|---|
| `is the first bad commit` | Newer git prints `<sha> is the first bad commit` on **stderr**, not stdout — bisect result-parsing that read stdout found nothing, so every real bisect returned `error` in CI while passing on older git locally | Read the result from `refs/bisect/bad` (git leaves it pointing at the first bad commit) instead of parsing bisect's stdout | PR #498 |
| `no crontab for` | `set -e` combined with `crontab -l` on a host with no existing crontab (which exits non-zero and prints `no crontab for <user>`) let the fleet-reset script fall through with empty captured content, so it installed an empty crontab instead of preserving the existing jobs | Capture `crontab -l` with `\|\| true` (or `2>/dev/null \|\| echo ""`) before appending new jobs, so a missing crontab reads as empty input, not a fatal error | reset-fleet incident |
| `unknown command` | A stale **nvm** copy of `ai-dossier` — a repo-local `node_modules/.bin/ai-dossier` or stray `~/node_modules` install — shadows the global install with an older build; running a newly documented subcommand against the stale shadow reports `unknown command` instead of running it | Call the newer binary by absolute path, or run `scripts/fleet-cli-audit.sh --fix` to neutralize shadow copies (renames, never deletes) | fleet-cli-audit rationale |
| `resume_from=setup` | `runstate verify`'s `computeResume`/`setupOk()` required the recorded `worktree=` path to exist on THIS machine, so a cross-machine resume (redispatch landing on a different host) silently re-ran setup and plan instead of resuming at `implement`, even though the branch and `head=` were present on origin | `setupOk()` now accepts remote-first evidence — branch exists on origin and `head=` is an ancestor of remote HEAD; local worktree presence is informational only (`local_worktree=present\|absent`) and never gates `resume_from` | PR #516 (#499) |
