#!/usr/bin/env bash
# refresh-fleet.sh — push the latest CLI, dossiers and skills to every machine.
#
# Run this from **wls**, which is the only host with ssh reach to the others.
#
#   bash scripts/refresh-fleet.sh                    # CLI + default dossier/skill set
#   bash scripts/refresh-fleet.sh --cli-only         # just bump the CLI everywhere
#   bash scripts/refresh-fleet.sh --hosts wls,hcc    # subset of machines
#   bash scripts/refresh-fleet.sh --profiles-file path # use a different profile source
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS_DEFAULT="wls,hcc,hcc2"
HOSTS="$HOSTS_DEFAULT"
CLI_ONLY=0
EXTRA_TARGETS=()
PROFILE_FILE="${SCHED_PROFILE_FILE:-$SCRIPT_DIR/sched-fleet/dispatch-profiles.json}"
PROFILE_PROJECTS="${SCHED_PROFILE_PROJECTS:-imboard-ai-imboard-monorepo}"
PROFILE_FLEET_HOME="${SCHED_PROFILE_FLEET_HOME:-$HOME/.dossier/reset-fleet}"

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
    --profiles-file) PROFILE_FILE="${2:?--profiles-file needs a JSON path}"; shift ;;
    --profiles-file=*) PROFILE_FILE="${1#*=}" ;;
    --profile-projects) PROFILE_PROJECTS="${2:?--profile-projects needs comma-separated scheduler slugs}"; shift ;;
    --profile-projects=*) PROFILE_PROJECTS="${1#*=}" ;;
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

