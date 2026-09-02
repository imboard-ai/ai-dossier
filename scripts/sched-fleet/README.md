# sched-fleet

The autonomous pipeline that drives an `ai-dossier sched` fleet unattended: ticks the
scheduler on a cron, reports progress to Telegram, watches tracked issues for closure,
and self-upgrades the CLI. This is the exact deployment that drove the RFC-0001 /
batch-pilot rollout ([epic #474](https://github.com/imboard-ai/ai-dossier/issues/474))
on the `hcc2` host, versioned here so a host reset or disk loss doesn't lose the only
copy.

**These scripts are a reference install, not a generic product.** `bootstrap.sh` in
particular is committed exactly as it ran on hcc2 — hardcoded issue numbers, a
hardcoded sched `config.json` — because AC1 for this change is "verbatim from hcc2
with only path/secret generalization." Treat it as a worked example to copy and edit
per deployment, not something to run as-is against your own issues.

## Prerequisites

- `ai-dossier` CLI (`npm i -g @ai-dossier/cli`) authenticated for `ai-dossier sched`
- `gh` (GitHub CLI), authenticated
- `crontab` available (Linux/macOS `cron`)
- Node on `PATH`. The scripts hardcode an nvm path entry
  (`$HOME/.nvm/versions/node/v24.20.0/bin`) that matched the hcc2 install at the time —
  **adjust this in your copy** to wherever your Node lives (or drop it if Node is
  already on the system `PATH`).

## Files

| File | Role |
|---|---|
| `tick.sh` | Cron job, every 2 min: ticks every project in `projects.txt` once, Telegram-reports new scheduler events, watches `issues.txt` for closures, arms the 7-day report hook, self-upgrades the CLI when idle, self-removes its own cron line once every tracked issue is closed |
| `bootstrap.sh` | One-shot: fires at a weekly reset, writes a sched `config.json`, enqueues a fixed dependency chain of issues, arms `tick.sh`'s cron line. **hcc2-specific — edit before reuse.** |
| `enqueue-report.sh` | Dated one-shot, installed by `tick.sh`: fires once 7 days after a tracked issue closes, enqueues the follow-up report issue, then removes its own cron line |
| `fmt_events.py` | Reads scheduler `events.jsonl` lines from stdin, filters to the reportable event types, formats up to 8 lines for a Telegram message |
| `allow-sched.py` | One-off fixer for `~/.claude/settings.json` — normalizes malformed `Bash(ai-dossier sched ...)` permission rules |
| `projects.txt.example` | Template: one sched project slug per line |
| `issues.txt.example` | Template: one `owner/repo#N` issue ref per line |
| `telegram.env.example` | Template: the two env vars every script `source`s for Telegram reporting |

## Setup

```bash
# From wherever you want the fleet to live, e.g. ~/.dossier/sched-fleet/
cp scripts/sched-fleet/{tick.sh,bootstrap.sh,enqueue-report.sh,fmt_events.py,allow-sched.py} .
cp scripts/sched-fleet/projects.txt.example projects.txt      # edit to your projects
cp scripts/sched-fleet/issues.txt.example issues.txt          # edit to your tracked issues
cp scripts/sched-fleet/telegram.env.example telegram.env      # fill in real values
chmod 600 telegram.env
chmod +x tick.sh bootstrap.sh enqueue-report.sh
```

Each script resolves its own directory as `D` (overridable via `SCHED_FLEET_HOME`), so
they work from any location as long as `projects.txt`, `issues.txt`, and `telegram.env`
sit alongside them (or `SCHED_FLEET_HOME` points at that directory).

`tick.sh`'s `repo_dir()` function maps each `projects.txt` slug to an absolute repo
checkout path — it is a hardcoded case statement, not data-driven. Add a case arm per
project before ticking it.

## Cron install

The hcc2 reference install runs:

```cron
0 4 1 9 *  /path/to/bootstrap.sh >> /path/to/bootstrap.log 2>&1
```

(fires once at a specific weekly Claude-usage reset — adjust the schedule to your own
reset cadence). `bootstrap.sh` then arms `tick.sh`'s own cron line
(`*/2 * * * * .../tick.sh`) itself; you never install that one by hand.

### The `crontab -l` / empty-crontab trap

**Do not add `set -e` to these scripts.** `crontab -l` exits non-zero and prints
`no crontab for <user>` on a host with no existing crontab. Combined with `set -e`,
that non-zero exit would abort the script *inside* the
`crontab -l 2>/dev/null | grep -v ... | crontab -` pipeline before the new line gets
appended — silently **replacing the existing crontab with an empty one** instead of
preserving it. This bit a real reset-fleet run (see `docs/agent-traps.md`, row
`no crontab for`). All three scripts here use `set -u` only, and always route
`crontab -l` through `2>/dev/null` before piping — keep it that way if you edit them.

## Multi-project ticking

`tick.sh` reads `projects.txt` line by line, `cd`s into each project's repo (via
`repo_dir()`), and runs `ai-dossier sched start --once --project <slug>` once per tick.
New scheduler events since the last tick (tracked in a per-project `ev.offset.<slug>`
file next to the scripts) are piped through `fmt_events.py` and sent to Telegram as one
message per project with new events.

## Telegram reporting

Every script sources `telegram.env` for `HANEST_TELEGRAM_BOT_TOKEN` and
`HANEST_TELEGRAM_CHAT_ID`, and calls a local `TG()` helper that POSTs to the Telegram
Bot API `sendMessage` endpoint. Failures are swallowed (`>/dev/null 2>&1`) — Telegram
reporting is best-effort, never a gate on the pipeline itself.

## 7-day report scheduling hook

When `tick.sh` sees a specific tracked issue (hardcoded in the script — the pilot's
gate issue) transition to closed, it installs a one-shot crontab entry 7 days out that
runs `enqueue-report.sh`. That script enqueues the follow-up report issue, notifies
Telegram, and removes its own cron line so it never fires twice. This is a one-shot-via-
cron pattern: `bootstrap.sh` and `enqueue-report.sh` both remove their own cron entry as
their first action, so a delayed re-run (e.g. after a reboot) can't double-fire.

## Engine self-upgrade

Step 0 of every `tick.sh` run compares `npm view @ai-dossier/cli version` against the
installed `ai-dossier --version` and upgrades in place when npm has a strictly newer
release — but only opportunistically, on a normal tick, never mid-dispatch.

## No behaviour change for hcc2

This commit only adds files under this repo's `scripts/sched-fleet/`. The running
hcc2 deployment keeps using its own copy at `~/.dossier/reset-fleet/` until someone
deliberately repoints `SCHED_FLEET_HOME` (or re-installs from here) — nothing here
touches that host's crontab, `$HOME`, or credentials.
