# sched-fleet

The autonomous pipeline that drives an `ai-dossier sched` fleet unattended: ticks the
scheduler on a cron, reports progress to Telegram, watches tracked issues for closure,
and self-upgrades the CLI. This is the exact deployment that drove the RFC-0001 /
batch-pilot rollout ([epic #474](https://github.com/imboard-ai/ai-dossier/issues/474))
on the `hcc2` host, versioned here so a host reset or disk loss doesn't lose the only
copy.

**These scripts are a reference install, not a generic product.** `bootstrap.sh` in
particular retains the hcc2-specific hardcoded issue numbers and sched defaults;
dispatch profiles are the deliberate shared addition for this change. Treat it as a
worked example to copy and edit per deployment, not something to run as-is against
your own issues.

## Prerequisites

- `ai-dossier` CLI (`npm i -g @ai-dossier/cli`) authenticated for `ai-dossier sched`
- `gh` (GitHub CLI), authenticated
- `crontab` available (Linux/macOS `cron`)
- `flock` available to serialize cron read/modify/write operations
- `at` available for the independent retry fallback when a crontab read is temporarily unavailable
- Node on `PATH`. The scripts hardcode an nvm path entry
  (`$HOME/.nvm/versions/node/v24.20.0/bin`) that matched the hcc2 install at the time —
  **adjust this in your copy** to wherever your Node lives (or drop it if Node is
  already on the system `PATH`).

## Files

| File | Role |
|---|---|
| `tick.sh` | Cron job, every 2 min: ticks every project in `projects.txt` once, Telegram-reports new scheduler events, watches `issues.txt` for closures, arms the 7-day report hook, self-upgrades the CLI when idle, self-removes its own cron line once every tracked issue is closed |
| `bootstrap.sh` | Fires at the configured annual reset, writes a sched `config.json`, enqueues a fixed dependency chain of issues, arms `tick.sh`'s cron line, and records completion for safe retries. Failures re-arm a 5-minute retry cron. **hcc2-specific — edit before reuse.** |
| `cron-lib.sh` | Shared guarded cron read/modify/write helpers; retries transient reads and uses an independent `at` retry when a crontab remains unreadable |
| `dispatch-profiles.json` | Provider-family dispatch profiles installed into host-level `~/.dossier/config.json` by `refresh-fleet.sh`; projects may override individual profile names |
| `probe-effort.mjs` | Dry-run-by-default provider probe; compares same-model lower/max effort or variant settings and reports provider-reported measured-token deltas when run with `--run` (OpenCode includes reasoning tokens) |
| `enqueue-report.sh` | Dated one-shot, installed by `tick.sh`: fires once 7 days after a tracked issue closes, enqueues the follow-up report issue, then removes its own cron line; enqueue failures re-arm a 5-minute retry |
| `fmt_events.py` | Reads scheduler `events.jsonl` lines from stdin, filters to the reportable event types, formats up to 8 lines for a Telegram message. Invoked as `python3 fmt_events.py` (no shebang, not directly executable — matches the hcc2 source file exactly) |
| `allow-sched.py` | One-off fixer for `~/.claude/settings.json` — normalizes malformed `Bash(ai-dossier sched ...)` permission rules. Run it as `python3 allow-sched.py` (no shebang, not directly executable — matches the hcc2 source file exactly) |
| `scorecard-weekly.sh` | Weekly cron ([#566](https://github.com/imboard-ai/ai-dossier/issues/566)): regenerates `docs/reports/model-scorecard.md` + its JSON sidecar in a dedicated worktree, opens/refreshes a PR with the snapshot, and Telegram-reports the 6-line digest. Never merges — this repo has no auto-merge watcher |
| `projects.txt.example` | Template: one sched project slug per line, no comments (see Known Limitations — the real `tick.sh` loop is not comment-tolerant) |
| `issues.txt.example` | Template: one `owner/repo#N` issue ref per line, no comments (see Known Limitations) |
| `telegram.env.example` | Template: the two env vars `tick.sh`, `bootstrap.sh`, `enqueue-report.sh`, and `scorecard-weekly.sh` `source` for Telegram reporting |

## Setup

```bash
# From wherever you want the fleet to live — the hcc2 reference install uses
# ~/.dossier/reset-fleet/; pick a path without whitespace or `%`, e.g. ~/.dossier/sched-fleet/
cp scripts/sched-fleet/{tick.sh,bootstrap.sh,enqueue-report.sh,cron-lib.sh,scorecard-weekly.sh,dispatch-profiles.json,probe-effort.mjs,fmt_events.py,allow-sched.py} .
cp scripts/sched-fleet/projects.txt.example projects.txt      # edit to your projects
cp scripts/sched-fleet/issues.txt.example issues.txt          # edit to your tracked issues
cp scripts/sched-fleet/telegram.env.example telegram.env      # fill in real values
chmod 600 telegram.env
chmod +x tick.sh bootstrap.sh enqueue-report.sh scorecard-weekly.sh
```

Each script resolves its own directory as `D` (overridable via `SCHED_FLEET_HOME`), so
they work from any location as long as `projects.txt`, `issues.txt`, and `telegram.env`
sit alongside them (or `SCHED_FLEET_HOME` points at that directory).

`tick.sh`'s `repo_dir()` function maps each `projects.txt` slug to an absolute repo
checkout path — it is a hardcoded case statement, not data-driven. Add a case arm per
project before ticking it.

## Dispatch profiles

`dispatch-profiles.json` is the fleet-shared source for the four provider families
used by the reference deployment. `refresh-fleet.sh` validates it locally, copies
the source beside the reset bootstrap, then merges only `dispatch.dispatch_profiles`
into each host's `~/.dossier/config.json` as top-level `dispatch_profiles`. No
project scheduler directory needs to exist. A project can override one name under
`dispatch.dispatch_profiles` while inheriting every other host profile.

`SCHED_PROFILE_PROJECTS` is empty by default. Set it only to also synchronize the
legacy project profile map for an explicit override:

```bash
SCHED_PROFILE_PROJECTS=imboard-ai-imboard-monorepo \
  bash scripts/refresh-fleet.sh
```

Use `--profiles-file <path>` for a deployment-specific ladder. Set `SCHED_FLEET_HOME` when the reset scripts live
somewhere other than `~/.dossier/reset-fleet`. `SCHED_PROFILE_FLEET_HOME` is only
the destination override for `refresh-fleet.sh`; it must point at the same
directory as the installed reset scripts.

Run the probe from the repository checkout or a copy that includes
`probe-effort.mjs`:

```bash
npm run fleet:probe-effort -- --project imboard-ai-imboard-monorepo
```

This is a dry run and makes no provider calls. Add `--profile <name>` to probe
one family, or `--run` only when credentials are available. The report's
`measured_tokens` field is the comparison signal: Claude uses parsed input plus
output tokens, while OpenCode uses its reported total, including reasoning tokens.

Profiles resolve from the current scheduler config at each tick. Editing a profile
therefore affects active batches on their next dispatch; removing one dissolves a
pre-merge batch with an explicit `dispatch-profile-missing:<name>` reason, while a
post-merge report tail uses the default dispatch and journals the missing profile.

## Cron install

The hcc2 reference install runs:

```cron
0 4 1 9 *  /path/to/bootstrap.sh >> /path/to/bootstrap.log 2>&1
```

`0 4 1 9 *` is standard 5-field cron (`minute hour day-of-month month day-of-week`) —
this fires once a year, at 04:00 on September 1, not weekly. It's timed to hcc2's
specific annual Claude-usage reset date; adjust both the date and cadence to your own
reset schedule (a genuinely weekly reset would use something like `0 4 * * 1`).
`bootstrap.sh` then arms `tick.sh`'s own cron line (`*/2 * * * * .../tick.sh`) itself;
you never install that one by hand. Before enqueueing, it removes active or completed
issues already present in scheduler state from its manifest, while failed entries remain
retryable. A retry after a partial run therefore does not duplicate active or completed
entries. If bootstrap fails, it replaces its annual trigger with a `*/5` retry trigger;
when the crontab cannot be read safely, it leaves the existing trigger untouched and
uses one independent `at` retry instead. Successful completion removes the bootstrap line.

### The `crontab -l` / empty-crontab trap

**Do not add `set -e` to these scripts.** `crontab -l` exits non-zero and prints
`no crontab for <user>` on a host with no existing crontab. Combined with `set -e`,
that non-zero exit would abort the script *inside* the
`crontab -l 2>/dev/null | grep -v ... | crontab -` pipeline before the new line gets
appended — silently **replacing the existing crontab with an empty one** instead of
preserving it. This bit a real reset-fleet run (see `docs/agent-traps.md`, row
`no crontab for`). Every shell script here uses `set -u` only, and every script that
touches `crontab` uses a guarded read that distinguishes an empty crontab from a read
failure — keep those protections if you edit them.
`scorecard-weekly.sh` never touches `crontab`, so the trap does not reach it.

## Multi-project ticking

`tick.sh` reads `projects.txt` line by line, `cd`s into each project's repo (via
`repo_dir()`), and runs `ai-dossier sched start --once --project <slug>` once per tick.
New scheduler events since the last tick (tracked in a per-project `ev.offset.<slug>`
file next to the scripts) are piped through `fmt_events.py` and sent to Telegram as one
message per project with new events.

## Telegram reporting

`tick.sh`, `bootstrap.sh`, and `enqueue-report.sh` (not `fmt_events.py` or
`allow-sched.py` — neither touches Telegram) source `telegram.env` for
`HANEST_TELEGRAM_BOT_TOKEN` and `HANEST_TELEGRAM_CHAT_ID`, and call a local `TG()`
helper that POSTs to the Telegram Bot API `sendMessage` endpoint. Failures are
swallowed (`>/dev/null 2>&1`) — Telegram reporting is best-effort, never a gate on the
pipeline itself.

## Model scorecard (weekly)

`scorecard-weekly.sh` is the one script here that does NOT tick the scheduler — it
regenerates the [model scorecard](../model-scorecard.mjs) (cost/quality/speed per LLM,
joined from runstate trails, `runs.jsonl`, and `events.jsonl`; see #566) and opens a PR
with the refreshed snapshot. It runs in a dedicated worktree
(`worktrees/chore-model-scorecard-weekly`, created once and reused, with its branch reset
to `origin/main` every run — like `refresh-examples-snapshot.mjs`'s PR branch) rather than
the main checkout, because
this repo's `AGENTS.md` forbids checking out branches there while other agents are
running. Cron install (weekly, Monday 05:00):

```cron
0 5 * * 1  /path/to/scorecard-weekly.sh >> /path/to/scorecard-weekly.log 2>&1
```

It resolves the checkout it regenerates from as `SCORECARD_REPO` (default
`$HOME/projects/ai-dossier/main`, the hcc2 path) — set it if your checkout lives elsewhere;
the script exits with a Telegram error if the path is missing. It takes a `flock` on
`<D>/.scorecard-weekly.lock`, so a run that hangs past the next Monday is skipped rather
than run concurrently against the same worktree.

Note the window: the script uses the script's default **30-day rolling** window, so this is
a weekly *regeneration* of a 30-day view, not a 7-day report. The digest's "best" lines
apply no minimum-sample floor, so a model with one dispatch can win one — every line prints
its `n` for exactly that reason; treat `n=1` as an invitation to open the report, not as a
routing signal. Each snapshot's header prints
the exact command that reproduces its own window.

It never merges the PR it opens — this repo has no auto-merge watcher (unlike the
per-issue full-cycle pipeline `tick.sh` drives), so review and merge is manual. It also
skips the PR entirely on a week whose *payload* is unchanged (the artifacts always differ
by their `generatedAt` stamp, so the comparison strips the volatile keys with `jq` first).
`npm run scorecard` regenerates the snapshot on demand, outside of cron, from any
checkout with a built `cli/dist` (`make build-all`).

The JSON sidecar it writes (`docs/reports/evidence/model-scorecard.json`) is
`JSON.stringify(_, null, 2)` output, which Biome's formatter would reflow — so
`biome.json` turns the formatter off for `docs/reports/evidence/**`. Without that, every
weekly regeneration would open a PR that fails `make check` until a human ran
`biome check --write` on generated data, which is a CI trap, not a review signal.

## 7-day report scheduling hook

When `tick.sh` sees a specific tracked issue (hardcoded in the script — the pilot's
gate issue) transition to closed, it installs a one-shot crontab entry 7 days out that
runs `enqueue-report.sh`. That script enqueues the follow-up report issue, notifies
Telegram, and removes its own cron line only after scheduler success. A failed enqueue
replaces the dated line with a `*/5` retry, while an already-enqueued issue is detected
on the next attempt and cleaned up without duplication. `bootstrap.sh` uses the same
near-term retry pattern for reset failures. If the crontab remains unreadable, the dated
trigger is preserved and one independent `at` retry is queued without replacing unrelated
cron jobs.

## Engine self-upgrade

Step 0 of every `tick.sh` run compares `npm view @ai-dossier/cli version` against the
installed `ai-dossier --version` and upgrades in place when npm has a strictly newer
release. This runs **unconditionally at the top of every tick** — the script has no
check for whether a unit dispatched by a previous tick is still running in the
background (see Known Limitations).

## Logs

| File | Written by | Contents |
|---|---|---|
| `<D>/tick.log` | `tick.sh`'s own cron redirect (installed by `bootstrap.sh`) | `tick.sh`'s stdout/stderr each run |
| `<D>/engine-<slug>.log` | `ai-dossier sched start --once` per project (`tick.sh`) | scheduler engine output for that project |
| `<D>/enqueue.log` | `bootstrap.sh`'s enqueue step | output of the `ai-dossier sched enqueue --from-manifest` call |
| `<D>/bootstrap.completed` | `bootstrap.sh` after config, enqueue, and cron setup | UTC completion marker used to make retries after partial post-enqueue failures idempotent |
| `<D>/enqueue-report.log` | `enqueue-report.sh`'s cron redirect (installed by `tick.sh`) | `enqueue-report.sh`'s stdout/stderr |
| `<D>/bootstrap.log` | `bootstrap.sh`'s own cron redirect (user-installed) | `bootstrap.sh`'s stdout/stderr |
| `<D>/scorecard-weekly.log` | `scorecard-weekly.sh`'s `log()` and its per-stage redirects | stage markers plus git/`npm ci`/build/scorecard/`gh` output for the weekly run; rotated to `.log.1` past 10 MB |
| `<D>/scorecard-weekly-digest.txt` | `npm run scorecard -- --digest-out` (`scorecard-weekly.sh`) | the 6-line Telegram digest for the latest run, rewritten each run |

## Known Limitations

These scripts retain the live hcc2 deployment's behavior for its hardcoded workflow and
are still a reference install, not a generic product. The profile source and merge path
are the deliberate behavior added by this change; the items below are real, pre-existing
behaviors of the running hcc2 pipeline, disclosed here rather than fixed in the
committed copy. Fix them in a follow-up change if/when this is promoted beyond a
single-operator reference install.

- **`issues.txt`/`projects.txt` loops are not comment-tolerant.** `tick.sh`'s issue-closure
  loop (`for REF in $(cat "$D/issues.txt")`) and its project loop both word-split on
  whitespace with no blank/comment-line handling. The `.example` files in this repo are
  deliberately plain data (no `#` comment lines) so copying them verbatim into
  `issues.txt`/`projects.txt` is safe — do not add comment lines to the real data files.
- **Telegram credentials are visible in the process list.** `TG()` passes the bot token
  (in the URL) and chat ID (in a `-d` argument) as literal `curl` argv, visible to any
  other local account via `ps`/`/proc/<pid>/cmdline` for the life of the request. Low risk
  on a single-user host; harden with `curl -K -` (config-from-stdin) before reusing this
  on a shared host.
- **`tick.sh`'s self-upgrade duplicates the CLI's own `--auto-upgrade` flag** (see
  `cli/src/engine-version.ts`/`cli/src/commands/sched.ts`), which additionally gates on no
  unit being mid-dispatch — a check this hand-rolled version's own comment claims but does
  not actually implement. A future non-verbatim revision should delegate to
  `ai-dossier sched start --once --project "$P" --auto-upgrade` instead.
- **Silent failure paths**: an unmapped `projects.txt` slug in `repo_dir()` returns empty
  and `cd ""` succeeds (bash quirk), so the tick silently runs against whatever directory
  the previous project left the shell in, not "skipped"; `gh issue view` failures
  (auth/network) are indistinguishable from "issue still open"; `enqueue-report.sh`
  still reports Telegram "success" regardless of whether its underlying command succeeded;
  `bootstrap.sh` now checks its upgrade, enqueue, cron, and completion-marker steps. None of these have been
  hit in the hcc2 pilot's actual run history, but they are real gaps in a script meant to
  run unattended for weeks.

## `package.json`'s `fleet:tick` script

`npm run fleet:tick` runs `bash scripts/sched-fleet/tick.sh` directly from this repo
checkout — **only useful once you've completed Setup above** (real `projects.txt`,
`issues.txt`, `telegram.env` in place, `SCHED_FLEET_HOME` pointed at that directory if
they don't sit next to the script). Run bare from a fresh checkout with no
`SCHED_FLEET_HOME` and no example files copied into place, `tick.sh` degrades: the
missing `issues.txt` makes the closure loop a no-op, so `ALLDONE` stays at its initial
value of `1` and the script reaches its "pipeline complete" branch, which then touches
`crontab` — do not run `npm run fleet:tick` against a real crontab you care about
without configuring a real deployment directory first.

## No behaviour change for hcc2

These repository changes do not mutate the running hcc2 deployment automatically.
It keeps using its own copy at `~/.dossier/reset-fleet/` until someone deliberately
runs the refresh or reinstalls from here — nothing in this checkout touches that
host's crontab, `$HOME`, or credentials by itself.
