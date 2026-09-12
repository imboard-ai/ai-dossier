#!/usr/bin/env bash
# Shared cron read/modify/write helpers for the reset-fleet scripts.

CRON_READ_ATTEMPTS="${SCHED_CRON_READ_ATTEMPTS:-3}"
CRON_READ_DELAY_SECONDS="${SCHED_CRON_READ_DELAY_SECONDS:-1}"
CRON_LOCK_FILE="${SCHED_CRON_LOCK:-${SCHED_FLEET_HOME:-.}/.cron.lock}"
case "$CRON_READ_ATTEMPTS" in
  ''|*[!0-9]*|0) CRON_READ_ATTEMPTS=3 ;;
esac
case "$CRON_READ_DELAY_SECONDS" in
  ''|*[!0-9]*) CRON_READ_DELAY_SECONDS=1 ;;
esac

read_crontab() {
  local current rc attempt=1
  while [ "$attempt" -le "$CRON_READ_ATTEMPTS" ]; do
    current=$(crontab -l 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s\n' "$current"
      return 0
    fi
    if [[ "$current" == "no crontab for "* ]]; then
      return 0
    fi
    if [ "$attempt" -lt "$CRON_READ_ATTEMPTS" ]; then
      sleep "$CRON_READ_DELAY_SECONDS"
    fi
    attempt=$((attempt + 1))
  done
  printf '%s\n' "$current" >&2
  return "$rc"
}

filter_cron_line() {
  local current filtered rc
  current=$(read_crontab) || return 1
  filtered=$(printf '%s\n' "$current" | grep -vF -- "$1")
  rc=$?
  if [ "$rc" -gt 1 ]; then
    return "$rc"
  fi
  printf '%s\n' "$filtered"
}

with_cron_lock() {
  local lock_fd rc
  if ! exec {lock_fd}>"$CRON_LOCK_FILE"; then
    return 1
  fi
  if ! flock -x "$lock_fd"; then
    eval "exec ${lock_fd}>&-"
    return 1
  fi
  "$@"
  rc=$?
  if ! flock -u "$lock_fd"; then
    rc=1
  fi
  if ! eval "exec ${lock_fd}>&-"; then
    rc=1
  fi
  return "$rc"
}

remove_cron_line_unlocked() {
  local filtered
  filtered=$(filter_cron_line "$1") || return 1
  printf '%s\n' "$filtered" | crontab -
}

remove_cron_line() {
  with_cron_lock remove_cron_line_unlocked "$1"
}

install_cron_line_unlocked() {
  local filtered
  filtered=$(filter_cron_line "$1") || return 1
  printf '%s\n%s\n' "$filtered" "$2" | crontab -
}

install_cron_line() {
  with_cron_lock install_cron_line_unlocked "$1" "$2"
}

# Schedule a retry without replacing an unreadable crontab. The marker prevents
# repeated failures from creating an unbounded queue of at jobs.
schedule_at_retry() {
  local marker="$1" script="$2" log="$3" fleet_home command
  command -v at >/dev/null 2>&1 || return 1
  if [ -e "$marker" ]; then
    return 0
  fi
  (set -C; : > "$marker") 2>/dev/null || return 0
  fleet_home="$(dirname "$marker")"
  printf -v command 'if [ ! -e %q ]; then exit 0; fi; SCHED_FLEET_HOME=%q; export SCHED_FLEET_HOME; rm -f -- %q; exec bash %q >> %q 2>&1' \
    "$marker" "$fleet_home" "$marker" "$script" "$log"
  if ! printf '%s\n' "$command" | at now + 5 minutes >/dev/null 2>&1; then
    rm -f -- "$marker"
    return 1
  fi
}
