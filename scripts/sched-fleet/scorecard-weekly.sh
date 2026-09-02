#!/usr/bin/env bash
# Weekly cron: regenerate docs/reports/model-scorecard.md + the JSON sidecar (#566),
# open/refresh a PR with the new snapshot, and post the 6-line digest to Telegram.
#
# Reference install, like the rest of scripts/sched-fleet/ — copy and edit per
# deployment (see scripts/sched-fleet/README.md). Cron line (weekly):
#   0 5 * * 1  /path/to/scorecard-weekly.sh >> /path/to/scorecard-weekly.log 2>&1
#
# Runs in a DEDICATED worktree, never the main checkout — this repo's AGENTS.md
# forbids checking out branches in the main worktree (it breaks parallel agents
# already running there), so a fixed worktree at worktrees/chore-model-scorecard-weekly
# is created once and reused/rewritten every run, exactly like
# refresh-examples-snapshot.mjs's PR branch: any manual commit pushed to
# chore/model-scorecard-weekly between runs is discarded by the next one.
#
# This repo has no auto-merge watcher (see AGENTS.md), so this script only opens or
# updates the PR — it never merges. A human or an agent run merges it.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
D="${SCHED_FLEET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

REPO="${SCORECARD_REPO:-$HOME/projects/ai-dossier/main}"
WT="$REPO/worktrees/chore-model-scorecard-weekly"
BRANCH="chore/model-scorecard-weekly"
LOG="$D/scorecard-weekly.log"
DIGEST_FILE="$D/scorecard-weekly-digest.txt"

# Rotate before anything writes, so one run's trace is findable after a Telegram alert
# rather than buried in an ever-growing file.
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 10485760 ]; then mv "$LOG" "$LOG.1"; fi
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$LOG"; }

# Telegram is this script's ONLY channel: without the env file, `set -u` would kill the run
# at the first token expansion with no message and nothing in the log. Say so on stderr,
# which cron mails, instead of exiting silently.
if [ ! -f "$D/telegram.env" ]; then
  echo "scorecard-weekly: missing $D/telegram.env (copy telegram.env.example)" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$D/telegram.env"
: "${HANEST_TELEGRAM_BOT_TOKEN:?scorecard-weekly: HANEST_TELEGRAM_BOT_TOKEN unset in telegram.env}"
: "${HANEST_TELEGRAM_CHAT_ID:?scorecard-weekly: HANEST_TELEGRAM_CHAT_ID unset in telegram.env}"

# Log every send and its outcome: a failed notify is otherwise indistinguishable from a run
# that never reached the notify step.
TG() {
  log "TG: $1"
  _tg_resp=$(curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="$1" 2>&1)
  case "$_tg_resp" in *'"ok":true'*) ;; *) log "TG send FAILED: $_tg_resp" ;; esac
}

# One run at a time: a hung run must not have next week's cron running npm install and
# `git checkout` concurrently against the same worktree.
exec 9>"$D/.scorecard-weekly.lock"
if ! flock -n 9; then
  log "another scorecard-weekly run holds the lock — skipping"
  exit 0
fi

log "run start repo=$REPO worktree=$WT branch=$BRANCH"

cd "$REPO" || { TG "❌ model-scorecard weekly: repo not found at $REPO"; exit 1; }
if ! git fetch origin main >>"$LOG" 2>&1; then
  TG "❌ model-scorecard weekly run failed on hcc2 (git fetch) — see $LOG"
  exit 1
fi

# Every step checked. `[ -d "$WT" ]` alone stays true for a worktree that already existed
# and whose reset just failed — the run would then score last week's code and push it as a
# fresh snapshot with a success digest.
log "stage: worktree refresh"
if [ -d "$WT" ]; then
  if ! git -C "$WT" fetch origin main >>"$LOG" 2>&1 \
    || ! git -C "$WT" checkout -B "$BRANCH" origin/main >>"$LOG" 2>&1 \
    || ! git -C "$WT" reset --hard origin/main >>"$LOG" 2>&1; then
    TG "❌ model-scorecard weekly run failed on hcc2 (worktree refresh) — see $LOG"
    exit 1
  fi
else
  if ! git branch -f "$BRANCH" origin/main >>"$LOG" 2>&1 \
    || ! git worktree add "$WT" "$BRANCH" >>"$LOG" 2>&1; then
    TG "❌ model-scorecard weekly run failed on hcc2 (worktree setup) — see $LOG"
    exit 1
  fi
fi
# The snapshot is only evidence if it was generated from origin/main, and the force-push
# below is only safe on a branch that is actually the one we reset.
if [ "$(git -C "$WT" rev-parse HEAD 2>>"$LOG")" != "$(git -C "$WT" rev-parse origin/main 2>>"$LOG")" ] \
  || [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>>"$LOG")" != "$BRANCH" ]; then
  TG "❌ model-scorecard weekly: $WT is not $BRANCH at origin/main after refresh — see $LOG"
  exit 1
