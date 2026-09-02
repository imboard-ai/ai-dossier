#!/usr/bin/env bash
# Dated one-shot: enqueue the pilot gate-report issue (#529) 7 days after #526 closed.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
D="${SCHED_FLEET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"; source "$D/telegram.env"
crontab -l 2>/dev/null | grep -v "enqueue-report.sh" | crontab -
cd "$HOME/projects/ai-dossier/main" && ai-dossier sched enqueue --project imboard-ai-ai-dossier --issues 529 --tier strong
curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="📊 7-day window elapsed — enqueued #529 (pilot gate report, opus)." >/dev/null 2>&1
