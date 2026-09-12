#!/usr/bin/env bash
# Dated one-shot: enqueue the pilot gate-report issue (#529) 7 days after #526 closed.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
D="${SCHED_FLEET_HOME:-$SCRIPT_DIR}"
export SCHED_FLEET_HOME="$D"
export SCHED_CRON_LOCK="${SCHED_CRON_LOCK:-$D/.cron.lock}"
source "${SCHED_CRON_LIB:-$SCRIPT_DIR/cron-lib.sh}"
source "$D/telegram.env"
REPORT_CRON_MARKER="$D/enqueue-report.sh"
REPORT_RETRY_MARKER="$D/.enqueue-report.retry"
schedule_retry() {
  if install_cron_line "$REPORT_CRON_MARKER" "*/5 * * * * $D/enqueue-report.sh >> $D/enqueue-report.log 2>&1"; then
    rm -f -- "$REPORT_RETRY_MARKER"
    return 0
  fi
  if schedule_at_retry "$REPORT_RETRY_MARKER" "$SCRIPT_PATH" "$D/enqueue-report.log"; then
    printf 'enqueue-report: scheduled a 5-minute retry outside crontab\n' >&2
    return 0
  fi
  return 1
}
report_is_enqueued() {
  local status
  status=$(ai-dossier sched status --project imboard-ai-ai-dossier --json 2>/dev/null) || return 1
  printf '%s\n' "$status" | node -e '
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(0, "utf8"));
const entries = [...(status.queue ?? []), ...(status.failed ?? [])];
const present = entries.some((entry) => entry?.issue === 529 && entry?.status !== "failed");
process.exit(present ? 0 : 1);
'
}

# Read the crontab before mutating scheduler state. If it is unavailable, leave
# the trigger in place and use an independent retry when possible.
if ! read_crontab >/dev/null; then
  if ! schedule_retry; then
    printf 'enqueue-report: could not read its cron entry; refusing to enqueue and could not schedule a retry\n' >&2
  else
    printf 'enqueue-report: could not read its cron entry; refusing to enqueue and retrying in 5 minutes\n' >&2
  fi
  exit 1
fi
if ! cd "$HOME/projects/ai-dossier/main"; then
  if ! schedule_retry; then
    printf 'enqueue-report: repository checkout is unavailable and retry cron could not be installed\n' >&2
  else
    printf 'enqueue-report: repository checkout is unavailable; retrying every 5 minutes\n' >&2
  fi
  exit 1
fi
if ! ai-dossier sched enqueue --project imboard-ai-ai-dossier --issues 529 --tier strong; then
  # A successful enqueue followed by a crontab write failure is retried. Treat
  # the resulting duplicate enqueue as success only after status confirms that
  # #529 is already active or complete; genuine enqueue failures remain retryable.
  if ! report_is_enqueued; then
    if ! schedule_retry; then
      printf 'enqueue-report: scheduler enqueue failed and retry cron could not be installed\n' >&2
    else
      printf 'enqueue-report: scheduler enqueue failed; retrying every 5 minutes\n' >&2
    fi
    exit 1
  fi
fi
if ! remove_cron_line "$REPORT_CRON_MARKER"; then
  if ! schedule_retry; then
    printf 'enqueue-report: enqueue succeeded but its cron entry could not be removed and retry cron could not be installed\n' >&2
  else
    printf 'enqueue-report: enqueue succeeded but its cron entry could not be removed; retrying every 5 minutes\n' >&2
  fi
  exit 1
fi
rm -f -- "$REPORT_RETRY_MARKER"
curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="📊 7-day window elapsed — enqueued #529 (pilot gate report, opus)." >/dev/null 2>&1 || true
