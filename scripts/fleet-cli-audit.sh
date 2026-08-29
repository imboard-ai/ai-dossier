#!/usr/bin/env bash
# fleet-cli-audit.sh — audit (and optionally fix) @ai-dossier/cli installs across execution hosts.
#
# Every host that executes dossier runs must resolve ai-dossier >= the telemetry floor
# on its DEFAULT path, or ~/.dossier/runs.jsonl silently loses token/duration fields
# and skews any cross-host cost baseline. Stale copies under other node versions
# shadow the real CLI when a run pins an old node; they are neutralized by renaming
# (never deleted).
#
# Usage:
#   scripts/fleet-cli-audit.sh [--fix] [--target <ver>] [--floor <ver>] <host>...
#   npm run fleet:cli-audit -- [--fix] <host>...
#
#   <host>     "local" for this machine, or any ssh destination (alias / user@host)
#   --fix      install @ai-dossier/cli@<target> into the default npm prefix and
#              rename stale shadow copies to ai-dossier.stale-<their-version>
#   --target   version to install/compare against (default: npm view @ai-dossier/cli version)
#   --floor    minimum acceptable default-path version (default: 0.12.0, first with telemetry)
#
# Exit codes: 0 all hosts at/above floor · 1 at least one host below floor or unreachable.
set -u

FLOOR="0.12.0"
TARGET=""
FIX=0
PAYLOAD=0
HOSTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX=1 ;;
    --target) TARGET="$2"; shift ;;
    --floor) FLOOR="$2"; shift ;;
    --payload) PAYLOAD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) HOSTS+=("$1") ;;
  esac
  shift
done

# $1 >= $2 ?
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# Prepend the binary's own dir so nvm-tree binaries find their sibling `node`
# even when nvm is not on the calling shell's PATH (no system node installed).
bin_ver() { PATH="$(dirname "$1"):$PATH" "$1" --version 2>/dev/null | head -1; }

