#!/usr/bin/env bash
# refresh-fleet.sh — push the latest CLI, dossiers and every imboard-ai skill to every machine.
#
# Run this from the one host that has ssh reach to the others (the "local" host).
#
# Config (env): REFRESH_FLEET_HOSTS = default comma-separated host list (default: localhost);
#               REFRESH_FLEET_LOCAL_HOST = the name that denotes this machine in that list (default: localhost).
#
#   bash scripts/refresh-fleet.sh                    # CLI + dispatch profiles + default dossiers + every imboard-ai registry skill
#   bash scripts/refresh-fleet.sh --cli-only         # just bump the CLI everywhere
#   bash scripts/refresh-fleet.sh --hosts host-a,host-b    # subset of machines
#   bash scripts/refresh-fleet.sh --profiles-file path # use a different profile source
#   bash scripts/refresh-fleet.sh --profile-projects a,b # also sync per-project scheduler profile maps
#   bash scripts/refresh-fleet.sh --usage-sync       # afterwards merge the per-host token ledgers (#782)
#   bash scripts/refresh-fleet.sh imboard-ai/git/ship-issue   # extra dossiers to pull, appended
#
# WHY THIS EXISTS
# `ai-dossier run <name> --pull` resolves the newest version at call time, but three things
# do NOT refresh on their own and are what actually go stale:
#   1. the globally installed CLI (an old CLI lints against an old schema and signs wrong)
#   2. the local dossier cache
#   3. installed Claude Code skills and their opencode wrappers
#
# SKILLS ARE NOT LISTED HERE
# Skill refresh is `ai-dossier install-skill --all --owner imboard-ai --fresh` on each host
# (CLI >= 0.82.0, #955/#956): it installs every registry skill the owner publishes (a
# dossier named *-skill or tagged `skill`), so a newly published skill needs no edit to this
# script. It also writes the opencode wrapper for each skill it installs (on hosts where opencode
# is installed); it does NOT prune
# orphaned wrappers or wrap skills from other owners (the old separate `sync-skills` step
# did) — run `ai-dossier sync-skills` by hand if that is needed. Hosts with an older CLI fail
# that step with a clear message. A skill-level failure fails the host; a collision (two
# registry skills sharing a basename, or a skills dir holding a different dossier) is never
# overwritten — it is printed as a WARN line, flagged in the per-host summary and the final
# line, but does not fail the run, because refreshing again cannot fix it. `--force` is
# deliberately NOT passed, so a collision can never be silently overwritten. An install that
# reports zero skills is treated as a failure (registry unreachable or owner filter wrong).
#
# TRAPS THIS AVOIDS (each one cost real time before)
# - A repo-local `node_modules/.bin/ai-dossier` or stray `~/node_modules` SHADOWS the global
#   install. We resolve the global binary explicitly and print the version we actually used.
# - Remote non-login shells have no nvm on PATH, so `ssh host 'ai-dossier …'` fails with
#   "command not found". Every remote command sources nvm first.
# - A step that prints nothing is NOT a step that succeeded. Every step reports ok/WARN/FAIL
#   (a WARN on the skill step is a collision, which does not fail the run), and
#   the script exits non-zero if any host had any failure.
# - An `ok` on the install step does NOT mean the host is current (#696): a host can
#   install "successfully" and still resolve the previous release. The version step
#   therefore prints installed=<ver> latest=<ver> and flags BEHIND as a failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_HOST="${REFRESH_FLEET_LOCAL_HOST:-localhost}"
HOSTS_DEFAULT="${REFRESH_FLEET_HOSTS:-localhost}"
HOSTS="$HOSTS_DEFAULT"
CLI_ONLY=0
USAGE_SYNC=0
EXTRA_TARGETS=()
PROFILE_FILE="${SCHED_PROFILE_FILE:-$SCRIPT_DIR/sched-fleet/dispatch-profiles.json}"
BOOTSTRAP_FILE="${SCHED_BOOTSTRAP_FILE:-$SCRIPT_DIR/sched-fleet/bootstrap.sh}"
CRON_LIB_FILE="${SCHED_CRON_LIB_FILE:-$SCRIPT_DIR/sched-fleet/cron-lib.sh}"
PROFILE_PROJECTS="${SCHED_PROFILE_PROJECTS:-}"
PROFILE_FLEET_HOME="${SCHED_PROFILE_FLEET_HOME:-$HOME/.dossier/reset-fleet}"

