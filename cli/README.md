# @ai-dossier/cli

[![npm version](https://img.shields.io/npm/v/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

**Install, verify, and publish dossiers — portable, signed, versioned skills — for any LLM tool.**

A dossier is a skill with trust built in. This CLI is how you author them, verify their signatures, publish them to a registry, and install them as Claude Code skills (`install-skill` / `skill-export`).

## The Problem This Solves

A plain skill is unsigned, unversioned, and locked to one tool — and **LLMs cannot be relied upon to enforce security checks automatically.**

Even with MCP server installed and protocol documentation:
- ❌ LLMs may skip verification
- ❌ No automatic enforcement mechanism
- ❌ Security depends on LLM "remembering" to check

**This CLI provides**: Mandatory verification enforced by code, not suggestions.

---

## Installation

### Option 1: NPM (Recommended)

Install globally:
```bash
npm install -g @ai-dossier/cli
```

Or use without installing:
```bash
npx @ai-dossier/cli <file-or-url>
```

### Option 2: From Source (Development)

```bash
cd cli
npm link  # Links the CLI globally for development

# Or use directly
chmod +x bin/ai-dossier
./bin/ai-dossier verify <file-or-url>
```

---

## Authentication

### Interactive (Browser OAuth)

```bash
dossier login
```

### Non-Interactive (CI/CD, Agents)

Set the `DOSSIER_REGISTRY_TOKEN` environment variable:

```bash
export DOSSIER_REGISTRY_TOKEN=<your-token>

# Optional: set user/org context
export DOSSIER_REGISTRY_USER=<username>
export DOSSIER_REGISTRY_ORGS=org1,org2
```

When `DOSSIER_REGISTRY_TOKEN` is set, it takes precedence over stored credentials. This is recommended for CI/CD pipelines, Docker containers, and AI agent contexts where interactive login is not possible.

Commands that require confirmation (`publish`, `remove`, `cache clean`) will fail with a clear error in non-interactive sessions. Use `-y`/`--yes` to skip confirmation prompts.

---

## Usage

### Basic Verification

```bash
# Verify local file
ai-dossier verify path/to/dossier.ds.md

# Verify remote dossier
ai-dossier verify https://example.com/dossier.ds.md
```

**Exit codes**:
- `0` - Verification passed (safe)
- `1` - Verification failed (unsafe)
- `2` - Error occurred

### Verbose Mode

```bash
ai-dossier verify --verbose path/to/dossier.ds.md
```

Shows:
- Dossier metadata (title, version, risk level)
- Detailed checksum comparison
- Signature verification details
- Complete risk assessment

### Integration with LLM Tools

**Claude Code**:
```bash
# Shell function wrapper
claude-run-dossier() {
  if ai-dossier verify "$1"; then
    claude-code "The dossier at $1 has been verified. Please execute it."
  else
    echo "❌ Security verification failed. Not executing."
  fi
}

# Use it
claude-run-dossier https://example.com/dossier.ds.md
```

**Cursor**:
```bash
cursor-run-dossier() {
  if ai-dossier verify "$1"; then
    cursor "Execute the verified dossier at $1"
  else
    echo "❌ Verification failed"
    return 1
  fi
}
```

**Any LLM Tool**:
```bash
safe-run-dossier() {
  local url="$1"
  local tool="${2:-claude-code}"

  if ai-dossier verify "$url"; then
    echo "✅ Dossier verified. Passing to $tool..."
    "$tool" "run $url"
  else
    echo "❌ Verification failed. Dossier not executed."
    return 1
  fi
}

# Usage
safe-run-dossier https://example.com/dossier.ds.md claude-code
safe-run-dossier https://example.com/dossier.ds.md cursor
```

## Running Dossiers (`run`)

`ai-dossier run <file|url|registry-name>` verifies a dossier and executes it with a spawned agent CLI.

### Agent selection (`--llm`)

Accepted values: `claude-code`, `opencode`, `auto` (default). Auto-detection tries `claude` first, then `opencode`, then fails with install hints — machines with only Claude Code installed keep their existing behavior. The default agent is also configurable: `dossier config defaultLlm <claude-code|opencode|auto>`.

| Flag | claude-code | opencode |
|---|---|---|
| `--model` | `--model` | `--model` |
| `--budget` | `--max-budget-usd` (headless only) | no equivalent — warned and ignored |
| `--permission-mode` | `--permission-mode` (headless only) | no equivalent — configure permissions in `opencode.json` |
| `--allowed-tools` | `--allowedTools` (headless only) | no equivalent — configure tool access in `opencode.json` |

Unsupported flag combinations print a clear per-flag warning; they are never silently dropped.

- **Headless** (`--headless`): `claude -p --output-format json` or `opencode run --format json`, dossier content piped via stdin. Usage (tokens/cost) is mined from the captured output and recorded in the run log.
- **Interactive**: `claude <file>` or `opencode run -i -- <prompt>` (a seeded session; the `--` separator keeps the `---` frontmatter from being parsed as flags). Prefer `--headless` for large dossiers — interactive opencode passes the prompt as one argv element (~128KB OS limit).

---

## Registry Commands

### Search

Search for dossiers across all configured registries:

```bash
# Basic search
ai-dossier search "deployment"

# Filter by category
ai-dossier search "ci" --category devops

# Search dossier body content (-c is short for --content)
ai-dossier search "docker" -c

# Limit total results
ai-dossier search "setup" --limit 50

# Paginate results
ai-dossier search "setup" --page 2 --per-page 10

# JSON output
ai-dossier search "auth" --json
```

### List

List dossiers from the registry, a local directory, or a GitHub repo:

```bash
# List all registry dossiers
ai-dossier list --source registry

# List with JSON output
ai-dossier list --source registry --json

# Paginate registry results
ai-dossier list --source registry --page 2 --per-page 10

# Filter by category (registry mode)
ai-dossier list --source registry --category security

# List local dossiers (-r is short for --recursive)
ai-dossier list .
ai-dossier list ./dossiers -r

# List from a GitHub repo
ai-dossier list github:owner/repo

# Filter local/GitHub results by risk level or signed status
ai-dossier list . --risk high
ai-dossier list . --signed-only
```

### Pull

Download dossiers from the registry to the local cache (`~/.dossier/cache/`):

```bash
# Pull a dossier (latest version)
ai-dossier pull org/my-dossier

# Pull a specific version
ai-dossier pull org/my-dossier@1.2.0

# Pull multiple dossiers
ai-dossier pull org/dossier-a org/dossier-b

# Force re-download
ai-dossier pull org/my-dossier --force
```

Pulled dossiers are cached locally with checksum verification. Subsequent `pull` calls skip the download if the version is already cached (use `--force` to override). See [Cache and Version Resolution](#cache-and-version-resolution) for how versionless names are resolved and how to control freshness.

### Export

Download a dossier and save it to a local file:

```bash
# Export to default filename (org-name.ds.md)
ai-dossier export org/my-dossier

# Export to a specific file
ai-dossier export org/my-dossier -o ./local-copy.ds.md

# Print to stdout (for piping)
ai-dossier export org/my-dossier --stdout
```

---

## Skills

A dossier is a skill with trust, versioning, and registry distribution added. These commands bridge the registry and Claude Code skills (`~/.claude/skills/`).

A **trigger skill** is a thin `SKILL.md` that fires on a phrase and invokes a versioned, signed dossier via `ai-dossier run <registry-path>`. You author and trigger it like any skill, but it gains signing, version pinning, and registry distribution.

### `install-skill` — registry dossier → Claude Code skill

```bash
# Install a published skill into ~/.claude/skills/
ai-dossier install-skill org/skills/my-skill

# List installed skills / force a fresh re-pull / remove one
ai-dossier install-skill --list
ai-dossier install-skill org/skills/my-skill --fresh --force
ai-dossier install-skill --remove my-skill
```

Restart Claude Code (or start a new session) to pick up a newly installed skill. At run time the skill calls `ai-dossier run <registry-path>`, which fetches and verifies the dossier on demand — so you don't need to install the dossier separately.

**opencode support (auto-detect)**: When `~/.config/opencode/` exists, `install-skill` also writes a YAML-frontmatter wrapper to `~/.config/opencode/skills/<name>/SKILL.md`. opencode's parser only accepts standard YAML frontmatter (`---`), so dossier skills that use `---dossier` (JSON) frontmatter would otherwise be invisible. The wrapper carries the same `name`, `description`, and body; the signed source in `~/.claude/skills/` is never modified. Delegating skills (body contains `ai-dossier run`) also get an `allowedTools: [Bash(ai-dossier run *)]` line so opencode auto-approves the delegation.

Override with `--for claude|opencode|both`:

```bash
ai-dossier install-skill org/skills/my-skill --for claude   # skip opencode wrapper
ai-dossier install-skill org/skills/my-skill --for both     # force opencode even if dir absent
```

`--remove` cleans both locations. `--list` badges each skill with the tools it's installed in (`[claude, opencode]` or `[claude]`).

### `sync-skills` — regenerate opencode wrappers for existing installs

Use after installing opencode on a machine that already has dossier skills, or after any manual change to `~/.claude/skills/`:

```bash
ai-dossier sync-skills                # write missing wrappers, prune orphans
ai-dossier sync-skills --dry-run      # show what would change without writing
ai-dossier sync-skills --no-prune     # keep wrappers even if the source is gone
ai-dossier sync-skills --json         # machine-readable output
```

Idempotent — re-running is safe and reports `unchanged` for wrappers already in sync.

### `skill-export` — local skill → registry dossier

Publish a locally installed skill to the registry as a versioned, signed dossier so others can `install-skill` it:

```bash
# Publish ~/.claude/skills/my-skill to the registry (minor version bump)
ai-dossier skill-export my-skill --namespace org/skills

# Pin an explicit version, add a changelog, verify the roundtrip
ai-dossier skill-export my-skill --version 2.0.0 --changelog "Add range support" --verify
```

| Option | Effect |
|--------|--------|
| `--namespace <ns>` | Registry namespace (default: first org or username) |
| `--version <v>` / `--major` / `--no-bump` | Control the published version |
| `--changelog <msg>` | Changelog message for the release |
| `--verify` | Re-install after publish to confirm the roundtrip |

---

## Runstate — workflow milestones

Issue-workflow dossiers (`imboard-ai/git/full-cycle-issue` and friends) record their
progress by appending a `<!-- runstate:v1 -->` comment to the GitHub issue after every
phase. That trail is the only run state that survives a session: it is what lets a later
run resume mid-workflow instead of starting over.

Until now the milestone was a markdown heredoc that each agent reproduced by hand, and
agents silently got it wrong — skipping milestones entirely, or pasting `$(date …)` into
the comment verbatim. `ai-dossier runstate` makes it a command: the timestamp is filled
in for you, and phase/status/required keys are validated *before* anything is posted.

```bash
# Mint the run id once, at the gate phase
ai-dossier runstate mint --issue 440            # -> r-440-ab56

# Post a milestone at the end of each phase
ai-dossier runstate post --issue 440 \
  --phase setup --status done --run r-440-ab56 \
  --kv branch=feature/440-runstate \
  --kv worktree=/repo/worktrees/feature-440-runstate \
  --kv pool_claimed=false \
  --kv base_branch=main

# Read the last milestone back
ai-dossier runstate last --issue 440 --json

# Ask where a run should resume from
ai-dossier runstate verify --issue 440
```

### Subcommands

| Command | What it does | Writes? |
|---|---|---|
| `post` | Validates and posts one milestone comment via `gh issue comment` | yes |
| `last` | Prints the most recent milestone on the issue, parsed | no |
| `verify` | Runs the gate's resume verification and prints `resume_from` + `resume_context` | no |
| `mint` | Prints a fresh run id (`r-<issue>-<hex>`) | no |
| `stats` | Reports per-phase durations derived from the trail's `at=` stamps; aggregates across a `--issues` selection | no |

`last`, `verify`, and `stats` are strictly read-only — they only run `gh issue view`,
`gh pr view`, `git ls-remote`/`rev-parse`, and `stat`, so they work fine without push
access to the repository.

`--issue <n>` (a positive integer — the number only, not a URL or a `#`-prefixed string)
is required by `post`, `last`, `verify`, and `mint`; `stats` takes either `--issue <n>` or
`--issues <list>`, exactly one of the two. `post`, `last`, `verify`, and `stats`
additionally take `--repo <owner/name>` (a bare slug, not a URL; defaults to the
repository `gh` resolves for the current directory) and `--json`. `mint` takes `--issue`
and nothing else.

`last` prints the milestone's own `key=value` lines, so the output is already in the
shape a shell or a dossier reads:

```
$ ai-dossier runstate last --issue 440
phase=setup
status=done
run=r-440-ab56
at=2026-08-24T07:59:32Z
branch=feature/440-runstate
worktree=/repo/worktrees/feature-440-runstate
pool_claimed=false
base_branch=main
next=plan
```

With `--json` the same keys come back as one flat object; an issue with no milestones
prints `No runstate milestones on issue #440.` (or `null` under `--json`) and exits 0.

### `post`

| Flag | Meaning |
|---|---|
| `--issue <n>` | Issue to comment on (required) |
| `--phase <p>` | `classify`, `gate`, `setup`, `plan`, `implement`, `review`, `ship`, `report`, or a batch phase — `batch-setup`, `batch-validate`, `batch-review`, `batch-ship`, `batch-report` (required) |
| `--status <s>` | `done`, `partial`, `blocked`, `awaiting-merge` (required) |
| `--run <id>` | Run id (`r-<issue>-<hex>`) — mint one with `runstate mint`; full-cycle runs mint it at the gate phase (required) |
| `--kv <key=value...>` | Phase-specific key, repeatable (and variadic: `--kv a=1 b=2` works too) |
| `--next <phase>` | Override the computed `next=` line — a phase name or `done` |
| `--repo <owner/name>` | Target repository (defaults to the current one) |
| `--dry-run` | Print the comment body instead of posting it |
| `--json` | Machine-readable output |

Validation failures print one actionable message per problem on stderr and exit 1
**without posting**:

```
$ ai-dossier runstate post --issue 440 --phase setup --status done --run r-440-ab56 --kv branch=x
❌ Phase 'setup' with status 'done' requires worktree= pool_claimed= base_branch= — add with --kv worktree=<value> --kv pool_claimed=<value> --kv base_branch=<value>
```

A valid `--dry-run` prints the exact body that would be posted:

```
$ ai-dossier runstate post --issue 440 --phase setup --status done --run r-440-ab56 \
    --kv branch=feature/440-runstate --kv worktree=/repo/worktrees/feature-440-runstate \
    --kv pool_claimed=false --kv base_branch=main --dry-run
<!-- runstate:v1 -->
phase=setup status=done run=r-440-ab56 at=2026-08-24T07:59:32Z
branch=feature/440-runstate
worktree=/repo/worktrees/feature-440-runstate
pool_claimed=false
base_branch=main
next=plan
```

Without `--dry-run` a successful post prints `✅ setup done → <comment url>`; `--json`
returns `{ "posted": true, "url": …, "body": … }` (and `{ "posted": false, "dryRun":
true, "body": … }` under `--dry-run`). See [When `gh` or `git`
fails](#when-gh-or-git-fails) for what a failed post prints.

### Phases, statuses, and required keys

This table is the executable copy of the "Runstate Milestones" table in
`imboard-ai/git/full-cycle-issue@3.8.0`:

| Phase | Statuses | Required keys |
|---|---|---|
| `gate` | `done`, `blocked` | `base_branch` `warnings` |
| `setup` | `done`, `blocked` | `branch` `worktree` `pool_claimed` `base_branch` |
| `plan` | `done`, `blocked` | `planning` `head` `open_questions` `visual_review` |
| `implement` | `done`, `blocked` | `head` `files` `tests_added` `tests_run` `ci_parity` |
| `review` | `done`, `partial`, `blocked` | `head` `fixed` `escalated` `agents_done` `agents_pending` |
| `ship` (1st, before the CI wait) | `awaiting-merge` | `pr` `head` `ci_fix_attempts` |
| `ship` (2nd, after merge + teardown) | `done`, `blocked` | `pr` `merge_commit` `ci_fix_attempts` `cleanup` |
| `report` | `done` | `pr` `traps_added` |

### Classify and batch phases (RFC-0001 Batch Cycles)

Two more phase families are accepted alongside the full-cycle line (#461):

| Phase | Statuses | Required keys |
|---|---|---|
| `classify` | `done`, `blocked` | `mode` `risk` `est_files` `est_diff` `areas` `test_scope` `deps` `confidence` |
| `batch-setup` | `done`, `blocked` | — |
| `batch-validate` | `done`, `blocked` | — |
| `batch-review` | `done`, `blocked` | — |
| `batch-ship` | `awaiting-merge`, `done`, `blocked` | — |
| `batch-report` | `done` | — |

`classify` is posted by the issue-cycle-classifier **before** any cycle is dispatched, so
it is not a station on the full-cycle line: its `next=` is `done` (the dispatched cycle
mints its own run id), and `runstate verify` on an issue whose latest milestone is a
classify record reports `resume_from=none` — a full-cycle run always enters fresh. A
classify verdict with `mode=slot` additionally carries the `slot_trail` signal (below).
The eight verdict keys are validated by value grammar (below); the classifier's
`rationale_comment=<link>` is accepted but not required.

The `batch-*` phases are posted on **batch anchor issues** (one anchor per batch, created
by batch preparation), never on member issues. They deliberately carry no phase-specific
required keys beyond the universal blocked→`reason` — the batch scheduler dossier owns
what its milestones record; this table fixes the phase names and status sets so the
vocabulary underneath it is stable. `batch-ship` mirrors `ship`'s two-milestone shape:
`awaiting-merge`, then `done` after the merge, and `stats` reports the gap between them
under its own `batch-merge-wait` label (not pooled with full-cycle `merge-wait`).
`next=` walks the batch line: batch-setup → batch-validate → batch-review → batch-ship →
batch-report → done.

> **Compatibility.** Reading and posting these phases requires CLI ≥ 0.14.0. An older
> CLI rejects them outright on `post` (`Unknown phase 'classify' — expected one of: …`),
> but its `verify` derives a bogus `resume_from` from a *blocked* classify/batch
> milestone — don't point an old CLI at batch anchor issues.

### mode=slot and batch= on plan/implement/review

Slot-cycle members post the ordinary `plan`/`implement`/`review` milestones with two
extra keys: `mode=slot` and `batch=<id>`. Both are accepted on any phase, and
`runstate verify` treats a trail whose **latest** milestone is a full-cycle-line phase
carrying either key — or a `classify` verdict with `mode=slot` — as slot-mode:
`resume_from=none` — an evicted member re-enters full-cycle fresh (the batch worktree is
machine-local; there is nothing to resume) — plus a distinguishable
`slot_trail=present` signal (text) / `slot_trail: true` (JSON), so "fresh because slot"
never looks like "fresh because there was no trail". A trail whose latest milestone is a
`batch-*` phase (an anchor issue) sets no slot signal — it reports its own note,
`batch anchor trail — not a full-cycle run`. Slot milestones deeper in the trail
are history and do not affect resume: once a full-cycle `gate` milestone follows them,
resume derives from the full-cycle trail as usual.

A phase may carry keys beyond its required ones, and one is worth knowing about:
`gate` should also pass `model=<agent model id>`, which is what lets
[`runstate stats`](#stats) break whole-run durations down by model. Runs whose trail
carries the key nowhere are bucketed as `unknown`.

The `Statuses` column is a closed set: a status not listed for a phase is rejected, so
`report` cannot be `blocked` and only the ship phases (`ship`, `batch-ship`) may be
`awaiting-merge`. Any phase that *can* report `status=blocked` must also carry
`reason=<short-slug>` when it does.

`next=` is computed for you: the linear order `gate → setup → plan → implement → review →
ship → report → done`, except that `blocked` ends the run (`next=done`) and the two
non-terminal statuses stay in their own phase — `ship`/`awaiting-merge` is followed by a
second `ship` milestone, and a `partial` review still has agents to run. Use `--next` to
override.

### Key and value rules

Every `--kv` pair is checked before anything is posted:

- Keys are `lower_snake_case` (`^[a-z][a-z0-9_]*$`) and may appear at most once.
- No empty values — omit the key instead.
- No `$` in values. This is the check that catches an unexpanded `$(date …)` before it
  reaches the issue.
- One line per value. A newline would split into extra `key=` lines that readers parse as
  real state, so it is rejected for **every** key, including `ac*` ones — collapse it
  (`,` or ` / `) instead.
- No spaces in values (use `-` or `,`). Only `ac*` keys — `ac`, `ac1`, `ac_results` — are
  exempt, because acceptance-criterion lines are prose. (The newline rule above still
  applies to them.)
- A value is at most 4000 characters and the whole comment at most 60000 (GitHub rejects
  a longer issue comment with an opaque 422). A milestone is an index, not a report:
  replace a long value with a count or a path to the full text.
- `worktree=` and `planning=` must be absolute paths, so a resume from a different
  working directory can still find them.
- The classify/slot-mode keys carry a value grammar, checked wherever the key appears
  (#461):

  | Key | Grammar |
  |---|---|
  | `mode` | one of `full`, `slot` |
  | `risk` | one of `low`, `med`, `high` |
  | `test_scope` | one of `focused`, `broad`, `unknown` |
  | `est_files` | non-negative integer, e.g. `3` |
  | `est_diff` | non-negative integer (lines), e.g. `400` |
  | `confidence` | decimal `0`–`1`, e.g. `0.85` (RFC-0001 E.2 compares it to 0.6) |
  | `areas` | comma-separated lowercase slugs, e.g. `cli,docs` |
  | `deps` | `none`, or comma-separated issue numbers, e.g. `474,480` |
  | `batch` | a batch id slug starting with a letter or digit, then letters, digits, `.`, `_`, `-` (e.g. `b-2026-08-29-01`) |

- `--next` must be a phase name or `done`. It is written to the comment verbatim, so an
  unchecked typo would point the next resume at a phase that does not exist.
- Comments are append-only: never edit or delete a prior milestone.

### When `gh` or `git` fails

Every subcommand exits **1** on failure with the cause *and its fix* on stderr, so a
calling dossier can branch on the exit code and an agent knows what to do next. The three
causes that look identical from the outside are reported as three different things:

```
$ ai-dossier runstate last --issue 440
❌ Could not read issue #440: gh is not authenticated.
   Fix: run 'gh auth login', confirm with 'gh auth status', then re-run.
   gh said: To get started with GitHub CLI, please run:  gh auth login
```

| Cause | What you get |
|---|---|
| `gh` not on PATH | "'gh' is not installed, or is not on PATH" + the install link |
| Not logged in | "gh is not authenticated" + `gh auth login` |
| Issue/PR does not exist | "GitHub could not find it in …" + a nudge to check `--repo` |
| No permission (403) | "the authenticated account lacks access to …" + `gh auth status` |
| github.com unreachable | "gh could not reach GitHub" + retry guidance |
| Anything else | the exit status, and "run the same gh command by hand" |

`gh`'s own stderr is **always** echoed on a `gh said:` line, including for causes the CLI
cannot classify — nothing is swallowed. `gh` exiting 0 with output that is not JSON, or
with JSON that has no `comments` array, is also a hard failure rather than a silent "no
milestones": the two must never look alike, because reading a fresh run out of a broken
response makes a resume start over and throw away finished work.

When `post` cannot reach GitHub, it prints the exact `gh issue comment …` command to run
by hand. The milestone is the only durable record of the phase, so re-running the phase
costs far more than retrying the comment.

### `verify`

`verify` implements `imboard-ai/git/gate-issue`'s resume table. It never trusts the
comment alone — each claim is checked against reality (is the branch still on the remote,
does the worktree still exist, does the planning file exist, has HEAD moved, what is the
PR's state) before it reports where to resume:

```
$ ai-dossier runstate verify --issue 440
resume_from=implement
run_id=r-440-ab56
verified=branch,worktree,planning
resume_context={"branch":"feature/440-runstate","worktree":"/repo/worktrees/feature-440-runstate",...}
```

`resume_from` is a phase name, or one of:

| Value | Meaning |
|---|---|
| `none` | No milestones on the issue — a fresh run. Also returned when the latest milestone is slot-mode (`slot_trail=present`), a `classify` record, or a batch-phase trail: full-cycle always enters fresh from those (see [classify and batch phases](#classify-and-batch-phases-rfc-0001-batch-cycles)) |
| `ship-wait` | The PR is open and mergeable; re-enter `ship` at the CI wait |
| `ship-teardown` | The PR is already merged; re-enter `ship` at post-merge cleanup |
| `done` | The `report` milestone is posted and the issue is closed (`note=already complete`) |

A failed check sends the resume *backwards*, never forwards: if the branch is gone from
the remote or the worktree no longer exists, a `plan`/`implement`/`review` milestone
still yields `resume_from=setup`. A milestone with `status=blocked` resumes at its own
phase.

`resume_context` is merged across the run's milestones (later ones winning), so a resume
at `plan` still sees `branch`/`worktree` from the `setup` milestone. (The dossier's own
table carries only the last milestone's keys; merging is what makes a mid-run resume
self-sufficient.) If the last three milestones are all `blocked` on the same phase,
`verify` adds `hard_block=resume-loop` — the run is looping and needs a human.

When a check cannot run at all — `git`/`gh` is missing or the remote is unreachable, or
the milestone's `branch=`/`worktree=`/`pr=` value is not one `verify` will hand to a
subprocess — that check degrades to "not verified" and `verify` warns instead of failing.
It still exits 0, because a conservative `resume_from` is the safe direction (redo a phase
rather than skip one), but the reader needs to know the answer is conservative *because a
check could not run*. Warnings go to stderr so stdout stays parseable:

```
⚠️  verify could not check everything: could not reach 'origin' to confirm branch 'feature/440-runstate' (git exited 128: fatal: 'origin' does not appear to be a git repository) — treating it as missing
```

Anyone who can comment on the issue can post a `<!-- runstate:v1 -->` body, so the values
`verify` reads back are untrusted input. Nothing is run through a shell, and a value that
would be read as a flag (leading `-`) or that is not the absolute path the protocol
requires is refused rather than passed to `git`/`gh` — it becomes one of the warnings
above.

`--json` returns the same fields as an object (`resume_from`, `run_id`, `verified`,
`resume_context`, plus `slot_trail`, `hard_block`, `note`, and `warnings` when they
apply).

### stats

Every milestone stamps `at=`, so a run's per-phase durations are already in the trail —
nothing has to be measured while the run happens. `stats` is the read side of that:

```bash
ai-dossier runstate stats --issue 440
```

```
Issue #440 — run r-440-ab56, model claude-opus-5 — total 49m 6s (2946s)
  phase       status          started               ended                       duration
  gate        done            -                     2026-08-24T07:42:54Z               -
  setup       done            2026-08-24T07:42:54Z  2026-08-24T07:45:11Z   2m 17s (137s)
  plan        done            2026-08-24T07:45:11Z  2026-08-24T07:47:08Z   1m 57s (117s)
  implement   done            2026-08-24T07:47:08Z  2026-08-24T07:55:05Z   7m 57s (477s)
  review      done            2026-08-24T07:55:05Z  2026-08-24T08:24:06Z  29m 1s (1741s)
  ship        awaiting-merge  2026-08-24T08:24:06Z  2026-08-24T08:25:39Z    1m 33s (93s)
  merge-wait  done            2026-08-24T08:25:39Z  2026-08-24T08:31:13Z   5m 34s (334s)
  report      done            2026-08-24T08:31:13Z  2026-08-24T08:32:00Z       47s (47s)
```

A phase starts at the previous milestone's `at=` and ends at its own, so the first
milestone of a run has no measurable start and reports `-`. The gap between ship's two
milestones is reported as its own **`merge-wait`** row: it is the one span that measures
waiting rather than working, and folding it into `ship` would make ship's median a
function of CI queue depth. A trail with several `run=` ids — a resumed or re-run issue —
gets one table per run, never pairing one run's milestone with another's.

New-phase rows (#461): a `classify` verdict that prefixes the run's `gate` sits before
`gate` in every table — note its span (the classifier → cycle dispatch wait) is charged
to `gate`, since pairing is by previous milestone; and `batch-*` rows sit after
`report`, with `batch-ship`'s awaiting-merge → done gap reported as
**`batch-merge-wait`** (kept separate from full-cycle `merge-wait` so a mixed
`--issues` selection never pools the two populations).

`--issues` takes a fleet-style selection (`1,2,3`, `1..9`, or mixed `1,2,5..8`, capped at
200 issues since each costs a `gh` call) and reports the aggregates instead of every
table: per-phase median/min/max, a per-run total, and a breakdown by the `model=` the gate
milestone recorded.

```bash
ai-dossier runstate stats --issues 440,448,451
```

Trails are imperfect in practice, and `stats` reports what it could not measure rather
than guessing:

- A milestone whose `at=` is not a real timestamp — the literal `$(date -u …)` that
  pre-CLI heredocs pasted verbatim — is skipped **and breaks the chain**, so the next
  phase reports `-` instead of a duration silently covering two phases.
- A span that ends before it starts (milestones stamped by clocks that disagree) is
  reported as negative, and every aggregate row it lands in is marked `⚠ N skewed`.
- A run with only one usable milestone — the normal state of anything still in flight —
  has no total, rather than a fabricated `0s` that would drag every median toward zero.
- An issue with no runstate comments says so, and an issue that cannot be read at all is
  named and left out while the rest of the selection is still reported.

Warnings go to stderr in both human and `--json` mode, so stdout stays parseable and
`stats` still exits 0 — a degraded read is not a failure. It exits 1 only when nothing in
the selection could be read.

`--json` returns `repo`, `issues`, `runs` (each with `run`, `model`, `last_phase`,
`last_status`, `total_seconds`, and a `phases` array of
`{phase, status, started_at, ended_at, seconds}`), `aggregates.phases`,
`aggregates.models`, `issues_without_trail`, `issues_failed`, and `warnings`.

---

## Plan Artifacts (`plan`) — plan:v1

Issues used to be planned up to three times (triage, batch prep, plan-issue). The
`plan:v1` artifact replaces that with ONE canonical plan stored on the issue itself:
posting is append-only, readers take the LAST `plan:v1` comment, and consumers
validate-and-refine instead of replanning. It lives on the issue — not a file — because
batch preparation runs before any branch exists. Full format spec:
[docs/reference/plan-artifact.md](../docs/reference/plan-artifact.md).

```bash
# Post a plan (validates the five sections first; head= stamps current HEAD)
ai-dossier plan post --issue 462 --file plan.md

# Read the latest plan back (last plan:v1 comment wins)
ai-dossier plan get --issue 462 --json

# Deterministic validation — no model call anywhere
ai-dossier plan validate --issue 462
```

### Subcommands

| Command | What it does | Writes? |
|---|---|---|
| `post` | Validates the file's five sections, stamps `head=`, comments it via `gh issue comment` | yes |
| `get` | Prints the latest artifact (raw in text mode, parsed fields with `--json`); exits 1 when no plan exists | no |
| `validate` | Deterministic checks against the local clone; prints a `{valid, reasons[]}` JSON verdict; exits 1 when invalid | no |

`validate` runs the deterministic checks — all five sections present, every Predicted
Files path exists at current HEAD (`git cat-file -e HEAD:<path>`), head-distance (commits
on HEAD since the plan's `head=` — an info reason when non-zero), and a risk-floor scan of
Predicted Files (auth/secrets, payments/billing, migrations/schema, protocol surfaces are
flagged as elevated-risk, info severity) — reporting `{check, severity, message}` reasons
(full check/severity table in [docs/reference/plan-artifact.md](../docs/reference/plan-artifact.md)).
Reasons carry `{check, severity, message}`; only `severity: "error"` fails validity —
`get` and `validate` are read-only aside from `post`'s comment. All three take `--repo
<owner/name>`; `post` also takes `--head <sha>` (7-40 lowercase hex, validated),
`--dry-run`, and `--json` (JSON result: `{posted, head, url}`, or `{posted: false,
dryRun: true, head, body}` in dry-run). `get` and `validate` take `--json` / emit JSON
respectively; `get --json` includes the comment's `author`.

---

## Scheduler core (`sched`)

```bash
ai-dossier sched enqueue --issues 101,105..109 [--mode full|slot] [--batch b1] [--deps 100,104] [--tier mechanical|mid|strong]
ai-dossier sched enqueue --from-manifest batch-prep.json
ai-dossier sched start [--interval <seconds>] [--once] [--json]
ai-dossier sched status [--json]
ai-dossier sched pause | resume
ai-dossier sched abandon --issue 42 [--reason "..."] | --batch b1 [--reason "..."]
```

The deterministic core of batch cycles (RFC-0001): a queue, worker slots, typed
issue/batch/slot state machines persisted to `~/.dossier/sched/<project>/state.json`
(`<project>` = `owner-repo` slug, falling back to the repo basename — the same convention
`fleet-cycle` uses for its logs), and — since #464 — the dispatch engine. **The scheduler
itself never invokes an LLM**: every mechanical decision (what is runnable, which slot gets
it, whether a unit completed, when a run stalled) is a pure function of state reconciled
against ground truth.

- **`enqueue`** records entries (issue, mode, batch id, dependency edges, model tier) from
  flags or a batch-prep manifest (`--from-manifest`, a JSON file of entries — flags and
  manifest can be combined). Invalid input is rejected *before* anything is persisted:
  duplicate active issues, self-dependencies, dependency cycles, `slot` mode without a
  batch, and conflicting `base_branch` on a joining batch member.
- **`start`** runs the dispatch engine (#464): a runnable unit is spawned as a detached
  agent process (`claude -p --output-format json --model <tier model>` by default,
  auto-falling back to `opencode run`; the command, prompt, and tier→model mapping are
  all configurable in `config.json`'s `dispatch` section) with the prompt on stdin and
  output journaled to `runs/<unit>.log`. On every ~60s tick it reconciles: an agent that
  exited is **not** complete until `ai-dossier runstate last` / `gh` ground truth confirms
  it (unverified exits and stalls are redispatched one tier stronger — mechanical → mid →
  strong, cap 2 — then the unit fails and its transitive dependents are blocked);
  externally-advanced state and orphaned pids after a restart are detected; a freed slot
  is refilled in the same tick. Since #468 the default dispatch prompt is
  detached-ship (the agent parks its PR on `auto-merge` and stops): a parked
  exit releases its slot, the watcher polls the PR every `pr_poll_interval_ms`
  (default 150 000 ms, cadence persisted across restarts), and on merge —
  only when the PR is MERGED **and** `mergedAt` is set **and** the issue is
  closed — the engine runs script-based teardown (pool return, self-check
  verified, or `git worktree remove --force`, path-gone verified;
  `cleanup=failed-<step>` on a failed step) and then dispatches a
  mechanical-tier report agent. `CONFLICTING` / closed-unmerged /
  `auto-merge-blocked` PRs fail the unit and block its transitive dependents;
  a failed report on a merged unit never blocks dependents (the work shipped).
  `--once` runs a single tick (cron-style); Ctrl-C stops
  the engine while spawned agents keep running. Pids are identity-guarded via
  `/proc` start-times (a reused pid is never signalled; best-effort on macOS/Windows),
  and a FAILED ground-truth poll (gh outage) pauses that unit's stall/verify decisions
  instead of guessing — an outage never kills a healthy agent. All events are journaled
  to `events.jsonl`, and `status` shows the live phase per unit.
- **`status`** renders the queue (with `pr` and `cleanup` columns), parked PRs
  (watched, zero slots, with the last poll's age), slots (with pid, live phase,
  last-progress, recoveries), batches, runnable units, and the blocked/failed sets. A blocked entry names every
  unsatisfied dependency ("dependency #104 not merged (status: dispatched)"), so "why
  isn't #42 running?" is a read, not an investigation. `--json` emits the same report
  as data.
- **`pause`/`resume`** gate *new* assignments only — live units keep running.
- **`abandon --issue`** fails the entry (recording the reason) and releases its slot;
  **`abandon --batch`** dissolves the batch and requeues every non-terminal member as
  full-cycle — members already shipped keep their outcome.

State is written atomically (tmp + fsync + rename), so a process killed between writes
always leaves the previous complete state, and a scheduler restart resumes identically
from `state.json` (pre-#464/#468/#472/#500 state files — schema 1.0.0/1.1.0/1.2.0/1.3.0 —
migrate to 1.4.0 on load). A corrupt state file is a loud
error naming the file — never a silent queue reset. Concurrency is serialized by a
`.sched-lock` directory mutex (stolen from dead holders). `config.json` holds
`max_slots` (default 3, bounds concurrently-live units), `stall_timeout_ms` (default
1 800 000), `reconcile_interval_ms` (default 60 000), and the optional `dispatch`
section (including `report_prompt` for the #468 report agent); `pr_poll_interval_ms`
(default 150 000) sets the parked-PR poll cadence; an issue with an unmerged dependency —
or a batch behind an unmerged batch — is never runnable.

Library consumers: see [`@ai-dossier/sched`](../packages/sched/README.md).

---

## Capabilities (`cap`)

```bash
ai-dossier cap list [--json]       # inspect .dossier/automation/manifest.yaml
ai-dossier cap run test.focused    # execute one capability
ai-dossier cap run test.focused -- --grep auth   # extra args are shell-quoted and appended
```

A repo declares its deterministic, recurring operations — tests, lint, build, deps
install, worktree prep — in `.dossier/automation/manifest.yaml` so agents execute them
directly instead of re-reasoning (Progressive Determinism, RFC-0001; the scheduler's
slot-cycle fast path will consume the same manifest, #464). Entries should mostly
reference existing repo tooling (package scripts, Makefile targets):

```yaml
capabilities:
  test.focused:
    command: npm test -- --silent
    lifecycle: active          # active | shadow (listed, not executable)
    description: Focused vitest suite
    timeout_ms: 300000         # optional; default 5 min, timeout = automation-broken
    assumptions:               # probes run BEFORE the command; failure = automation-broken
      - file-exists: package.json
      - tool-version: node>=20
```

Extra args after `--` are shell-quoted and appended (they are data, not shell syntax):

```bash
ai-dossier cap run test.focused -- --grep auth   # → npm test -- --silent --grep auth
```

`cap run` reports one of exactly four outcomes — the JSON envelope is the **last
stdout line**, and the exit code matches:

| Outcome | Exit | Meaning |
|---|---|---|
| `ok` | 0 | Command ran, exited 0 |
| `task-failed` | 1 | Command ran, legitimately failed (red tests) |
| `automation-broken` | 2 | Probe failed / command missing / timeout / abnormal termination — fall back to reasoning |
| `capability-unavailable` | 3 | Id not in manifest (or `shadow`) — no fast path |

A repo without `.dossier/automation/` is normal: `cap list` is empty and exits 0. Every
run appends telemetry (capability, outcome, exit code, duration, reason, cwd) to
`~/.dossier/caps.jsonl`. Full spec and the capability id vocabulary:
[docs/reference/capabilities.md](../docs/reference/capabilities.md).

---

## Run History (`history`)

Every `ai-dossier run` appends one JSON line to `~/.dossier/runs.jsonl` (append-only; disable with `dossier config auditLog false`).

```bash
ai-dossier history                     # last 20 runs
ai-dossier history --limit 50
ai-dossier history --dossier org/my-dossier
ai-dossier history --json              # raw entries, machine-readable
ai-dossier history --clear --yes       # wipe the log
```

Columns: TIMESTAMP, DOSSIER, VERSION, SOURCE, VERIFIED, DURATION, TOKENS(in/out), COST — auto-sized to the widest cell. Entries written before v0.12.0 lack the cost/observability fields and render `-`.

Headless runs execute `claude -p --output-format json` (claude-code) or `opencode run --format json` with the dossier piped via stdin (opencode); the CLI captures stdout (32MB cap) to extract token/cost usage and prints the agent's final result text once the run completes — output is not streamed live. When the output cannot be parsed as the agent's expected result (a claude JSON result / an opencode JSONL event stream), a stderr warning says so, usage fields are recorded as `null`, and the raw stdout is re-emitted.

### runs.jsonl schema

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601 entry write time |
| `dossier` | Argument as given (file, URL, or registry name) |
| `resolved_version` | Resolved version (`unknown` for local files) |
| `source` | `cache` \| `registry` \| `local` \| `url` |
| `registry`, `resolution_source` | Registry that served content; how the version was resolved (`pinned`/`registry`/`cache`/`stale-cache`) — registry sources only |
| `verification` | `passed` \| `failed` \| `skipped` \| `nested-skip` |
| `llm`, `user`, `cwd`, `nested` | For runs that spawned an agent, the resolved agent CLI (`claude-code`/`opencode`, never the raw `auto` — v0.13.0+); otherwise the `--llm` option in effect. Plus who/where ran it; whether inside an agent host |
| `duration_ms` | Wall-clock ms, action start → entry write (v0.12.0+) |
| `spawned_command` | Exact agent command spawned (binary + args); prompt excluded — headless prompts travel over stdin, and opencode interactive runs log a redacted form (v0.12.0+; redaction v0.13.0+) |
| `model` | Model reported by the agent CLI (comma-joined when several ran), else the `--model` alias; null when unknown (v0.12.0+) |
| `exit_code` | Spawned agent's exit code, or the CLI action's for early exits; null when killed by a signal (v0.12.0+) |
| `spawn_error` | Why there is no exit code: spawn error (e.g. ENOENT) or signal. Null when the process exited normally (v0.12.0+) |
| `input_tokens`, `output_tokens`, `total_cost_usd` | Usage reported by the agent (claude JSON result / opencode JSONL event stream, headless only); null when not reported — never fabricated (v0.12.0+) |

Pre-v0.12.0 entries simply lack the v0.12.0+ fields; consumers must treat them as optional/nullable.

---

## Cache and Version Resolution

The CLI maintains a local cache at `~/.dossier/cache/`:

- **Content cache** — `~/.dossier/cache/<name>/<version>.ds.md` (the dossier bytes, content-addressable by version).
- **Resolution cache** — `~/.dossier/cache/.resolution/<name>.json` (which version a versionless name resolves to, with TTL).

### How versionless names resolve

Pinned references (`org/my-dossier@1.2.3`) are content-addressable and never expire — they bypass the resolver entirely.

Versionless references (`org/my-dossier`) are resolved through a **TTL'd resolution cache**:

1. If a recent resolution exists (within TTL) → reuse it (no registry call).
2. Otherwise → call the registry, write the resolved version to the resolution cache, return it.
3. If the registry is unreachable → fall back to the highest-semver cached version and print a loud stderr warning. If nothing is cached, fail with a clear error.

This applies to `ai-dossier run`, `ai-dossier create`, and `ai-dossier install-skill`.

### Controlling freshness

| Flag | Effect |
|------|--------|
| (none) | Use cached resolution if newer than `cache.resolutionTtlSeconds` (default 300s). |
| `--max-age <seconds>` | Override TTL for this call. `0` forces a registry check. |
| `--fresh` | Skip the resolution cache and the content cache; fetch fresh from the registry. |
| `--pull` (`run` only) | Refresh the content cache (re-download) but still resolve via the resolver. |

```bash
# Default: use cached resolution if within 300s
ai-dossier run org/my-dossier

# Force a registry re-check
ai-dossier run org/my-dossier --max-age 0

# Skip the entire cache for this call
ai-dossier run org/my-dossier --fresh
```

Configure the default TTL:

```bash
dossier config cache.resolutionTtlSeconds 600
```

### `cache` subcommand

```bash
# Show all cached dossiers (content cache)
ai-dossier cache list
ai-dossier cache list --size --json

# Show cached versionless → version resolutions (with timestamps)
ai-dossier cache resolutions
ai-dossier cache resolutions --json

# Remove cached entries
ai-dossier cache clean <name>             # all versions of a dossier
ai-dossier cache clean <name> --ver 1.2.0 # specific version
ai-dossier cache clean --older-than 30    # entries older than N days
ai-dossier cache clean --all              # everything (prompts; use -y to skip)
```

---

## Multi-Registry Resolution

The CLI queries all configured registries in parallel when resolving dossiers (e.g., `dossier get`, `dossier run`, `dossier pull`). This uses `Promise.allSettled()` so a single registry failure does not block results from other registries.

### Exit Codes

Multi-registry commands use the following exit codes:

| Command | `0` (Success) | `1` (Failure) | `2` (Config/Runtime Error) |
|---------|---------------|---------------|---------------------------|
| `get` | Dossier found | Not found in any registry, or all registries failed | — |
| `list --source registry` | Results returned, including when all registries fail (empty list + warnings) | Unexpected runtime error | — |
| `search` | Results returned, including when all registries fail (no matches + warnings) | Unexpected runtime error | — |
| `pull` | At least one item pulled successfully (per-item errors are printed as warnings) | All requested items failed to pull | — |
| `run` | Dossier executed successfully | Not found, fetch failed, or verification failed | No LLM detected, unknown LLM, or execution failed |

**Partial failures**: When some registries fail but at least one succeeds, `list` returns exit `0` with a warning showing which registries failed:
```
⚠️  Registry 'internal': connection timeout
⚠️  Showing partial results (1/2 registries responded)
```

When **all** registries fail, `list` and `search` still exit `0` but display per-registry error warnings and report no results found.

### No Registries Configured

If no registries are configured (no user config, no project `.dossierrc.json`, no `DOSSIER_REGISTRY_URL` env var), the CLI falls back to the hardcoded public registry (`https://dossier-registry.vercel.app`). Commands proceed normally — there is no error or special exit code for this scenario.

### Error Handling

All multi-registry operations return structured errors alongside results:

```
$ dossier get org/my-dossier
# If registry A is down but registry B has it → returns result silently from B
# If no registry has it → displays errors from each registry
```

When **all registries fail**, the CLI displays per-registry error details showing which registry failed and why. When at least one registry succeeds, the result is returned without surfacing errors from other registries.

This means you can configure multiple registries for redundancy — the CLI will succeed as long as at least one registry can serve the requested dossier. Registries are queried in parallel; for `get` and `run`, the first successful result (by configuration order) is used.

### Configuration

See `dossier config` for managing registry URLs. Multiple registries are queried in parallel, not sequentially.

---

## Config Command

Manage CLI settings and registry configuration.

### General Settings

```bash
# List all configuration
dossier config --list

# Get a setting
dossier config defaultLlm

# Set a setting
dossier config defaultLlm claude-code
dossier config defaultLlm opencode   # accepted values: claude-code, opencode, auto

# Reset to defaults (preserves registry settings)
dossier config --reset
```

### Registry Management

All registry URLs **must use HTTPS** to protect credentials in transit.

```bash
# List configured registries
dossier config --list-registries
dossier config --list-registries --json

# Add a registry
dossier config --add-registry internal --url https://dossier.company.com

# Add as default + read-only
dossier config --add-registry mirror --url https://mirror.example.com --default --readonly

# Remove a registry
dossier config --remove-registry mirror

# Change the default registry
dossier config --set-default-registry internal
```

### Project-Level Config (`.dossierrc.json`)

Place a `.dossierrc.json` in your project root for team-shared registry settings:

```json
{
  "registries": {
    "internal": { "url": "https://dossier.company.com" }
  },
  "defaultRegistry": "internal"
}
```

Project registries are merged with user registries. User-configured registries take precedence on name conflicts to prevent credential exfiltration.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DOSSIER_REGISTRY_URL` | Override/add a registry URL (creates virtual "env" registry) |
| `DOSSIER_REGISTRY_TOKEN` | Auth token for the virtual "env" registry (ephemeral, never persisted to disk). Recommended for CI/CD and agent contexts. |
| `DOSSIER_REGISTRY_USER` | Username for registry authentication |
| `DOSSIER_REGISTRY_ORGS` | Comma-separated org scopes for registry queries |

---

## What It Checks

### 1. Integrity (Checksum)

**Verifies**: Content hasn't been tampered with

**How**:
1. Extracts declared SHA256 hash from frontmatter
2. Calculates actual SHA256 of dossier body
3. Compares hashes

**Result**:
- ✅ Match → Content is intact
- ❌ Mismatch → Content has been modified → **BLOCK**

### 2. Authenticity (Signature)

**Verifies**: Dossier is from claimed author

**How**:
1. Checks if signature present in frontmatter
2. Validates signature format
3. Checks if key is in trusted keys list
4. Verifies signature against content

**Result**:
- ✅ Valid + Trusted → From known author
- ⚠️ Valid + Unknown → Signed but untrusted key
- ❌ Invalid → Signature failed → **BLOCK**
- ⚠️ No signature → Unsigned (warn for high-risk)

#### Managing trusted keys

Trust is a local decision: a valid signature from a key you have not added is
reported as untrusted, never auto-trusted. Keys live in `~/.dossier/trusted-keys.txt`,
one `<public-key> <identifier>` per line.

```bash
ai-dossier keys generate --name my-key   # new Ed25519 pair in ~/.dossier/
ai-dossier keys list                     # what is trusted right now
ai-dossier keys add <public-key> <identifier>
```

`keys add` accepts a raw 44-char base64 key, an SPKI PEM block, or a legacy
minisign `RWT...` key, and stores the **canonical raw base64** form regardless —
so a key added in one encoding still matches a signature carrying another.
Anything it cannot interpret (a typo, a truncated key, a path to a `.pub` file)
is rejected outright rather than written and silently never matching.

> **Passing a PEM needs `--`.** A PEM begins with `-`, which the option parser
> reads as a flag:
> ```bash
> ai-dossier keys add -- "$(cat ~/.dossier/my-key.pub)" "my-key"
> ```
> `ai-dossier verify <dossier>` sidesteps this entirely — it prints a
> ready-to-run `keys add` command with the key already in base64 form.

If `keys list` warns about unusable entries, those keys are **not** trusted; the
warning names the line to fix.

### 3. Risk Assessment

**Analyzes**:
- Dossier risk level (low/medium/high/critical)
- Presence of signature (required for high-risk)
- Checksum status
- Combined security posture

**Outputs**:
- Recommendation: ALLOW, WARN, or BLOCK
- Issue list
- Overall risk level

---

## Examples

### Example 1: Legitimate Dossier (Passes)

```bash
$ ai-dossier verify examples/data-science/train-ml-model.ds.md

🔐 Dossier Verification Tool

ℹ️  Reading: examples/data-science/train-ml-model.ds.md
✅ File read successfully
ℹ️  Parsing dossier...
✅ Parsed: Train ML Model v1.0.0

📊 Integrity Check:
✅ Checksum VALID - content has not been tampered with

🔏 Authenticity Check:
⚠️  No signature present (dossier is unsigned)

🔴 Risk Assessment:
   Risk Level: MEDIUM

Recommendation: ALLOW
✅ Safe to execute
   Dossier passed security verification.

$ echo $?
0
```

### Example 2: Malicious Dossier (Blocked)

```bash
$ ai-dossier verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/security/validate-project-config.ds.md

🔐 Dossier Verification Tool

ℹ️  Downloading: https://...
✅ Downloaded successfully
ℹ️  Parsing dossier...
✅ Parsed: Validate Project Configuration v1.0.0

📊 Integrity Check:
❌ Checksum INVALID - content has been modified!

🔏 Authenticity Check:
⚠️  Signature verification failed (test signature)
   Signed by: DevTools Community <devtools@example.com>

🔴 Risk Assessment:
   Risk Level: CRITICAL

   Issues Found:
   - Checksum verification FAILED - content has been tampered with
   - Signature verification FAILED or could not be verified

Recommendation: BLOCK
❌ DO NOT EXECUTE this dossier
   Security verification failed.
   This dossier may have been tampered with or is from an untrusted source.

$ echo $?
1
```

### Example 3: Shell Integration

```bash
# Add to ~/.bashrc or ~/.zshrc

# Wrapper function for Claude Code
claude-run-dossier() {
  echo "Verifying dossier security..."
  if ai-dossier verify "$1"; then
    echo ""
    echo "✅ Verification passed. Executing with Claude Code..."
    claude-code "Execute the verified dossier at $1"
  else
    echo ""
    echo "❌ Security verification failed."
    echo "   The dossier failed security checks and should not be executed."
    return 1
  fi
}

# Usage
claude-run-dossier https://example.com/dossier.ds.md
```

---

## Registry Configuration

The CLI supports multiple registries for discovering, pulling, and publishing dossiers. Use `dossier config` to manage registries — see [Config Command](#config-command) for CLI usage.

### Configuration File (`~/.dossier/config.json`)

The CLI **auto-creates** `~/.dossier/config.json` the first time you modify settings (e.g., via `dossier config --add-registry`). You do not need to create this file manually. If the file does not exist, the CLI uses built-in defaults (the public registry at `https://dossier-registry.vercel.app`).

```json
{
  "registries": {
    "public": {
      "url": "https://dossier-registry.vercel.app",
      "default": true
    },
    "internal": {
      "url": "https://dossier.internal.example.com"
    },
    "readonly-mirror": {
      "url": "https://mirror.example.com",
      "readonly": true
    }
  },
  "defaultRegistry": "public"
}
```

See [Read-Only Registries](#read-only-registries) for how the `"readonly"` flag affects operations.

To create the config manually:

```bash
mkdir -p -m 700 ~/.dossier
cat > ~/.dossier/config.json << 'EOF'
{
  "registries": {
    "public": {
      "url": "https://dossier-registry.vercel.app",
      "default": true
    }
  }
}
EOF
chmod 600 ~/.dossier/config.json
```

### Resolution Priority

1. `--registry` flag on the command
2. `DOSSIER_REGISTRY_URL` environment variable
3. Project-level `.dossierrc.json`
4. User-level `~/.dossier/config.json`
5. Hardcoded default (public registry)

To verify which registries are active and their resolution order, run:

```bash
dossier config --list-registries
```

### Read-Only Registries

Registries marked `"readonly": true` can be used for read operations (`search`, `get`, `pull`) but **block write operations** (`publish`, `remove`). Attempting a write operation against a read-only registry produces:

```
❌ Registry 'readonly-mirror' is read-only
```

When resolving a write target (e.g., for `publish`), the CLI skips read-only registries and falls back to the first writable registry. If all configured registries are read-only, the CLI returns:

```
❌ No writable registry configured. All registries are read-only.
```

### Per-Command Registry Flag

Write commands accept `--registry <name>` to target a specific registry:

```bash
ai-dossier publish --registry team my-dossier.ds.md
ai-dossier login --registry internal
```

Read commands (`search`, `get`, `pull`) query all configured registries in parallel.

---

## Agent Discovery (`--agent`)

The `--agent` flag outputs a machine-readable JSON manifest describing the CLI's capabilities. This is designed for AI agents that need to discover what the CLI can do programmatically:

```bash
ai-dossier --agent
```

Output includes:
- CLI version and available commands
- Supported flags (`--json`, `-y`/`--yes`)
- Capabilities (multi-registry, non-TTY safe, machine-readable errors)
- Discovery command for full command listing

This enables agents to auto-configure their integration with the Dossier CLI without parsing help text.

---

## Architecture

### How It Works

```
User Command:
ai-dossier verify https://example.com/dossier.ds.md
         ↓
    Download/Read File
         ↓
    Parse Frontmatter
    (Extract metadata)
         ↓
    Calculate SHA256
    (Dossier body only)
         ↓
    Compare Hashes
    ┌────────┴────────┐
    ↓                 ↓
MATCH              MISMATCH
    ↓                 ↓
Check Signature    BLOCK (exit 1)
    ↓
Assess Risk
    ↓
Exit 0 (safe) or 1 (unsafe)
```

### Design Principles

1. **Fail Secure**: Default to blocking on any verification failure
2. **Exit Codes**: Machine-readable results for scripting
3. **Clear Output**: Human-readable for manual use
4. **Minimal Dependencies**: Core verification + commander CLI framework
5. **Fast**: Verification in milliseconds

---

## Capabilities & Limitations

### What's implemented

- ✅ **Checksum verification** (SHA256) — catches any tampering with the dossier body
- ✅ **Signature verification** — Ed25519 (Minisign-compatible) and AWS KMS; signatures are validated, not just detected
- ✅ **Trusted keys** — verified against `~/.dossier/trusted-keys.txt`; manage with `ai-dossier keys`
- ✅ **Risk assessment** — declared risk level + destructive-operation analysis gate execution
- ✅ **Execution** — `ai-dossier run` verifies, then executes if checks pass

### Current limitations

- Verification is a single integrity stage (checksum + signature) plus risk assessment — there is no multi-stage sandbox; the executing agent enforces runtime permissions.
- Trust is local: you decide which keys to trust. A valid signature from an untrusted key is reported as such, not auto-trusted.

---

## Roadmap

### v0.1.0
- ✅ Basic checksum verification
- ✅ Signature presence detection
- ✅ Exit code support
- ✅ URL download support

### v0.2.0
- ✅ Multi-command CLI structure (`ai-dossier <command>`)
- ✅ `ai-dossier run` command with integrity verification (checksum + signature)
- ✅ LLM auto-detection and execution integration

### v0.3.0
- ✅ Modular TypeScript migration
- ✅ Comprehensive test suite (261+ tests)
- ✅ CLI parity with dossier-tools
- ✅ `@ai-dossier` npm scope and CI/CD publishing

### v0.4.0
- ✅ Unified dossier parser across core/cli/mcp
- ✅ JSON output mode (`--json` flag on commands)
- ✅ Registry integration (publish, remove, install-skill)
- ✅ Non-TTY stdin detection

### v0.5.0
- ✅ Multi-registry support with parallel resolution
- ✅ `dossier create` command with meta-dossier templates
- ✅ `dossier export` and `dossier pull` commands
- ✅ Agent discovery (`--agent` flag)
- ✅ Enhanced auth: browser OAuth and env-based tokens

### v0.6.0
- ✅ Unified dossier+skill creation template
- ✅ Pool-aware setup-issue-workflow dossiers
- ✅ `@ai-dossier/worktree-pool` package

### v0.7.0
- ✅ Security hardening (execFileSync, Zod validation)
- ✅ Node 20+ requirement
- ✅ Coverage thresholds enforcement
- ✅ Documentation consistency fixes

### v0.8.x (Current)
- ✅ Zod validation on MCP prompt handlers
- ✅ Complete doc link audit and fix (30+ broken links)
- ✅ Ed25519 + AWS KMS signature verification with trusted-keys
- ✅ `install-skill` / `skill-export` (Claude Code skill bridge)
- ✅ Execution tracing with verified checksum + signer metadata
- ✅ TTL-based version resolution for the content cache

### v1.0.0 (Stable)
- ⏳ Stable, frozen CLI surface and exit-code contract
- ⏳ Deeper integration with major LLM tools
- ⏳ Expanded registry/discovery features

---

## Contributing

### Development Setup

```bash
cd cli
npm link  # For local testing

# Test
ai-dossier verify ../examples/devops/deploy-to-aws.ds.md

# Test with malicious example
ai-dossier verify ../examples/security/validate-project-config.ds.md
```

### Adding Features

**Priority areas**:
1. Full minisign signature verification
2. Trusted keys management
3. --run flag implementation
4. Integration examples for more tools

**See**: [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## Troubleshooting

### "insecure permissions" warning

```
⚠️  Warning: ~/.dossier/credentials.json has insecure permissions (644). Expected 0600. Credentials may have been compromised. Fixing permissions.
```

**What it means**: The credentials file is readable by other users on the system. The CLI expects `0600` (owner read/write only) to protect your authentication tokens.

**How to fix**:

```bash
chmod 600 ~/.dossier/credentials.json
```

The CLI will also attempt to fix permissions automatically when it detects this issue.

**Common causes**:
- Manually creating or editing the file with a text editor
- Copying the file from another system without preserving permissions
- Running the CLI as a different user than the file owner

### "Failed to save credentials"

```
Failed to save credentials to ~/.dossier/credentials.json: <reason>
```

**What it means**: The CLI could not write to the credentials file after `dossier login` or a token refresh.

**How to fix**:

1. **Check directory exists**: The config directory `~/.dossier/` must exist. The CLI creates it automatically, but if creation failed:
   ```bash
   mkdir -p ~/.dossier
   chmod 700 ~/.dossier
   ```

2. **Check write permissions**: Ensure your user owns the directory and file:
   ```bash
   ls -la ~/.dossier/
   # If ownership is wrong:
   sudo chown -R $(whoami) ~/.dossier
   ```

3. **Check disk space**: Ensure the filesystem has available space.

4. **Check for read-only filesystem**: In some container or CI environments, the home directory may be read-only. Use the `DOSSIER_REGISTRY_TOKEN` environment variable instead:
   ```bash
   export DOSSIER_REGISTRY_TOKEN=<your-token>
   ```

### "Registry not found"

```
Registry 'myregistry' not found. Available: public. Run 'dossier config --list-registries' to see configured registries.
```

**What it means**: The `--registry` flag references a registry name that isn't configured.

**How to fix**:

1. List configured registries to see what's available:
   ```bash
   dossier config --list-registries
   ```

2. Add the missing registry:
   ```bash
   dossier config --add-registry myregistry --url https://dossier.example.com
   ```

### "Unreachable registry URL"

When a registry is unreachable, the error appears as part of per-registry error output:

```
❌ Not found in any registry: org/my-dossier
   internal: fetch failed
```

**What it means**: The registry URL is not reachable — the server may be down, the URL may be wrong, or there may be a network/firewall issue. When using multiple registries, the CLI succeeds as long as at least one registry responds (see [Multi-Registry Resolution](#multi-registry-resolution)).

**How to fix**:

1. Verify the URL is correct:
   ```bash
   dossier config --list-registries
   curl -s https://dossier.company.com/health
   ```

2. If the URL is wrong, remove and re-add:
   ```bash
   dossier config --remove-registry internal
   dossier config --add-registry internal --url https://correct-url.company.com
   ```

### "Malformed config file"

```
⚠️  Warning: Could not read config file (Unexpected token ...), using defaults
```

**What it means**: The config file contains invalid JSON. The CLI **does not fail** — it logs a warning and falls back to built-in defaults.

**How to fix**:

1. Validate the JSON:
   ```bash
   python3 -m json.tool < ~/.dossier/config.json
   ```

2. Fix syntax errors, or delete and recreate:
   ```bash
   rm ~/.dossier/config.json
   dossier config --add-registry public --url https://dossier-registry.vercel.app --default
   ```

---

## FAQ

### Q: Why a separate CLI tool?

**A**: Security cannot be enforced through LLM instructions alone. We need code-level enforcement that runs **before** LLMs get involved.

### Q: Does this replace MCP server?

**A**: No, they're complementary:
- **CLI**: Enforcement layer (verify before execution)
- **MCP server**: Convenience layer (tools for LLMs)

Use both for best results.

### Q: Can I use this with any LLM tool?

**A**: Yes! The CLI is tool-agnostic. Create a wrapper function for your specific tool.

### Q: What if I don't want to install it?

**A**: Use the verification script from SECURITY_STATUS.md or manually verify checksums.

---

## Support

**Issues**: https://github.com/imboard-ai/ai-dossier/issues
**Security**: security@imboard.ai
**Discussions**: https://github.com/imboard-ai/ai-dossier/discussions

---

**Remember**: Security is enforced by code, not suggestions. Use this tool to guarantee verification happens.
