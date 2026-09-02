#!/usr/bin/env bash
# reset-fleet/bootstrap.sh — fires ONCE at the claude weekly reset (cron 0 4 1 9 *).
# Enqueues issues 496→500→505→507 into dossier-sched (serial dependency chain,
# sonnet tier) and arms the engine tick cron. All execution/supervision after this
# is the deterministic scheduler; reporting is tick.sh. Self-removes its cron line.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
D="${SCHED_FLEET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$D/telegram.env"
TG() { curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="$1" >/dev/null 2>&1; }

crontab -l 2>/dev/null | grep -v "reset-fleet/bootstrap.sh" | crontab -

npm i -g @ai-dossier/cli@latest >/dev/null 2>&1
cd "$HOME/projects/ai-dossier/main" || { TG "❌ reset-fleet: repo missing on hcc2"; exit 1; }

SD="$HOME/.dossier/sched/imboard-ai-ai-dossier"
mkdir -p "$SD"
cat > "$SD/config.json" <<'CFG'
{
  "schema_version": "1.2.0",
  "max_slots": 2,
  "stall_timeout_ms": 3600000,
  "dispatch": {
    "command": ["claude", "-p", "--output-format", "json", "--model", "{model}"],
    "tier_models": {
      "mechanical": "haiku",
      "mid": "sonnet",
      "strong": "opus"
    },
    "prompt": "Run the full-cycle-issue workflow for GitHub issue #{issue} in this repository (imboard-ai/ai-dossier).\n\nBegin by fetching the workflow: ai-dossier run imboard-ai/git/full-cycle-issue --pull\n\nExecute it for issue #{issue} with ship_mode=attached (the default): follow every phase — gate, setup, plan, implement, review, ship, report — without asking questions. This repo has NO auto-merge watcher: ship self-merges per ship-issue Step 6, then confirm the publish-packages workflow carried the merge commit, complete teardown, and post the report. Remember this repo requires a version bump in any publishable package whose src/ changed (CI fails the PR otherwise).\n\nIMPORTANT — this is a HEADLESS session: never end the session while a command you still need (build, test, ci-parity, CI wait) is running. Run long commands in the FOREGROUND and wait for them, or poll with sleep loops until completion. Exiting while 'waiting' on a background process abandons the run."
  }
}
CFG

Q() { ai-dossier sched enqueue --project imboard-ai-ai-dossier --tier mid "$@" >> "$D/enqueue.log" 2>&1; }
Q --issues 496
Q --issues 500 --deps 496
Q --issues 505 --deps 500
Q --issues 507 --deps 505

( crontab -l 2>/dev/null | grep -v "reset-fleet/tick.sh"; \
  echo "*/2 * * * * $HOME/.dossier/reset-fleet/tick.sh >> $HOME/.dossier/reset-fleet/tick.log 2>&1" ) | crontab -

TG "🚀 Claude weekly reset — enqueued #496→#500→#505→#507 into dossier-sched on hcc2 (serial dep chain, sonnet mid-tier, opus only on stall escalation, attached ship). Engine ticks every 2 min via cron; zero LLM supervision. Epic: https://github.com/imboard-ai/ai-dossier/issues/474"