# Registry owner whose skills are installed via `install-skill --all`, and the first CLI
# release that has --all / --owner / --json batch output.
SKILL_OWNER="imboard-ai"
MIN_SKILL_CLI="0.82.0"
SEMVER_RE='^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]*)?$'

# The dossiers worth force-refreshing into the cache everywhere (skills come from
# `install-skill --all`, not from a list).
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
    --usage-sync) USAGE_SYNC=1 ;;
    --hosts) HOSTS="${2:?--hosts needs a comma-separated list}"; shift ;;
    --hosts=*) HOSTS="${1#*=}" ;;
    --profiles-file) PROFILE_FILE="${2:?--profiles-file needs a JSON path}"; shift ;;
    --profiles-file=*) PROFILE_FILE="${1#*=}" ;;
    --profile-projects) PROFILE_PROJECTS="${2:?--profile-projects needs comma-separated scheduler slugs}"; shift ;;
    --profile-projects=*) PROFILE_PROJECTS="${1#*=}" ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) EXTRA_TARGETS+=("$1") ;;
  esac
  shift
done

for target in "${EXTRA_TARGETS[@]}"; do
  if [[ ! "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "unknown target syntax: $target (expected owner/category/name)" >&2
    exit 2
  fi
done
if [[ ! "$HOSTS" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(,[A-Za-z0-9][A-Za-z0-9._-]{0,62})*$ ]]; then
  echo "invalid --hosts value: $HOSTS (expected comma-separated SSH host names)" >&2
  exit 2
fi

# Resolve the GLOBAL cli, never a shadowed one, and source nvm on non-login shells.
REMOTE_PRELUDE='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1;
AD="$(npm root -g 2>/dev/null)/@ai-dossier/cli/bin/ai-dossier";
[ -x "$AD" ] || AD="$(command -v ai-dossier || true)";
[ -n "$AD" ] || { echo "    FAIL: no ai-dossier binary found"; exit 90; }'

declare -A HOST_STATUS
FAILED=0
COLLISION_HOSTS=0

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
  if [ ! -f "$BOOTSTRAP_FILE" ]; then
    echo "FAIL: reset bootstrap not found: $BOOTSTRAP_FILE" >&2
    exit 2
  fi
  if [ ! -f "$CRON_LIB_FILE" ]; then
    echo "FAIL: cron helper not found: $CRON_LIB_FILE" >&2
    exit 2
  fi
  if [ -n "$PROFILE_PROJECTS" ] && [[ ! "$PROFILE_PROJECTS" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(,[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$ ]]; then
    echo "FAIL: --profile-projects must be comma-separated scheduler slugs" >&2
    exit 2
  fi
  PROFILE_B64=$(PROFILE_FILE="$PROFILE_FILE" node <<'NODE'
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
  BOOTSTRAP_B64=$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64"))' "$BOOTSTRAP_FILE")
  if [ -z "$BOOTSTRAP_B64" ]; then
    echo "FAIL: reset bootstrap source is empty: $BOOTSTRAP_FILE" >&2
    exit 2
  fi
  CRON_LIB_B64=$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64"))' "$CRON_LIB_FILE")
  if [ -z "$CRON_LIB_B64" ]; then
    echo "FAIL: cron helper source is empty: $CRON_LIB_FILE" >&2
    exit 2
  fi
  PROFILE_FLEET_HOME_B64=$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' "$PROFILE_FLEET_HOME")
  # Use base64 payloads so profile JSON and deployment paths never become shell
  # syntax on a remote host. The remote command validates the target objects,
  # writes the source beside bootstrap, and atomically replaces each config.
  PROFILE_SYNC_SCRIPT=$(cat <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
const tiers = new Set(["mechanical", "mid", "strong"]);
const phases = new Set([
  "gate",
  "setup",
  "plan",
  "implement",
  "review",
  "ship",
  "report",
  "batch-setup",
  "batch-validate",
  "batch-review",
  "batch-ship",
  "batch-report",
]);
const schemaVersions = new Set([
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "1.6.0",
  "1.7.0",
  "1.8.0",
  "1.9.0",
]);
const positiveInt = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};
const tierSpec = (name, value) => {
  if (!plain(value)) throw new Error(`invalid tier spec: ${name}`);
  if (value.command !== undefined && !strings(value.command)) throw new Error(`invalid command: ${name}`);
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length === 0)) throw new Error(`invalid model: ${name}`);
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length === 0)) throw new Error(`invalid prompt: ${name}`);
};
const profile = (name, value) => {
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
const dispatch = (name, value) => {
  if (!plain(value)) throw new Error(`invalid dispatch config: ${name}`);
  if (value.command !== undefined && !strings(value.command)) throw new Error(`invalid command: ${name}.command`);
  for (const field of ["prompt", "report_prompt", "fix_prompt", "member_prompt", "batch_tail_prompt", "batch_report_prompt"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`invalid ${field}: ${name}`);
  }
  if (value.suite_command !== undefined && !strings(value.suite_command)) throw new Error(`invalid suite_command: ${name}`);
  if (value.tier_models !== undefined) {
    if (!plain(value.tier_models)) throw new Error(`invalid tier_models: ${name}`);
    for (const [tier, model] of Object.entries(value.tier_models)) {
      if (!tiers.has(tier) || typeof model !== "string" || model.length === 0) throw new Error(`invalid tier_models entry: ${name}.${tier}`);
    }
  }
  for (const key of ["tiers"]) {
    if (value[key] === undefined) continue;
    if (!plain(value[key])) throw new Error(`invalid ${key}: ${name}`);
    for (const [tier, spec] of Object.entries(value[key])) {
      if (!tiers.has(tier)) throw new Error(`invalid tier: ${name}.${tier}`);
      tierSpec(`${name}.${key}.${tier}`, spec);
    }
  }
  if (value.phase_stall_timeout_ms !== undefined) {
    if (!plain(value.phase_stall_timeout_ms)) throw new Error(`invalid phase_stall_timeout_ms: ${name}`);
    for (const [phase, ms] of Object.entries(value.phase_stall_timeout_ms)) {
      if (!phases.has(phase)) throw new Error(`invalid phase: ${name}.${phase}`);
      positiveInt(`${name}.phase_stall_timeout_ms.${phase}`, ms);
    }
  }
  if (value.fence_takeover_timeout_ms !== undefined) positiveInt(`${name}.fence_takeover_timeout_ms`, value.fence_takeover_timeout_ms);
  if (value.disallowed_tools !== undefined && (!Array.isArray(value.disallowed_tools) || value.disallowed_tools.some((tool) => typeof tool !== "string" || tool.length === 0))) {
    throw new Error(`invalid disallowed_tools: ${name}`);
  }
};
const schedulerConfig = (file, value) => {
  if (!plain(value)) throw new Error(`invalid scheduler config: ${file}`);
  if (!schemaVersions.has(String(value.schema_version))) throw new Error(`unsupported schema version: ${file}`);
  if (!Number.isInteger(value.max_slots) || value.max_slots < 1 || value.max_slots > 64) throw new Error(`invalid max_slots: ${file}`);
  for (const field of ["stall_timeout_ms", "reconcile_interval_ms", "pr_poll_interval_ms", "label_poll_interval_ms"]) {
    if (value[field] !== undefined) positiveInt(`${file}.${field}`, value[field]);
  }
  if (value.dispatch !== undefined) dispatch(`${file}.dispatch`, value.dispatch);
  if (value.auto_upgrade !== undefined && typeof value.auto_upgrade !== "boolean") throw new Error(`invalid auto_upgrade: ${file}`);
  if (value.dissolve_policy !== undefined) {
    if (!plain(value.dissolve_policy) || typeof value.dissolve_policy.fraction !== "number" || !Number.isFinite(value.dissolve_policy.fraction) || value.dissolve_policy.fraction <= 0 || value.dissolve_policy.fraction > 1) throw new Error(`invalid dissolve_policy: ${file}`);
    positiveInt(`${file}.dissolve_policy.min_evictions_before_dissolve`, value.dissolve_policy.min_evictions_before_dissolve);
  }
  if (value.default_batch_priority !== undefined && !Number.isInteger(value.default_batch_priority)) throw new Error(`invalid default_batch_priority: ${file}`);
};
const profiles = JSON.parse(Buffer.from(process.env.SCHED_PROFILE_B64, "base64").toString("utf8"));
if (!plain(profiles) || Object.keys(profiles).length === 0) throw new Error("profile source must be a non-empty object");
for (const [name, value] of Object.entries(profiles)) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid profile name: ${name}`);
  profile(name, value);
}
const bootstrap = Buffer.from(process.env.SCHED_BOOTSTRAP_B64, "base64");
if (bootstrap.length === 0) throw new Error("bootstrap source must be non-empty");
const cronLib = Buffer.from(process.env.SCHED_CRON_LIB_B64, "base64");
if (cronLib.length === 0) throw new Error("cron helper source must be non-empty");
const fleetDir = Buffer.from(process.env.SCHED_PROFILE_FLEET_HOME_B64, "base64").toString("utf8");
const root = path.resolve(os.homedir(), ".dossier", "sched");
const userConfigFile = path.resolve(os.homedir(), ".dossier", "config.json");
const writeAtomic = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, data, { mode: mode ?? 0o644 });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
};
const updates = [];
let userConfig = {};
let userConfigMode = 0o600;
if (fs.existsSync(userConfigFile)) {
  userConfig = JSON.parse(fs.readFileSync(userConfigFile, "utf8"));
  if (!plain(userConfig)) throw new Error(`invalid user config: ${userConfigFile}`);
  userConfigMode = fs.statSync(userConfigFile).mode & 0o777;
}
updates.push([userConfigFile, JSON.stringify({ ...userConfig, dispatch_profiles: profiles }, null, 2) + "\n", userConfigMode]);
for (const project of process.env.SCHED_PROFILE_PROJECTS.split(",").filter(Boolean)) {
  const file = path.resolve(root, project, "config.json");
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`scheduler path escapes root: ${project}`);
  if (!fs.existsSync(file)) throw new Error(`missing scheduler config: ${file}`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  schedulerConfig(file, config);
  const mode = fs.statSync(file).mode & 0o777;
  updates.push([file, JSON.stringify({ ...config, dispatch: { ...(config.dispatch || {}), dispatch_profiles: profiles } }, null, 2) + "\n", mode]);
}
const source = path.join(fleetDir, "dispatch-profiles.json");
const sourceMode = fs.existsSync(source) ? fs.statSync(source).mode & 0o777 : 0o644;
writeAtomic(source, JSON.stringify(profiles, null, 2) + "\n", sourceMode);
const bootstrapPath = path.join(fleetDir, "bootstrap.sh");
const bootstrapMode = fs.existsSync(bootstrapPath) ? fs.statSync(bootstrapPath).mode & 0o777 : 0o755;
writeAtomic(bootstrapPath, bootstrap, bootstrapMode);
const cronLibPath = path.join(fleetDir, "cron-lib.sh");
const cronLibMode = fs.existsSync(cronLibPath) ? fs.statSync(cronLibPath).mode & 0o777 : 0o644;
writeAtomic(cronLibPath, cronLib, cronLibMode);
for (const [file, text, mode] of updates) writeAtomic(file, text, mode);
NODE
  )
  PROFILE_SYNC_CMD="mkdir -p \"\$HOME/.dossier\" && flock -x \"\$HOME/.dossier/.dispatch-profile-refresh.lock\" env SCHED_PROFILE_B64='$PROFILE_B64' SCHED_PROFILE_PROJECTS='$PROFILE_PROJECTS' SCHED_PROFILE_FLEET_HOME_B64='$PROFILE_FLEET_HOME_B64' SCHED_BOOTSTRAP_B64='$BOOTSTRAP_B64' SCHED_CRON_LIB_B64='$CRON_LIB_B64' node -e '$PROFILE_SYNC_SCRIPT'"
fi

# print_tail <text>: last 4 lines, indented, control characters stripped (remote-controlled).
print_tail() { printf '%s\n' "$1" | tail -4 | LC_ALL=C tr -d '\000-\010\013-\037\177' | sed 's/^/         /'; }

# host_exec <host> <command>: run on the host (local shell for the local host), set OUT and RC.
host_exec() {
  local host="$1" cmd="$2"
  if [ "$host" = "$LOCAL_HOST" ] || [ "$host" = "$(hostname)" ]; then
    OUT=$(bash -lc "$REMOTE_PRELUDE
$cmd" 2>&1); RC=$?
  else
    OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$REMOTE_PRELUDE
$cmd" 2>&1); RC=$?
  fi
}

run_on() {  # run_on <host> <label> <command>
  local host="$1" label="$2" cmd="$3"
  host_exec "$host" "$cmd"
  if [ $RC -eq 0 ]; then
    echo "    ok   $label"
  else
    echo "    FAIL $label (exit $RC)"
    print_tail "$OUT"
    HOST_STATUS[$host]="fail"; FAILED=1
  fi
}

# Parse `install-skill --all --json` output (stdin) into report lines. Prints
# "SUMMARY ok=<n> skipped=<n> failed=<n> collisions=<n>" then one "FAIL|COLLISION <name> — <msg>"
# line per problem row; a single "ERROR <msg>" line (exit 0) when the CLI reported {error} or
# listed zero skills; exits 3 when no JSON document is found.
SKILL_REPORT_JS='
const raw = require("node:fs").readFileSync(0, "utf8");
// The document may be surrounded by stderr noise (merged 2>&1): try every
// line-start "{" against every "}" that ends a line until one parses.
let doc;
const starts = [...raw.matchAll(/^\{/gm)].map((m) => m.index);
const ends = [...raw.matchAll(/\}(?=\n|$)/g)].map((m) => m.index + 1);
for (const st of starts) {
  for (const en of ends) {
    if (en <= st) continue;
    try {
      const d = JSON.parse(raw.slice(st, en));
      if (d && typeof d === "object" && (d.summary || d.error)) { doc = d; break; }
    } catch {}
  }
  if (doc) break;
}
if (!doc) process.exit(3);
// Remote-controlled text: strip control/bidi characters and fold newlines so it cannot
// forge report lines or drive the terminal.
const clean = (v) => String(v ?? "").replace(/\s*\n\s*/g, " / ").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u2028\u2029]/g, "?").slice(0, 300);
const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
if (!doc.summary) { console.log(`ERROR ${clean(doc.error) || "no summary in install-skill output"}`); process.exit(0); }
const s = doc.summary;
if (n(s.ok) + n(s.skipped) + n(s.failed) + n(s.collisions) === 0) {
  console.log("ERROR registry listed no skills for the owner (registry unreachable or owner filter wrong)");
  process.exit(0);
}
console.log(`SUMMARY ok=${n(s.ok)} skipped=${n(s.skipped)} failed=${n(s.failed)} collisions=${n(s.collisions)}`);
const rows = Array.isArray(doc.results) ? doc.results.filter((r) => r && typeof r === "object") : [];
for (const r of rows) {
  if (r.status === "failed") console.log(`FAIL ${clean(r.name)} — ${clean(r.message) || "install failed"}`);
  if (r.status === "collision") console.log(`COLLISION ${clean(r.name)} — ${clean(r.message) || "collision"}`);
}
if (n(s.failed) > rows.filter((r) => r.status === "failed").length) {
  console.log(`FAIL (summary) — summary.failed=${n(s.failed)} but fewer failed rows were reported`);
}
'

# refresh_skills <host> <cli-version>: install every $SKILL_OWNER skill via --all.
refresh_skills() {
  local host="$1" inst="$2" label="install-skill --all --owner $SKILL_OWNER" report line
  if ! ver_ge "$inst" "$MIN_SKILL_CLI"; then
    echo "    FAIL $label — host CLI $inst is older than $MIN_SKILL_CLI (needs install-skill --all); upgrade the CLI on $host"
    HOST_STATUS[$host]="fail"; FAILED=1; return
  fi
  host_exec "$host" "\"\$AD\" install-skill --all --owner '$SKILL_OWNER' --fresh --json"
  local perr; perr=$(mktemp)
  report=$(printf '%s\n' "$OUT" | node -e "$SKILL_REPORT_JS" 2>"$perr"); local prc=$?
  if [ $prc -ne 0 ] && [ $prc -ne 3 ]; then
    echo "    FAIL $label (report parser crashed, exit $prc: $(head -1 "$perr" | cut -c1-200))"
    rm -f "$perr"; HOST_STATUS[$host]="fail"; FAILED=1; return
  fi
  rm -f "$perr"
  if [ $prc -ne 0 ] || [ -z "$report" ]; then
    echo "    FAIL $label (exit $RC — no parseable JSON output)"
    print_tail "$OUT"
    HOST_STATUS[$host]="fail"; FAILED=1; return
  fi
  local summary problems=0 collisions=0
  summary=$(printf '%s\n' "$report" | sed -n 's/^SUMMARY //p')
  if printf '%s\n' "$report" | grep -q '^ERROR '; then
    echo "    FAIL $label — $(printf '%s\n' "$report" | sed -n 's/^ERROR //p' | head -1)"
    HOST_STATUS[$host]="fail"; FAILED=1; return
  fi
  while IFS= read -r line; do
    case "$line" in
      FAIL\ *) echo "    FAIL skill ${line#FAIL }"; problems=1 ;;
      COLLISION\ *) echo "    WARN skill collision ${line#COLLISION } (not overwritten)"; collisions=$((collisions + 1)) ;;
    esac
  done <<< "$report"
  # The CLI exits 1 on any failure OR collision and nothing else. Exit 0 with a failing row,
  # or any other non-zero exit (ssh drop 255, SIGKILL 137, ...) — even alongside collision
  # rows — means something else went wrong and must not read as ok.
  if [ $problems -eq 0 ] && [ $RC -ne 0 ] && { [ $RC -ne 1 ] || [ $collisions -eq 0 ]; }; then
    echo "    FAIL $label (exit $RC, no failing rows reported)"; problems=1
  fi
  [ $collisions -gt 0 ] && COLLISION_HOSTS=$((COLLISION_HOSTS + 1))
  if [ $problems -ne 0 ]; then
    echo "    FAIL $label ($summary)"
    HOST_STATUS[$host]="fail"; FAILED=1
  elif [ $collisions -gt 0 ]; then
    echo "    ok   $label ($summary) — $collisions collision(s) need manual attention"
    HOST_STATUS[$host]="${HOST_STATUS[$host]} +skill-collisions"
  else
    echo "    ok   $label ($summary)"
  fi
}

echo "refresh-fleet: hosts=$HOSTS  cli_only=$CLI_ONLY"
echo

IFS=',' read -r -a HOST_LIST <<< "$HOSTS"
for host in "${HOST_LIST[@]}"; do
  echo "== $host =="
  HOST_STATUS[$host]="${HOST_STATUS[$host]:-ok}"

  # Prove the host answers before attributing later failures to content.
  if [ "$host" != "$LOCAL_HOST" ] && [ "$host" != "$(hostname)" ]; then
    if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" true 2>/dev/null; then
      echo "    FAIL unreachable over ssh — skipping"
      HOST_STATUS[$host]="unreachable"; FAILED=1; echo; continue
    fi
  fi

  run_on "$host" "npm i -g @ai-dossier/cli@latest" 'npm i -g @ai-dossier/cli@latest'

  # Capture the version actually installed and compare it against npm latest —
  # `ok` must mean "current", not "the command ran" (#696).
  host_exec "$host" '"$AD" --version'; out=$OUT; rc=$RC
  # The version is the last non-empty line; nvm/banner noise lands above it.
  inst=$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)
  inst=${inst#v}
  if [ $rc -ne 0 ] || [ -z "$inst" ]; then
    echo "    FAIL cli version (exit $rc — binary did not report a version)"
    print_tail "$out"
    HOST_STATUS[$host]="fail"; FAILED=1
  elif ! printf '%s' "$inst" | grep -Eq "$SEMVER_RE"; then
    echo "    FAIL cli version (unparseable version output: $(printf '%s' "$inst" | LC_ALL=C tr -d '\000-\037\177' | cut -c1-120))"
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
    run_on "$host" "sync user dispatch profiles" "$PROFILE_SYNC_CMD"
    for d in "${DOSSIERS[@]}" "${EXTRA_TARGETS[@]:-}"; do
      [ -z "$d" ] && continue
      run_on "$host" "pull $d" "\"\$AD\" pull '$d' --force"
    done
    # install-skill --all writes wrappers for the skills it installs; orphan-wrapper pruning
    # (the old sync-skills step) is intentionally gone — see the header.
    if [ "$rc" -eq 0 ] && printf '%s' "$inst" | grep -Eq "$SEMVER_RE"; then
      refresh_skills "$host" "$inst"
    else
      echo "    FAIL install-skill --all --owner $SKILL_OWNER — skipped: host CLI version unknown"
      HOST_STATUS[$host]="fail"; FAILED=1
    fi
  fi
  echo
done

# #782: after every host has the current CLI, exchange the persisted token ledgers so
# each host can answer `usage window --hosts all`. Runs from the driving host, which
# is the only one with ssh reach (usage sync pulls from and pushes to the others).
if [ "$USAGE_SYNC" -eq 1 ]; then
  echo "== usage sync =="
  OTHERS=()
  for host in "${HOST_LIST[@]}"; do
    { [ "$host" = "$LOCAL_HOST" ] || [ "$host" = "$(hostname)" ]; } || OTHERS+=("$host")
  done
  if [ "${#OTHERS[@]}" -eq 0 ]; then
    echo "    skip no remote hosts selected"
  else
    OTHERS_CSV=$(IFS=,; echo "${OTHERS[*]}")
    # HOSTS was validated above; the CSV is interpolated into a shell command, so hold the line here too.
    if [[ ! "$OTHERS_CSV" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(,[A-Za-z0-9][A-Za-z0-9._-]{0,62})*$ ]]; then
      echo "    FAIL invalid host list for usage sync: $OTHERS_CSV"; exit 2
    fi
    out=$(bash -lc "$REMOTE_PRELUDE
\"\$AD\" usage sync --hosts '$OTHERS_CSV'" 2>&1); rc=$?
    printf '%s\n' "$out" | sed 's/^/    /'
    [ $rc -ne 0 ] && FAILED=1
  fi
  echo
fi

echo "== summary =="
for host in "${HOST_LIST[@]}"; do
  printf '  %-6s %s\n' "$host" "${HOST_STATUS[$host]:-unknown}"
done
if [ "$FAILED" -ne 0 ]; then
  echo "  ONE OR MORE HOSTS FAILED — see above"
  [ "$COLLISION_HOSTS" -gt 0 ] && echo "  also: $COLLISION_HOSTS host(s) have skill collisions needing manual attention (see WARN lines)"
elif [ "$COLLISION_HOSTS" -gt 0 ]; then
  echo "  all hosts refreshed — but $COLLISION_HOSTS host(s) have skill collisions needing manual attention (see WARN lines)"
else
  echo "  all hosts refreshed"
fi
exit "$FAILED"
