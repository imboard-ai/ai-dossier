#!/usr/bin/env bash
# reset-fleet/bootstrap.sh — fires ONCE at the Claude annual reset (cron 0 4 1 9 *).
# Enqueues issues 496→500→505→507 into dossier-sched (serial dependency chain,
# sonnet tier) and arms the engine tick cron. All execution/supervision after this
# is the deterministic scheduler; reporting is tick.sh. Self-removes its cron line.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
D="${SCHED_FLEET_HOME:-$SCRIPT_DIR}"
export SCHED_FLEET_HOME="$D"
export SCHED_CRON_LOCK="${SCHED_CRON_LOCK:-$D/.cron.lock}"
source "${SCHED_CRON_LIB:-$SCRIPT_DIR/cron-lib.sh}"
PROFILE_FILE="${SCHED_PROFILE_FILE:-$D/dispatch-profiles.json}"
BOOTSTRAP_DONE="$D/bootstrap.completed"
TICK_CRON_MARKER="$D/tick.sh"
BOOTSTRAP_CRON_MARKER="$D/bootstrap.sh"
BOOTSTRAP_RETRY_MARKER="$D/.bootstrap.retry"
if [[ "$D" == *[!A-Za-z0-9_./:-]* ]]; then
  printf 'reset-fleet: SCHED_FLEET_HOME contains cron-unsafe characters: %s\n' "$D" >&2
  exit 2
fi
source "$D/telegram.env"
TG() { curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="$1" >/dev/null 2>&1 || true; }

BOOTSTRAP_COMPLETE=0
schedule_retry() {
  if install_cron_line "$BOOTSTRAP_CRON_MARKER" "*/5 * * * * $D/bootstrap.sh >> $D/bootstrap.log 2>&1"; then
    rm -f -- "$BOOTSTRAP_RETRY_MARKER"
    return 0
  fi
  if schedule_at_retry "$BOOTSTRAP_RETRY_MARKER" "$SCRIPT_PATH" "$D/bootstrap.log"; then
    printf 'reset-fleet: scheduled a 5-minute bootstrap retry outside crontab\n' >&2
    return 0
  fi
  printf 'reset-fleet: could not install the 5-minute bootstrap retry cron\n' >&2
  return 1
}
bootstrap_exit() {
  [ -z "${CONFIG_TMP:-}" ] || rm -f "$CONFIG_TMP"
  [ -z "${MANIFEST_TMP:-}" ] || rm -f "$MANIFEST_TMP"
  [ -z "${STATUS_TMP:-}" ] || rm -f "$STATUS_TMP"
  if [ "$BOOTSTRAP_COMPLETE" -eq 0 ]; then
    schedule_retry
  fi
}
trap bootstrap_exit EXIT

if [ -f "$BOOTSTRAP_DONE" ]; then
  if install_cron_line "$TICK_CRON_MARKER" "*/2 * * * * $D/tick.sh >> $D/tick.log 2>&1" &&
    remove_cron_line "$BOOTSTRAP_CRON_MARKER"; then
    BOOTSTRAP_COMPLETE=1
    exit 0
  fi
  TG "❌ reset-fleet: completed bootstrap marker exists but could not remove bootstrap cron"
  exit 1
fi

if ! npm i -g @ai-dossier/cli@latest; then
  TG "❌ reset-fleet: CLI upgrade failed; bootstrap remains scheduled for retry"
  exit 1
fi
cd "$HOME/projects/ai-dossier/main" || { TG "❌ reset-fleet: repo missing on hcc2"; exit 1; }

SD="$HOME/.dossier/sched/imboard-ai-ai-dossier"
if ! mkdir -p "$SD"; then
  TG "❌ reset-fleet: could not create scheduler state directory at $SD"
  exit 1
