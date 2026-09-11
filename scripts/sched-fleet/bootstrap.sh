#!/usr/bin/env bash
# reset-fleet/bootstrap.sh — fires ONCE at the claude weekly reset (cron 0 4 1 9 *).
# Enqueues issues 496→500→505→507 into dossier-sched (serial dependency chain,
# sonnet tier) and arms the engine tick cron. All execution/supervision after this
# is the deterministic scheduler; reporting is tick.sh. Self-removes its cron line.
set -u
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"
D="${SCHED_FLEET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROFILE_FILE="${SCHED_PROFILE_FILE:-$D/dispatch-profiles.json}"
source "$D/telegram.env"
TG() { curl -s --max-time 20 "https://api.telegram.org/bot${HANEST_TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${HANEST_TELEGRAM_CHAT_ID}" --data-urlencode text="$1" >/dev/null 2>&1; }

crontab -l 2>/dev/null | grep -v "reset-fleet/bootstrap.sh" | crontab -

npm i -g @ai-dossier/cli@latest >/dev/null 2>&1
cd "$HOME/projects/ai-dossier/main" || { TG "❌ reset-fleet: repo missing on hcc2"; exit 1; }

SD="$HOME/.dossier/sched/imboard-ai-ai-dossier"
mkdir -p "$SD"
CONFIG_TMP="$SD/.config.json.bootstrap.$$"
trap 'rm -f "$CONFIG_TMP"' EXIT
cat > "$CONFIG_TMP" <<'CFG'
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

# Keep the reference reset config aligned with the profile source used by
# refresh-fleet.sh. Only dispatch_profiles is copied; this bootstrap's slots,
# prompts, and timers remain deployment-specific.
if [ -f "$PROFILE_FILE" ]; then
  if ! SCHED_CONFIG_FILE="$CONFIG_TMP" PROFILE_FILE="$PROFILE_FILE" node <<'NODE'
const fs = require("node:fs");
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
const config = JSON.parse(fs.readFileSync(process.env.SCHED_CONFIG_FILE, "utf8"));
config.dispatch = { ...(config.dispatch || {}), dispatch_profiles: profiles };
fs.writeFileSync(process.env.SCHED_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
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

Q() { ai-dossier sched enqueue --project imboard-ai-ai-dossier --tier mid "$@" >> "$D/enqueue.log" 2>&1; }
Q --issues 496
Q --issues 500 --deps 496
Q --issues 505 --deps 500
Q --issues 507 --deps 505

( crontab -l 2>/dev/null | grep -v "reset-fleet/tick.sh"; \
  echo "*/2 * * * * $HOME/.dossier/reset-fleet/tick.sh >> $HOME/.dossier/reset-fleet/tick.log 2>&1" ) | crontab -

TG "🚀 Claude weekly reset — enqueued #496→#500→#505→#507 into dossier-sched on hcc2 (serial dep chain, sonnet mid-tier, opus only on stall escalation, attached ship). Engine ticks every 2 min via cron; zero LLM supervision. Epic: https://github.com/imboard-ai/ai-dossier/issues/474"