# ---------------------------------------------------------------------------
# Payload: runs ON a host (locally or shipped over ssh via `bash -s`).
# Prints machine-readable KEY=value lines consumed by the driver below.
# ---------------------------------------------------------------------------
run_payload() {
  local target="$1" floor="$2" fix="$3"
  local default_bin default_ver copies_stale=0 copies_total=0

  # What an agent's login shell actually resolves. Two adjustments:
  # - ignore workspace copies in node_modules/.bin (running via `npm run`
  #   prepends them to PATH — they are not what real shells resolve);
  # - over non-interactive ssh, login shells often skip nvm init — fall back
  #   to sourcing nvm explicitly (what interactive sessions end up with).
  local path_mode="login-shell"
  default_bin=$(bash -lc 'type -aP ai-dossier' 2>/dev/null | grep -v '/node_modules/' | head -1)
  if [ -z "$default_bin" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    default_bin=$(bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; type -aP ai-dossier' 2>/dev/null | grep -v '/node_modules/' | head -1)
    [ -n "$default_bin" ] && path_mode="nvm-fallback (NOT on non-interactive ssh PATH)"
  fi
  if [ -n "$default_bin" ]; then
    default_ver=$(bin_ver "$default_bin")
    echo "PATH_MODE=${path_mode}"
    if [ -z "$default_ver" ]; then
      # Binary present but --version fails: broken install. Show why.
      echo "DEFAULT_BROKEN=$(PATH="$(dirname "$default_bin"):$PATH" "$default_bin" --version 2>&1 | head -2 | tr '\n' ' ')"
    fi
  else
    default_ver=""
  fi

  if [ "$fix" = 1 ]; then
    local inst_out
    inst_out=$(bash -lc "npm i -g @ai-dossier/cli@${target}" 2>&1)
    if [ $? -ne 0 ]; then
      inst_out=$(bash -c ". \"\$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; npm i -g @ai-dossier/cli@${target}" 2>&1)
      [ $? -ne 0 ] && echo "INSTALL_ERROR=$(echo "$inst_out" | grep -m1 -i 'err' || echo "$inst_out" | tail -1)"
    fi
    default_bin=$(bash -lc 'type -aP ai-dossier' 2>/dev/null | grep -v '/node_modules/' | head -1)
    [ -z "$default_bin" ] && [ -s "$HOME/.nvm/nvm.sh" ] \
      && default_bin=$(bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; type -aP ai-dossier' 2>/dev/null | grep -v '/node_modules/' | head -1)
    if [ -n "$default_bin" ]; then
      default_ver=$(bin_ver "$default_bin")
      [ -z "$default_ver" ] && echo "DEFAULT_BROKEN=$(PATH="$(dirname "$default_bin"):$PATH" "$default_bin" --version 2>&1 | head -2 | tr '\n' ' ')"
    fi
  fi

  echo "DEFAULT_BIN=${default_bin:-none}"
  echo "DEFAULT_VER=${default_ver:-none}"

  # Every other copy that could shadow the default.
  local b v
  for b in "$HOME"/.nvm/versions/node/*/bin/ai-dossier /usr/local/bin/ai-dossier /usr/bin/ai-dossier; do
    [ -e "$b" ] || continue
    [ "$b" = "$default_bin" ] && continue
    # A symlink into the same package tree as the default is the same install.
    [ -n "$default_bin" ] && [ "$(readlink -f "$b" 2>/dev/null)" = "$(readlink -f "$default_bin" 2>/dev/null)" ] && continue
    v=$(bin_ver "$b")
    copies_total=$((copies_total + 1))
    if [ -n "$v" ] && ! ver_ge "$v" "$target"; then
      copies_stale=$((copies_stale + 1))
      if [ "$fix" = 1 ]; then
        mv "$b" "${b}.stale-${v}" 2>/dev/null \
          && echo "RENAMED=${b} (${v})" \
          || echo "RENAME_FAILED=${b} (${v})"
      else
        echo "SHADOW=${b} (${v})"
      fi
    else
      echo "COPY=${b} (${v:-unreadable})"
    fi
  done
  echo "COPIES=${copies_total} STALE=${copies_stale}"

  # npm prefix override: `npm i -g` may land in a different node's tree than the active one.
  local prefix node_dir
  prefix=$(bash -lc 'npm config get prefix' 2>/dev/null | tail -1)
  [ -z "$prefix" ] && [ -s "$HOME/.nvm/nvm.sh" ] \
    && prefix=$(bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; npm config get prefix' 2>/dev/null | tail -1)
  node_dir=$(bash -lc 'command -v node' 2>/dev/null | tail -1 | xargs -r dirname | xargs -r dirname)
  echo "NPM_PREFIX=${prefix:-unknown}"
  [ -n "$prefix" ] && [ -n "$node_dir" ] && [ "$prefix" != "$node_dir" ] && echo "PREFIX_OVERRIDE=yes"

  # Telemetry: line count + whether the newest entry carries the 0.12.0+ fields.
  local rl="$HOME/.dossier/runs.jsonl"
  if [ -f "$rl" ]; then
    echo "RUNS_LINES=$(wc -l < "$rl")"
    if tail -1 "$rl" | grep -q '"duration_ms"'; then
      echo "TELEMETRY=yes"
    else
      echo "TELEMETRY=not-yet (no post-upgrade run logged)"
    fi
  else
    echo "RUNS_LINES=0"
    echo "TELEMETRY=no-log-file"
  fi
}

# When invoked as a remote payload, run the audit and exit.
if [ "$PAYLOAD" = 1 ]; then
  run_payload "$TARGET" "$FLOOR" "$FIX"
  exit 0
fi

# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
if [ ${#HOSTS[@]} -eq 0 ]; then
  echo "usage: $0 [--fix] [--target <ver>] [--floor <ver>] <host>...  (host: 'local' or ssh dest)" >&2
  exit 1
fi

if [ -z "$TARGET" ]; then
  TARGET=$(npm view @ai-dossier/cli version 2>/dev/null)
  if [ -z "$TARGET" ]; then
    echo "ERROR: could not resolve latest @ai-dossier/cli from npm; pass --target" >&2
    exit 1
  fi
fi
echo "target=@ai-dossier/cli@${TARGET}  floor=${FLOOR}  fix=${FIX}"
echo

FAILED=0
for host in "${HOSTS[@]}"; do
  echo "== ${host} =="
  if [ "$host" = "local" ] || [ "$host" = "$(hostname)" ]; then
    out=$(run_payload "$TARGET" "$FLOOR" "$FIX")
    rc=$?
  else
    out=$(ssh -o ConnectTimeout=10 "$host" bash -s -- --payload --target "$TARGET" --floor "$FLOOR" $( [ "$FIX" = 1 ] && echo --fix ) < "$0" 2>/dev/null)
    rc=$?
  fi
  if [ $rc -ne 0 ] || [ -z "$out" ]; then
    echo "  UNREACHABLE (ssh/payload failed)"
    FAILED=1
    echo
    continue
  fi
  echo "$out" | sed 's/^/  /'
  dv=$(echo "$out" | sed -n 's/^DEFAULT_VER=//p')
  if [ "$dv" = "none" ] || [ -z "$dv" ] || ! ver_ge "$dv" "$FLOOR"; then
    echo "  RESULT: FAIL (default ${dv:-none} < floor ${FLOOR})"
    FAILED=1
  elif ! ver_ge "$dv" "$TARGET"; then
    echo "  RESULT: OK-BEHIND (default ${dv} < target ${TARGET} — rerun with --fix to upgrade)"
  else
    echo "  RESULT: OK (${dv})"
  fi
  echo
done

[ $FAILED -eq 0 ] && echo "All hosts at/above floor ${FLOOR}." || echo "One or more hosts FAILED the floor check."
exit $FAILED