fi

cd "$WT" || { TG "❌ model-scorecard weekly: cannot cd into $WT"; exit 1; }
# `npm ci`, not `npm install`: this runs unattended on a host holding the Telegram token and
# a gh credential, and executes what it builds. Lockfile fidelity is the repo convention
# (.github/workflows/ci.yml). `timeout` so a hung registry does not hold the lock all week.
log "stage: npm ci"
if ! timeout 1800 npm ci --no-audit --no-fund >>"$LOG" 2>&1; then
  TG "❌ model-scorecard weekly run failed on hcc2 (npm ci) — see $LOG"
  exit 1
fi
log "stage: build"
if ! timeout 1800 make build-all >>"$LOG" 2>&1; then
  TG "❌ model-scorecard weekly run failed on hcc2 (build) — see $LOG"
  exit 1
fi

# A dedicated digest file, not a log grep — the digest can't be confused with
# npm install/build output landing in the same log, and doesn't depend on the
# script's own log-message wording matching a grep pattern.
rm -f "$DIGEST_FILE"
log "stage: scorecard"
if ! timeout 900 npm run scorecard -- --digest-out "$DIGEST_FILE" >>"$LOG" 2>&1; then
  TG "❌ model-scorecard weekly run failed on hcc2 (scorecard) — see $LOG"
  exit 1
fi
if [ ! -f "$DIGEST_FILE" ]; then
  TG "❌ model-scorecard weekly run on hcc2 exited 0 but wrote no digest — see $LOG"
  exit 1
fi
DIGEST=$(cat "$DIGEST_FILE")

# Compare the PAYLOAD, not the whole file: both artifacts embed `generatedAt` and the window
# dates, so a plain `git diff --quiet` is never true and the no-op path was unreachable —
# the cron opened and force-pushed a PR every Monday even on a zero-change week.
# Scratch outside the worktree, so a run that dies mid-comparison never leaves untracked
# files in a checkout the next run reuses.
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
if command -v jq >/dev/null 2>&1 \
  && git show "origin/main:docs/reports/evidence/model-scorecard.json" >"$TMPD/prev.json" 2>>"$LOG"; then
  _strip='del(.generatedAt, .windowStart, .windowEnd, .since, .windowDays)'
  if jq -S "$_strip" "$TMPD/prev.json" >"$TMPD/prev.norm" 2>>"$LOG" \
    && jq -S "$_strip" docs/reports/evidence/model-scorecard.json >"$TMPD/new.norm" 2>>"$LOG" \
    && cmp -s "$TMPD/prev.norm" "$TMPD/new.norm"; then
    log "run end: no payload change this week"
    # Appended to the digest's last line, not added as a seventh: the 6-line shape is the
    # contract this message is read against, and a stray line breaks a skim.
    TG "$(printf '%s' "$DIGEST" | sed '$ s/$/ — (no changes this week)/')"
    exit 0
  fi
fi

log "stage: commit/push"
if ! git add docs/reports/model-scorecard.md docs/reports/evidence/model-scorecard.json \
  || ! git commit -m "chore(reports): weekly model scorecard refresh" >>"$LOG" 2>&1 \
  || ! git push -f -u origin "$BRANCH" >>"$LOG" 2>&1; then
  TG "❌ model-scorecard weekly: commit/push failed on hcc2 — see $LOG (digest was: $DIGEST)"
  exit 1
fi

# `gh pr view` resolves CLOSED and MERGED PRs for a branch too, so it reported "a PR exists"
# forever after the first merge — every later run then edited the merged PR, confirmed
# success, and left that week's refresh pushed to a branch with no open PR to review.
log "stage: pr"
PR_BODY="Automated weekly refresh of the model scorecard (#566), regenerated by \`scorecard-weekly.sh\` on hcc2. This repo has no auto-merge watcher — review and merge manually."
PR_NUM=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty' 2>>"$LOG")
if [ -n "$PR_NUM" ]; then
  gh pr edit "$PR_NUM" --body "$PR_BODY" >>"$LOG" 2>&1
else
  gh pr create --base main --head "$BRANCH" \
    --title "chore(reports): weekly model scorecard refresh" \
    --body "$PR_BODY" >>"$LOG" 2>&1
fi
PR_NUM=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty' 2>>"$LOG")
if [ -z "$PR_NUM" ]; then
  log "run end: FAILED at pr (no open PR for $BRANCH)"
  TG "$DIGEST
⚠️ no open PR for $BRANCH after create/update — check $LOG"
  exit 1
fi

log "run end: ok (pr=#$PR_NUM)"
TG "$DIGEST"
