# Capability Manifest & `ai-dossier cap`

Capabilities are a repo's **deterministic execution units** — the recurring operations
dossiers and workflows need (run focused tests, lint, build, install dependencies,
prepare a worktree) expressed as named commands instead of re-reasoned by an agent on
every use. Per the Progressive Determinism brief (RFC-0001), repos should accumulate
these deterministic implementations and use them as the fast path, with reasoning as
the fallback. The scheduler's slot-cycle (`test.focused` / `lint.run`) is planned to
consume this manifest as its fast path (follow-up #464).

- **Where it lives**: `.dossier/automation/manifest.yaml` in the repo (resolved from the
  directory you run `ai-dossier` in).
- **Portability**: a repo without `.dossier/automation/` is a normal state — `cap list`
  prints an empty list and exits 0. Nothing breaks.
- **Preferred style**: entries should mostly *reference existing repo tooling* — package
  scripts, Makefile targets — rather than duplicate logic:

```yaml
# .dossier/automation/manifest.yaml
version: 1

capabilities:
  test.focused:
    command: npm test -- --silent
    lifecycle: active
    description: Focused vitest suite (fast path for agents)
    assumptions:
      - file-exists: package.json
      - tool-version: node>=20

  lint.run:
    command: npm run lint
    lifecycle: active
    description: Biome check

  test.full:
    command: make test
    lifecycle: shadow        # listed, but not executable yet
    description: Full suite incl. scripts — promote to active when trusted
```

## Manifest schema

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | `1` | no | Manifest format version (currently only `1`; absent = `1`) |
| `capabilities` | mapping | yes | Capability id → entry |
| entry `.command` | string | yes | Command line executed via the shell, in the directory `ai-dossier` runs in |
| entry `.lifecycle` | `active` \| `shadow` | no | `active` (default) = executable; `shadow` = declared but not yet trusted to run |
| entry `.assumptions` | list of probes | no | Preconditions checked **before** the command runs |
| entry `.description` | string | no | What the capability does (shown by `cap list`) |
| entry `.timeout_ms` | number | no | Per-entry command timeout in ms (default 5 min; a timeout is `automation-broken`) |
| entry `.min_duration_ms` | number | no | Sanity floor (#583): a non-zero exit that finishes faster than this is reclassified `automation-broken` instead of `task-failed` — "this probably didn't really run", not a genuine failure. Default 0 (no floor) |

Capability ids are dotted lowercase words (`test.focused`, `worktree.prepare`).

### Assumption probes

Each assumption is a single-key YAML object. **Probes run before exec; if any fails,
the outcome is `automation-broken` and the command never runs.**

| Probe | Example | Check |
|---|---|---|
| `file-exists` | `- file-exists: package.json` | Path (file or dir, relative to the run directory) exists |
| `tool-version` | `- tool-version: node>=20` | `<tool> --version` output satisfies `<op><version>` (ops: `>= > <= < = ==`; `==` is an alias of `=`) |

## `cap list [--json]`

Shows capabilities, lifecycle, command, and description. Absent
`.dossier/automation/` → empty list, success exit. A present-but-malformed manifest is
a hard error (exit 1) with a message naming the problem.

## `cap run <id> [-- args]`

Executes one capability. Extra args after `--` are **shell-quoted and appended** to the
entry's command (`cap run test.focused -- --grep auth` → `npm test -- --silent --grep auth`).
Args are data, not shell syntax — an arg containing `;`, `$()`, or spaces reaches the
command as a single literal word; put shell syntax in the manifest `command` itself.
Only `lifecycle: active` entries execute; a `shadow` entry refuses with
`capability-unavailable`.

**The result is always one of exactly four outcomes**, distinguishable by exit code and
by a JSON envelope printed as the **last stdout line** (child output is passed through
first — consumers read the final line):

| Outcome | Exit code | Meaning |
|---|---|---|
| `ok` | 0 | Command ran and exited 0 |
| `task-failed` | 1 | Command ran and legitimately failed (e.g. red tests) — *the operation's* failure, not the automation's |
| `automation-broken` | 2 | Assumption probe failed · command missing/not executable (shell 126/127) · abnormal termination (signal / exit > 128) · timeout · manifest invalid · a non-zero exit faster than the entry's `min_duration_ms` (#583 — "this probably didn't really run") |
| `capability-unavailable` | 3 | Id not in the manifest, no manifest at all, or `lifecycle: shadow` |

The distinction matters to callers: `task-failed` means "trust the result — the task
itself failed"; `automation-broken` means "do not trust the machinery — fall back to
reasoning"; `capability-unavailable` means "no fast path here — reason from scratch".

> Exit 1 is also the CLI's generic usage-error exit (e.g. a typo'd command). Machine
> consumers should read the envelope's last stdout line — present for every `cap run`
> outcome — rather than the exit code alone, and check stderr for usage errors.

**On any non-`ok` outcome, the envelope also carries `output_tail`** (#583 AC1/AC3) —
the last `--tail-bytes` (default 8192) bytes of the command's combined stdout+stderr,
UTF-8-safe (never splits a multi-byte character). Omitted entirely on `ok`, so a
passing run's envelope stays small. The batch engine's incremental gate uses this for
attribution — a per-gate log file under the project's `runs/` directory and the first
~500 chars in the journal `unit-failed`/`gate-inconclusive` event detail — rather than
requiring a human to grep the raw agent transcript to find out why a gate blocked or
evicted a member.

Envelope example:

```json
{"capability":"test.focused","outcome":"task-failed","command":"npm test -- --silent","exit_code":1,"signal":null,"duration_ms":8421,"reason":null,"output_tail":"FAIL src/foo.test.ts\n  ✗ should do the thing\n"}
```

## Telemetry

Every `cap run` — all four outcomes included — appends one JSON line to
`~/.dossier/caps.jsonl` (append-only, mode 0600; disable with
`dossier config auditLog false`), recording `capability`, `outcome`, `exit_code`,
`duration_ms`, `reason` (why a non-ok outcome happened), `signal`, `cwd`, `timestamp`,
and (non-`ok` outcomes only, #583) `output_tail`. This mirrors the `runs.jsonl` dossier
telemetry but stays a separate file because a capability execution is not a dossier run.

## Capability id vocabulary

Reserved vocabulary for cross-repo consistency (ids are a convention, not enforced —
but use these when they fit):

| Id | Meaning |
|---|---|
| `worktree.prepare` | Create/warm a git worktree for development |
| `worktree.cleanup` | Clean up / return a worktree |
| `dependencies.install` | Install project dependencies (npm/pnpm/uv/…) |
| `test.focused` | Fast, targeted test suite (slot-cycle fast path) |
| `test.full` | Complete test suite |
| `lint.run` | Linter/formatter check (slot-cycle fast path) |
| `typecheck.run` | Type checking (tsc / mypy / …) |
| `build.run` | Build the project |
| `environment.start` | Start dev servers / containers |
| `environment.stop` | Stop dev servers / containers |

## Non-goals (per #463)

Automation mining, shadow-compare execution, and generated-automation lifecycle
tooling are follow-ups under the Progressive Determinism plan. A `shadow` entry today
is inert: listed by `cap list`, refused by `cap run`.
