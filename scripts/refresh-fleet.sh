#!/usr/bin/env bash
# refresh-fleet.sh — push the latest CLI, dossiers and skills to every machine.
#
# Run this from **wls**, which is the only host with ssh reach to the others.
#
#   bash scripts/refresh-fleet.sh                    # CLI + default dossier/skill set
#   bash scripts/refresh-fleet.sh --cli-only         # just bump the CLI everywhere
#   bash scripts/refresh-fleet.sh --hosts wls,hcc    # subset of machines
#   bash scripts/refresh-fleet.sh imboard-ai/git/ship-issue   # extra targets, appended
#
# WHY THIS EXISTS
# `ai-dossier run <name> --pull` resolves the newest version at call time, but three things
# do NOT refresh on their own and are what actually go stale:
#   1. the globally installed CLI (an old CLI lints against an old schema and signs wrong)
#   2. the local dossier cache
#   3. installed Claude Code skills and their opencode wrappers
#
# TRAPS THIS AVOIDS (each one cost real time before)
# - A repo-local `node_modules/.bin/ai-dossier` or stray `~/node_modules` SHADOWS the global
#   install. We resolve the global binary explicitly and print the version we actually used.
# - Remote non-login shells have no nvm on PATH, so `ssh host 'ai-dossier …'` fails with
#   "command not found". Every remote command sources nvm first.
# - A step that prints nothing is NOT a step that succeeded. Every step reports ok/FAIL, and
#   the script exits non-zero if any host had any failure.
# - An `ok` on the install step does NOT mean the host is current (#696): a host can
#   install "successfully" and still resolve the previous release. The version step
#   therefore prints installed=<ver> latest=<ver> and flags BEHIND as a failure.

set -uo pipefail

HOSTS_DEFAULT="wls,hcc,hcc2"
HOSTS="$HOSTS_DEFAULT"
CLI_ONLY=0
EXTRA_TARGETS=()

# The dossiers and skills worth force-refreshing everywhere. Skills are installed AND
# wrapper-synced; plain dossiers are pulled into cache.
SKILLS=(
  "imboard-ai/skills/batch-cycle-skill"
  "imboard-ai/skills/fleet-cycle-skill"
)
DOSSIERS=(
  "imboard-ai/git/member-cycle"
  "imboard-ai/git/batch-integrate"
  "imboard-ai/git/batch-issues-preparation"
  "imboard-ai/git/issue-cycle-classifier"
  "imboard-ai/git/full-cycle-issue"
)

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) CLI_ONLY=1 ;;
    --hosts) HOSTS="${2:?--hosts needs a comma-separated list}"; shift ;;
    --hosts=*) HOSTS="${1#*=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) EXTRA_TARGETS+=("$1") ;;
  esac
  shift
done

# Resolve the GLOBAL cli, never a shadowed one, and source nvm on non-login shells.
REMOTE_PRELUDE='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1;
AD="$(npm root -g 2>/dev/null)/@ai-dossier/cli/bin/ai-dossier";
[ -x "$AD" ] || AD="$(command -v ai-dossier || true)";
[ -n "$AD" ] || { echo "    FAIL: no ai-dossier binary found"; exit 90; }'

declare -A HOST_STATUS
FAILED=0

# $1 >= $2 ? (semver-ish; same comparison as fleet-cli-audit.sh)
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# Resolve npm latest ONCE on the driving host; every host is compared against it
# (#696). A lookup failure must not fail the refresh — hosts then report
# installed=<ver> with the comparison explicitly skipped.
LATEST=$(npm view @ai-dossier/cli version 2>/dev/null)

run_on() {  # run_on <host> <label> <command>
  local host="$1" label="$2" cmd="$3" out rc
  if [ "$host" = "wls" ] || [ "$host" = "$(hostname)" ]; then
    out=$(bash -lc "$REMOTE_PRELUDE
$cmd" 2>&1); rc=$?
  else
    out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$REMOTE_PRELUDE
$cmd" 2>&1); rc=$?
  fi
  if [ $rc -eq 0 ]; then
    echo "    ok   $label"
  else
    echo "    FAIL $label (exit $rc)"
    echo "$out" | tail -4 | sed 's/^/         /'
    HOST_STATUS[$host]="fail"; FAILED=1
  fi
}

echo "refresh-fleet: hosts=$HOSTS  cli_only=$CLI_ONLY"
echo

IFS=',' read -r -a HOST_LIST <<< "$HOSTS"
for host in "${HOST_LIST[@]}"; do
  echo "== $host =="
  HOST_STATUS[$host]="${HOST_STATUS[$host]:-ok}"

  # Prove the host answers before attributing later failures to content.
  if [ "$host" != "wls" ] && [ "$host" != "$(hostname)" ]; then
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" true 2>/dev/null; then
      echo "    FAIL unreachable over ssh — skipping"
      HOST_STATUS[$host]="unreachable"; FAILED=1; echo; continue
    fi
  fi

  run_on "$host" "npm i -g @ai-dossier/cli@latest" 'npm i -g @ai-dossier/cli@latest >/dev/null 2>&1'

  # Capture the version actually installed and compare it against npm latest —
  # `ok` must mean "current", not "the command ran" (#696).
  if [ "$host" = "wls" ] || [ "$host" = "$(hostname)" ]; then
    inst=$(bash -lc "$REMOTE_PRELUDE
\"\$AD\" --version" 2>/dev/null | tail -1); rc=$?
  else
    inst=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$REMOTE_PRELUDE
\"\$AD\" --version" 2>/dev/null | tail -1); rc=$?
  fi
  if [ $rc -ne 0 ] || [ -z "$inst" ]; then
    echo "    FAIL cli version (binary did not report a version)"
    HOST_STATUS[$host]="fail"; FAILED=1
  elif [ -n "$LATEST" ] && ! ver_ge "$inst" "$LATEST"; then
    echo "    WARN cli version installed=$inst latest=$LATEST — BEHIND (npm still has the previous release, or the install landed under a different node)"
    HOST_STATUS[$host]="behind"; FAILED=1
  elif [ -n "$LATEST" ]; then
    echo "    ok   cli version installed=$inst latest=$LATEST"
  else
    echo "    ok   cli version installed=$inst latest=unknown (npm view failed on the driving host; comparison skipped)"
  fi

  if [ "$CLI_ONLY" -eq 0 ]; then
    for d in "${DOSSIERS[@]}" "${EXTRA_TARGETS[@]:-}"; do
      [ -z "$d" ] && continue
      run_on "$host" "pull $d" "\"\$AD\" pull '$d' --force >/dev/null 2>&1"
    done
    for s in "${SKILLS[@]}"; do
      run_on "$host" "install-skill $s" "\"\$AD\" install-skill '$s' --force --fresh >/dev/null 2>&1"
    done
    run_on "$host" "sync-skills (opencode wrappers)" '"$AD" sync-skills >/dev/null 2>&1'
  fi
  echo
done

echo "== summary =="
for host in "${HOST_LIST[@]}"; do
  printf '  %-6s %s\n' "$host" "${HOST_STATUS[$host]:-unknown}"
done
[ "$FAILED" -eq 0 ] && echo "  all hosts refreshed" || echo "  ONE OR MORE HOSTS FAILED — see above"
exit "$FAILED"