fi
CONFIG_TMP="$SD/.config.json.bootstrap.$$"
MANIFEST_TMP="$SD/.bootstrap-manifest.$$.json"
STATUS_TMP="$SD/.bootstrap-status.$$.json"
if ! cat > "$CONFIG_TMP" <<'CFG'
{
  "schema_version": "1.9.0",
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
then
  TG "❌ reset-fleet: could not write scheduler config staging file"
  exit 1
fi

# Keep the host-level profile source aligned with refresh-fleet.sh. Scheduler
# slots, prompts, and timers remain deployment-specific.
if [ -f "$PROFILE_FILE" ]; then
  if ! flock -x "$HOME/.dossier/.dispatch-profile-refresh.lock" env PROFILE_FILE="$PROFILE_FILE" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const tiers = new Set(["mechanical", "mid", "strong"]);
const profileName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
const validateTier = (name, value) => {
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
      validateTier(`${name}.${tier}`, spec);
    }
  }
};
const profiles = JSON.parse(fs.readFileSync(process.env.PROFILE_FILE, "utf8"));
if (!plain(profiles) || Object.keys(profiles).length === 0) throw new Error("profile source must be a non-empty object");
for (const [name, profile] of Object.entries(profiles)) {
  if (!profileName.test(name)) throw new Error(`invalid profile name: ${name}`);
  validateProfile(name, profile);
}
const userConfigFile = path.join(process.env.HOME, ".dossier", "config.json");
let userConfig = {};
if (fs.existsSync(userConfigFile)) {
  userConfig = JSON.parse(fs.readFileSync(userConfigFile, "utf8"));
  if (!plain(userConfig)) throw new Error("invalid user config");
}
fs.mkdirSync(path.dirname(userConfigFile), { recursive: true });
const mode = fs.existsSync(userConfigFile) ? fs.statSync(userConfigFile).mode & 0o600 : 0o600;
const temp = path.join(path.dirname(userConfigFile), `.config.json.bootstrap.${process.pid}.tmp`);
const fd = fs.openSync(temp, "w", mode);
try {
  fs.writeFileSync(fd, JSON.stringify({ ...userConfig, dispatch_profiles: profiles }, null, 2) + "\n");
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(temp, userConfigFile);
NODE
  then
    TG "❌ reset-fleet: invalid dispatch profile source at $PROFILE_FILE"
    exit 1
  fi
else
  TG "❌ reset-fleet: dispatch profile source missing at $PROFILE_FILE"
  exit 1
fi

if ! mv "$CONFIG_TMP" "$SD/config.json"; then
  TG "❌ reset-fleet: could not install scheduler config at $SD/config.json"
  exit 1
fi

if ! cat > "$MANIFEST_TMP" <<'JSON'
{
  "project": "imboard-ai-ai-dossier",
  "entries": [
    { "issue": 496, "tier": "mid" },
    { "issue": 500, "tier": "mid", "deps": [496] },
    { "issue": 505, "tier": "mid", "deps": [500] },
    { "issue": 507, "tier": "mid", "deps": [505] }
  ]
}
JSON
then
  TG "❌ reset-fleet: could not write scheduler enqueue manifest"
  exit 1
fi

if ! ai-dossier sched status --project imboard-ai-ai-dossier --json > "$STATUS_TMP" 2>> "$D/enqueue.log"; then
  TG "❌ reset-fleet: could not read scheduler state; see $D/enqueue.log; bootstrap remains scheduled for retry"
  exit 1
fi

PENDING=$(SCHED_STATUS_FILE="$STATUS_TMP" SCHED_MANIFEST_FILE="$MANIFEST_TMP" node <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.env.SCHED_STATUS_FILE, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(process.env.SCHED_MANIFEST_FILE, 'utf8'));
const present = new Set(
  [...(status.queue ?? []), ...(status.failed ?? [])]
    // Failed entries are terminal and enqueue deliberately replaces them;
    // leave them in the manifest so a retried reset can restart the chain.
    .filter((entry) => entry?.status !== 'failed')
    .map((entry) => entry?.issue)
    .filter((issue) => Number.isInteger(issue))
);
const entries = manifest.entries.filter((entry) => !present.has(entry.issue));
fs.writeFileSync(
  process.env.SCHED_MANIFEST_FILE,
  JSON.stringify({ ...manifest, entries }, null, 2) + '\n'
);
process.stdout.write(String(entries.length));
NODE
)
rc=$?
if [ "$rc" -ne 0 ] || ! [[ "$PENDING" =~ ^[0-9]+$ ]]; then
  TG "❌ reset-fleet: could not reconcile the scheduler enqueue manifest; see $D/enqueue.log; bootstrap remains scheduled for retry"
  exit 1
fi

if [ "$PENDING" -gt 0 ] && ! ai-dossier sched enqueue --project imboard-ai-ai-dossier --from-manifest "$MANIFEST_TMP" >> "$D/enqueue.log" 2>&1; then
  TG "❌ reset-fleet: scheduler enqueue manifest failed; see $D/enqueue.log; bootstrap remains scheduled for retry"
  exit 1
fi

if ! install_cron_line "$TICK_CRON_MARKER" "*/2 * * * * $D/tick.sh >> $D/tick.log 2>&1"; then
  TG "❌ reset-fleet: could not install tick cron; bootstrap remains scheduled for retry"
  exit 1
fi

if ! printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BOOTSTRAP_DONE"; then
  TG "❌ reset-fleet: could not write completion marker; bootstrap remains scheduled for retry"
  exit 1
fi

# Remove this one-shot trigger only after config, enqueue, and tick-cron setup
# have succeeded; a failed run remains retryable.
if ! remove_cron_line "$BOOTSTRAP_CRON_MARKER"; then
  TG "❌ reset-fleet: could not remove bootstrap cron; run completed but will retry"
  exit 1
fi

BOOTSTRAP_COMPLETE=1
TG "🚀 Claude annual reset — enqueued #496→#500→#505→#507 into dossier-sched on hcc2 (serial dep chain, sonnet mid-tier, opus only on stall escalation, attached ship). Engine ticks every 2 min via cron; zero LLM supervision. Epic: https://github.com/imboard-ai/ai-dossier/issues/474"
