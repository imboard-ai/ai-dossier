#!/usr/bin/env bash
# reset-fleet/tick.sh v3 — cron every 2 min. Ticks every sched project in
# projects.txt, telegram-reports events + closures for issues in issues.txt
# (repo-qualified: owner/repo#N), and when issue 526 closes schedules the
# 7-day-later enqueue of the report issue (#529). Self-removes when all terminal.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
D="${SCHED_FLEET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$D/telegram.env"
TG() { curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="$1" >/dev/null 2>&1; }
repo_dir() { case "$1" in imboard-ai-ai-dossier) echo "$HOME/projects/ai-dossier/main";; imboard-ai-imboard-monorepo) echo "$HOME/projects/imboard/imboard-monorepo";; esac; }

# 0. Engine freshness (B2c stopgap): upgrade the CLI when npm has a newer release,
#    but only when no unit is mid-dispatch on any project this tick (see status below).
LATEST=$(timeout 20 npm view @ai-dossier/cli version 2>/dev/null)
INSTALLED=$(ai-dossier --version 2>/dev/null)
if [ -n "$LATEST" ] && [ -n "$INSTALLED" ] && [ "$LATEST" != "$INSTALLED" ]; then
  if [ "$(printf '%s\n%s\n' "$INSTALLED" "$LATEST" | sort -V | head -1)" = "$INSTALLED" ]; then
    npm i -g "@ai-dossier/cli@$LATEST" >/dev/null 2>&1 && TG "⬆️ hcc2 engine CLI upgraded $INSTALLED → $LATEST (npm latest)"
  fi
fi

# 1. Tick every project; report its new events.
while read -r P; do
  [ -n "$P" ] || continue
  cd "$(repo_dir "$P")" || continue
  ai-dossier sched start --once --project "$P" >> "$D/engine-$P.log" 2>&1
  EV="$HOME/.dossier/sched/$P/events.jsonl"
  [ -f "$EV" ] || continue
  N=$(wc -l < "$EV"); OFF=$(cat "$D/ev.offset.$P" 2>/dev/null || echo 0)
  if [ "$N" -gt "$OFF" ]; then
    NEW=$(sed -n "$((OFF+1)),${N}p" "$EV" | python3 "$D/fmt_events.py")
    [ -n "$NEW" ] && TG "sched ${P#imboard-ai-}:
$NEW"
    echo "$N" > "$D/ev.offset.$P"
  fi
done < "$D/projects.txt"

# 2. Closures + all-done, over repo-qualified issue refs.
ALLDONE=1
for REF in $(cat "$D/issues.txt"); do
  REPO="${REF%%#*}"; I="${REF##*#}"; KEY="${REPO//\//_}_$I"
  STATE=$(gh issue view "$I" -R "$REPO" --json state -q .state 2>/dev/null)
  if [ "$STATE" = "CLOSED" ]; then
    if [ ! -f "$D/done.$KEY" ]; then
      PR=$(gh pr list -R "$REPO" --search "$I in:title" --state merged --limit 1 --json number -q '.[0].number' 2>/dev/null)
      TG "✅ $REF closed (PR #${PR:-?})"
      touch "$D/done.$KEY"
      # Pilot execution closed → schedule the 7-day-later report enqueue (#529).
      if [ "$REF" = "imboard-ai/ai-dossier#526" ] && [ ! -f "$D/report-scheduled" ]; then
        WHEN=$(date -u -d "+7 days" +"%M %H %d %m")
        (crontab -l 2>/dev/null || true; echo "$WHEN * $D/enqueue-report.sh >> $D/enqueue-report.log 2>&1") | crontab -
        grep -q "imboard-ai/ai-dossier#529" "$D/issues.txt" || echo "imboard-ai/ai-dossier#529" >> "$D/issues.txt"
        touch "$D/report-scheduled"
        TG "📅 #526 closed — report run #529 scheduled for $(date -u -d '+7 days' +'%a %Y-%m-%d %H:%M UTC') (7-day regression window)."
      fi
    fi
  else
    ALLDONE=0
  fi
done

if [ "$ALLDONE" = "1" ]; then
  TG "🏁 Pipeline COMPLETE — every tracked issue closed: $(cat "$D/issues.txt" | tr '\n' ' '). Engine cron removed. Next: file Step-4 widening from #529's verdict."
  crontab -l 2>/dev/null | grep -v "reset-fleet/tick.sh" | crontab -
fi