# Profiles are intentionally the only scheduler config this script distributes.
# Slots, paths, timers, pool state, and prompts remain host-local. The checked-in
# source is also copied beside the reset bootstrap so a future reset cannot lose
# the profile set; callers can point at another JSON file with --profiles-file when
# a deployment has its own provider ladders.
PROFILE_B64=""
PROFILE_SYNC_CMD=""
if [ "$CLI_ONLY" -eq 0 ]; then
  if [ ! -f "$PROFILE_FILE" ]; then
    echo "FAIL: dispatch profile source not found: $PROFILE_FILE" >&2
    exit 2
  fi
  if [[ ! "$PROFILE_PROJECTS" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(,[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$ ]]; then
    echo "FAIL: --profile-projects must be comma-separated scheduler slugs" >&2
    exit 2
  fi
  PROFILE_B64=$(PROFILE_FILE="$PROFILE_FILE" node <<'NODE' 2>/dev/null
const fs = require("node:fs");
const tiers = new Set(["mechanical", "mid", "strong"]);
const profileName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
const tierSpec = (name, value) => {
  if (!plain(value)) throw new Error(`invalid tier spec: ${name}`);
  for (const key of Object.keys(value)) {
    if (!["command", "model", "prompt"].includes(key)) throw new Error(`unknown tier key: ${name}.${key}`);
  }
  if (value.command !== undefined && !strings(value.command)) throw new Error(`invalid command: ${name}`);
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length === 0)) throw new Error(`invalid model: ${name}`);
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length === 0)) throw new Error(`invalid prompt: ${name}`);
};
const validateProfile = (name, value) => {
  if (!plain(value)) throw new Error(`invalid dispatch profile: ${name}`);
  for (const key of Object.keys(value)) {
    if (!["command", "prompt", "tier_models", "tiers"].includes(key)) throw new Error(`unknown profile key: ${name}.${key}`);
  }
  if (value.command !== undefined && !strings(value.command)) throw new Error(`invalid command: ${name}`);
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length === 0)) throw new Error(`invalid prompt: ${name}`);
  if (value.tier_models !== undefined) {
    if (!plain(value.tier_models)) throw new Error(`invalid tier_models: ${name}`);
    for (const [tier, model] of Object.entries(value.tier_models)) {
      if (!tiers.has(tier) || typeof model !== "string" || model.length === 0) throw new Error(`invalid tier_models entry: ${name}.${tier}`);
    }
  }
  if (value.tiers !== undefined) {
    if (!plain(value.tiers)) throw new Error(`invalid tiers: ${name}`);
    for (const [tier, spec] of Object.entries(value.tiers)) {
      if (!tiers.has(tier)) throw new Error(`invalid tier: ${name}.${tier}`);
      tierSpec(`${name}.${tier}`, spec);
    }
  }
};
const value = JSON.parse(fs.readFileSync(process.env.PROFILE_FILE, "utf8"));
if (!plain(value) || Object.keys(value).length === 0) throw new Error("profile source must be a non-empty object");
for (const [name, profile] of Object.entries(value)) {
  if (!profileName.test(name)) throw new Error(`invalid profile name: ${name}`);
  validateProfile(name, profile);
}
process.stdout.write(Buffer.from(JSON.stringify(value)).toString("base64"));
NODE
  )
  rc=$?
  if [ $rc -ne 0 ] || [ -z "$PROFILE_B64" ]; then
    echo "FAIL: dispatch profile source is not valid JSON: $PROFILE_FILE" >&2
    exit 2
  fi
  PROFILE_FLEET_HOME_B64=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' "$PROFILE_FLEET_HOME")
  # Use base64 payloads so profile JSON and deployment paths never become shell
  # syntax on a remote host. The remote command validates the target objects,
  # writes the source beside bootstrap, and atomically replaces each config.
  PROFILE_SYNC_SCRIPT='const fs=require("node:fs"),path=require("node:path"),os=require("node:os");const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);const profiles=JSON.parse(Buffer.from(process.env.SCHED_PROFILE_B64,"base64").toString("utf8"));if(!plain(profiles)||Object.keys(profiles).length===0)throw new Error("profile source must be a non-empty object");const fleetDir=Buffer.from(process.env.SCHED_PROFILE_FLEET_HOME_B64,"base64").toString("utf8");const root=path.resolve(os.homedir(),".dossier","sched");const writeAtomic=(file,text,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=path.join(path.dirname(file),`.${path.basename(file)}.${process.pid}.tmp`);try{fs.writeFileSync(temp,text,{encoding:"utf8",mode:mode??0o644});if(mode!==undefined)fs.chmodSync(temp,mode);fs.renameSync(temp,file)}finally{try{fs.unlinkSync(temp)}catch{}}};const updates=[];for(const project of process.env.SCHED_PROFILE_PROJECTS.split(",")){const file=path.resolve(root,project,"config.json");if(!file.startsWith(`${root}${path.sep}`))throw new Error(`scheduler path escapes root: ${project}`);if(!fs.existsSync(file))throw new Error(`missing scheduler config: ${file}`);const config=JSON.parse(fs.readFileSync(file,"utf8"));if(!plain(config)||(config.dispatch!==undefined&&!plain(config.dispatch)))throw new Error(`invalid scheduler config: ${file}`);const mode=fs.statSync(file).mode&0o777;updates.push([file,JSON.stringify({...config,dispatch:{...(config.dispatch||{}),dispatch_profiles:profiles},},null,2)+"\n",mode])};const source=path.join(fleetDir,"dispatch-profiles.json");const sourceMode=fs.existsSync(source)?fs.statSync(source).mode&0o777:0o644;writeAtomic(source,JSON.stringify(profiles,null,2)+"\n",sourceMode);for(const [file,text,mode] of updates)writeAtomic(file,text,mode);'
  PROFILE_SYNC_CMD="SCHED_PROFILE_B64='$PROFILE_B64' SCHED_PROFILE_PROJECTS='$PROFILE_PROJECTS' SCHED_PROFILE_FLEET_HOME_B64='$PROFILE_FLEET_HOME_B64' node -e '$PROFILE_SYNC_SCRIPT'"
fi

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
    out=$(bash -lc "$REMOTE_PRELUDE
\"\$AD\" --version" 2>&1); rc=$?
  else
    out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$REMOTE_PRELUDE
\"\$AD\" --version" 2>&1); rc=$?
  fi
  # The version is the last non-empty line; nvm/banner noise lands above it.
  inst=$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)
  if [ $rc -ne 0 ] || [ -z "$inst" ]; then
    echo "    FAIL cli version (exit $rc — binary did not report a version)"
    printf '%s\n' "$out" | tail -4 | sed 's/^/         /'
    HOST_STATUS[$host]="fail"; FAILED=1
  elif ! printf '%s' "$inst" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]*)?$'; then
    echo "    FAIL cli version (unparseable version output: $inst)"
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
    run_on "$host" "sync dispatch profiles ($PROFILE_PROJECTS)" "$PROFILE_SYNC_CMD"
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
