# Capability Manifest & `ai-dossier cap`

Capabilities are a repo's **deterministic execution units** — the recurring operations
dossiers and workflows need (run focused tests, lint, build, install dependencies,
prepare a worktree) expressed as named commands instead of re-reasoned by an agent on
every use. Per the Progressive Determinism brief (RFC-0001), repos should accumulate
these deterministic implementations and use them as the fast path, with reasoning as
the fallback. The scheduler's batch member gate consumes `typecheck.run` /
`test.focused` from this manifest today (the per-member incremental gate, #583/#625).

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
| entry `.timeout_prone` | boolean | no | The repo's own admission (#777) that this capability routinely runs past any reasonable `cap run` budget. On `test.full` with no active `gate.batch`, `sched enqueue` refuses to form a batch (see [the batch gate](#the-batch-gate-gatebatch-777)). Default `false` |

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

One caller qualifies the first of those, and it is worth knowing about before you write
a capability script (#594): the scheduler's per-member incremental gate only treats a
`task-failed` as a red suite when `output_tail` carries evidence the run EARNED it —
failing-test output for a `test.*` capability, compiler errors for the others. A
capability that exits non-zero having produced no such output is routed to the
block-the-batch path instead of evicting a member, because a wrapper that fabricates its
exit code is otherwise indistinguishable from a genuinely red suite. Practical
consequence: make sure a failing capability lets its runner's own output through, rather
than swallowing it and printing only its own framing.

> Exit 1 is also the CLI's generic usage-error exit (e.g. a typo'd command). Machine
> consumers should read the envelope's last stdout line — present for every `cap run`
> outcome — rather than the exit code alone, and check stderr for usage errors.

**On any non-`ok` outcome, the envelope also carries `output_tail`** (#583 AC1/AC3) —
the last `--tail-bytes` (default 8192) bytes of the command's combined stdout+stderr,
UTF-8-safe (never splits a multi-byte character). Omitted entirely on `ok`, so a
passing run's envelope stays small. The batch engine's incremental gate uses this for
attribution — a per-gate log file under the project's `runs/` directory and the last
~500 bytes in the journal `unit-failed`/`gate-inconclusive` event detail — rather than
requiring a human to grep the raw agent transcript to find out why a gate blocked or
evicted a member.

Capturing this output changes how `cap run` behaves for a human running it directly:
output is now buffered and re-emitted after the command finishes, rather than streamed
live via `stdio: 'inherit'` as before #583 — a long-running command shows nothing until
it completes, instead of showing progress incrementally.

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
| `test.focused` | Fast, targeted test suite (batch member gate fast path) |
| `test.full` | Complete test suite (the batch gate's fallback) |
| `gate.batch` | The gate a batch pays once before its PR — normally the same CI-parity gate a single PR pays (#777) |
| `lint.run` | Linter/formatter check (batch member gate fast path) |
| `typecheck.run` | Type checking (tsc / mypy / …) |
| `build.run` | Build the project |
| `environment.start` | Start dev servers / containers |
| `environment.stop` | Stop dev servers / containers |
| `verify.ui` | Health-check a running app before a live UI verification pass drives it |

### `verify.ui` and the live UI pass

`verify.ui` is a doctor, not a launcher — `environment.start` and `environment.stop` already own the
runtime, and `cap run` buffers a command's output and re-emits it after the child exits, so a command
that never returns would simply time out as `automation-broken`.

Its consumer today is `imboard-ai/git/review-issue`'s Visual Conformance agent, which drives the app in
a headless browser on issues the plan phase flagged `visual_review=true`. That agent needs one thing a
`0` exit cannot express — whether writing to this app is safe — so the contract is a **token on the last
stdout line**:

> `verify.ui` exits 0 and prints `SCRATCH-DB-OK` as its last stdout line when the app answers, its data
> store is a scratch or test instance, and the outbound side-effect sinks its flows can reach (email,
> SMS, payments, webhooks, third-party APIs) are sandboxed or disabled.

Anything else — absent capability, non-zero exit, any other last line — and the consumer drives no
mutating flow at all. A token is required rather than a convention because the alternative is an agent
reading the doctor's source and forming an opinion about it, and judging a script instead of reading a
signal is exactly the substitution a live verification pass exists to remove.

## How the batch member gate consumes these (#625)

`sched`'s per-member gate runs `typecheck.run` then `test.focused` after every batch
member reports review-done. It degrades exactly as the vocabulary above implies —
**declaring them is an optimization, never a prerequisite**:

| Outcome | Gate behaviour |
|---|---|
| `ok` | the member passes that half |
| `task-failed` **with** failing-test evidence | the member is evicted (#594) |
| `task-failed` with no evidence | the batch BLOCKS — a capability that produced nothing did not earn a failure (#594) |
| `automation-broken` | the batch BLOCKS — declared, but its machinery could not be trusted (#583/#585) |
| `automation-broken` whose reason is `command timed out after <N>ms` | **the gate declines the member** — recorded `capability-unavailable` and journalled `gate-skipped-timeout:<id>`; the parent's expensive stage covers it (#681). A timeout is a statement about duration, not about the harness's reliability — and a member touching two workspace roots selects a dependents closure that approaches the whole workspace, so the gate was never "focused" there. The resolved package selection (the capability's own output) is preserved in the per-gate log and `member_gates.output_tail`, with the capability's `duration_ms` beside it |
| `capability-unavailable` | **the check is skipped** and journalled `gate-skipped:<id>`; the member is judged on whatever else is available (#625) |

A repo that declares neither id runs batches end to end. Skipping costs *early*
detection — a bad member's commit may be built on before anyone notices — but not
correctness: the aggregate batch gate (`gate.batch`, else `test.full`) still runs before ship, CI still runs on
the batch PR, and #562's attribution still pins a red suite to the member that caused
it. Declaring the two ids buys earlier, cheaper failure, which is the whole point of
progressive determinism.

The skip is always journalled. A gate that silently does not run is its own trap, and
silence must never read as a pass.

## The batch gate: `gate.batch` (#777)

A batch's `validating` phase runs ONE aggregate gate over the combined work of every
member before the tail agent opens the batch PR. The scheduler resolves it in this order,
each tier preferred to the next:

| Tier | What runs | When |
|---|---|---|
| 0 | `cap run gate.batch` | the manifest declares an **active** `gate.batch` |
| 1 | `cap run test.full` | no active `gate.batch` (or `cap run` reported it `capability-unavailable`) |
| 2 | `dispatch.suite_command` from sched config | neither capability available |
| 3 | the repo's detected test runner | nothing above |

`gate.batch` exists because `test.full` is the wrong gate for a repo whose full suite is
too slow to finish: a batch should pay **the same gate a normal PR pays, once** — e.g. a
CI-parity script, affected-scoped over the union of the members' diffs — not the most
expensive suite the repo has. Its command runs with `cwd` = the batch integration
worktree and two extra environment variables:

| Variable | Value |
|---|---|
| `DOSSIER_BATCH_BASE` | the ref the batch branched from, as a fetchable ref — `origin/<base_branch>` (scope with `git diff "$DOSSIER_BATCH_BASE"...HEAD`) |
| `DOSSIER_BATCH_ID` | the batch id |

```yaml
  gate.batch:
    command: scripts/ci-parity.sh --isolated-db --base "$DOSSIER_BATCH_BASE"
    lifecycle: active
    timeout_ms: 2700000   # its own budget; test.full's is not consulted
    description: CI-parity gate, affected-scoped against the batch base
```

Its outcomes map to the batch exactly as `test.full`'s do: `ok` → green (next member or
the tail); `task-failed` with a parseable vitest JSON report → red, attributed to the
offending member; `task-failed` with no parseable report, or `automation-broken`
(including a timeout) → the batch blocks `suite-unreadable`, every member commit
preserved. A declared capability's verdict is never replaced by a detected-runner retry.

**Attribution needs a report.** Member attribution reads a vitest JSON report from the
gate's stdout. A CI-parity script that prints only its own log gives every red run
`readable: false`, so the batch blocks `suite-unreadable` instead of pinning the failure
on a member. To keep attribution, have `gate.batch` emit a vitest JSON report on stdout
(e.g. `--reporter=json` on its test step).

**Diff with three dots.** `origin/<base_branch>` moves whenever the batch worktree
fetches. `git diff "$DOSSIER_BATCH_BASE"...HEAD` diffs from the merge-base and is stable;
a two-dot diff would pull in upstream changes merged since the batch branched.

**Timeout-prone full gates.** A repo whose `test.full` cannot finish inside any
reasonable budget should say so with `timeout_prone: true`. When that is the only full
gate — no active `gate.batch` — `sched enqueue` refuses to form a new batch and says
why, rather than admitting members into a gate that usually ends `suite-unreadable`.
Declare `gate.batch`, or run those issues as ordinary full cycles. The check reads the
manifest in the directory `enqueue` runs in, and is skipped when `--repo` names another
repository.

## Non-goals (per #463)

Automation mining, shadow-compare execution, and generated-automation lifecycle
tooling are follow-ups under the Progressive Determinism plan. A `shadow` entry today
is inert: listed by `cap list`, refused by `cap run`.
