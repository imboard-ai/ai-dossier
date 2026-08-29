# Issue #463: feat(cli): capability manifest and 'ai-dossier cap' with four-way outcome contract

## Problem
Progressive Determinism brief + RFC-0001: capabilities are the scheduler's deterministic execution units and slot-cycle's fast path for `test.focused`/`lint.run`. Repos should accumulate deterministic implementations of recurring operations (test, lint, build, deps install, worktree prep…) that dossiers can invoke directly instead of re-reasoning each time, with reasoning as fallback. Today there is no machine-readable way for a repo to declare these operations, and no CLI surface to execute them with a predictable outcome contract. (No user comments beyond runstate milestones — body alone is sufficient.)

## Acceptance Criteria
- [ ] AC1 Manifest schema: capability id → { command, lifecycle: active|shadow, assumptions?: [file-exists/tool-version probes], description }; entries are mostly references to existing repo tooling (package scripts, Makefiles), documented as the preferred style
- [ ] AC2 `cap list [--json]` shows available capabilities + lifecycle; absent `.dossier/automation/` → empty list, success exit (portability requirement)
- [ ] AC3 `cap run <id> [-- args]` executes only `active` entries and wraps the result in a JSON envelope with exactly four outcomes: `ok`, `task-failed` (operation ran, legitimately failed — e.g. red tests), `automation-broken` (assumption probe failed / command missing / abnormal termination), `capability-unavailable` (not in manifest) — distinguishable by exit code and envelope
- [ ] AC4 Assumption probes run before exec; probe failure → `automation-broken`, command never runs
- [ ] AC5 Every `cap run` appended to the run-log telemetry (capability id, outcome, duration)
- [ ] AC6 Unit tests for all four outcomes and the no-manifest case

## Approach
1. New `cli/src/capability.ts` — the engine: load + validate `.dossier/automation/manifest.yaml` (cwd-relative, `yaml` pkg already a CLI dep), evaluate assumption probes (`file-exists: <path>` relative to cwd; `tool-version: <name><op><version>` via `<name> --version` first-version-token parse + minimal comparator), and execute `command + " " + args` via `spawnSync(shell:true)` from cwd.
2. New `cli/src/cap-log.ts` — capability telemetry: append-only JSONL at `~/.dossier/caps.jsonl` modeled on `run-log.ts` (mode 0600, respects `auditLog` config, never crashes the run). Entries: `{timestamp, capability, outcome, exit_code, duration_ms, cwd}`. Kept separate from `runs.jsonl` because `RunLogEntry` is dossier-run-shaped (dossier/resolved_version/verification/llm are required fields that don't apply); the engine module is the telemetry facility for caps.
3. New `cli/src/commands/cap.ts` — commander group `cap` with `list [--json]` (table via `renderTable`; empty+exit 0 when `.dossier/automation/` absent) and `run <id> [args...]` (args appended after `--`). `cap run` owns its exit codes: ok=0, task-failed=1, automation-broken=2, capability-unavailable=3; prints the JSON envelope as the FINAL stdout line (child stdio inherited so output flows naturally; envelope last-line is the machine contract).
4. `lifecycle: shadow` entries: listed by `cap list` but `cap run` refuses them → `capability-unavailable` with `reason: "lifecycle=shadow"` in the envelope (shadow-compare execution is a non-goal).
5. Register `registerCapCommand` in `cli/src/cli.ts`.
6. Docs: `docs/reference/capabilities.md` — manifest spec, the four-outcome contract + exit codes, probe syntax, and the capability id vocabulary (worktree.prepare, worktree.cleanup, dependencies.install, test.focused, test.full, lint.run, typecheck.run, build.run, environment.start, environment.stop) with preferred style = references to existing repo tooling; index it in `docs/reference/README.md` and add the command to `cli/README.md`.
7. Version bump `cli/package.json` 0.15.0 → 0.16.0 (required by CI `version-bump` job per AGENTS.md — publishable package `src/` change).

## Reachability Evidence
- State: four outcomes of `cap run` | Trigger: developer/agent runs `ai-dossier cap run <id>` in a repo (manifest present or absent) | Prod check: N/A — pure CLI/tooling surface, no production data store exists for capability usage; the consuming flow (scheduler slot-cycle fast path, #460/#464, RFC-0001 epic #474) is in-flight in the same epic and is the documented demand source | Verdict: N/A (not a data-reachable state; refactors/infra/tooling class)

## Files to Modify
- `cli/src/capability.ts` (new) — manifest load/parse/validate, probe evaluation, run engine, outcome types
- `cli/src/cap-log.ts` (new) — capability run telemetry append (~/.dossier/caps.jsonl)
- `cli/src/commands/cap.ts` (new) — `cap list` / `cap run` command group
- `cli/src/cli.ts` — import + register the cap command
- `cli/src/__tests__/commands/cap.test.ts` (new) — fixture manifests + stub commands
- `cli/package.json` — version bump 0.16.0
- `docs/reference/capabilities.md` (new) — spec + vocabulary
- `docs/reference/README.md` — index entry
- `cli/README.md` — command documentation

## Reusable Code
- `yaml` (^2.8.3, existing CLI dep) — manifest parsing
- `cli/src/config.ts` — `CONFIG_DIR`, `ensureConfigDir`, `getConfig('auditLog')` for the telemetry file
- `cli/src/run-log.ts:appendRunLog()` — pattern to model `cap-log.ts` on (appendFileSync, 0600, never-throw)
- `cli/src/table.ts:renderTable()` — `cap list` table output
- `cli/src/helpers.ts:fail()` — error exits for `cap list` (note: fail() exits 1; `cap run` must NOT use it — it owns codes 0–3)
- `cli/src/commands/sched.ts` — commander subcommand-group registration pattern
- `cli/src/__tests__/helpers/test-utils.ts:createTestProgram()` — test harness

## Risk Areas
- Exit-code collision: `fail()` hard-exits 1; `cap run`'s four-way contract needs 0/1/2/3 — `cap run` computes outcome first, prints envelope, then `process.exit(code)` itself; never routes through `fail()`.
- Envelope parseability: child output is inherited (goes to the terminal), envelope is the last stdout line — must be documented as the contract (consumers read the LAST line).
- Manifest root shape: file uses a `capabilities:` root mapping (not a bare top-level id map) so future top-level keys (miner, shadow-compare config) can't collide with capability ids — small spec decision, documented.
- `tool-version` parse fragility: take the first version-like token from `<tool> --version` output; support ops `>= > <= < =`; missing binary → automation-broken.
- CI version-bump gate: `cli/package.json` MUST be bumped (AGENTS.md) — included in plan.
- Windows `shell:true` uses cmd.exe — quoting differs; POSIX is the target environment (Node 20+ dev machines); noted, not blocking.

## Test Strategy
- `cli/src/__tests__/commands/cap.test.ts` with REAL fs fixtures in tmp dirs (engine does real spawns):
  - ok: manifest + stub command `node -e "process.exit(0)"` → envelope ok, exit 0
  - task-failed: stub exits 1 → envelope task-failed, exit 1
  - automation-broken (3 ways): failed `file-exists` probe (command must NOT run — assert via a probe-guard script that writes a sentinel file); missing binary command; abnormal termination (`node -e "process.kill(process.pid,'SIGKILL')"`)
  - capability-unavailable: unknown id; and shadow lifecycle id → refuses with reason
  - no-manifest: `cap list` → empty + exit 0; `cap run x` → capability-unavailable
  - telemetry: cap-log appends entry with capability/outcome/duration (mock `../config` + fs like `run-log.test.ts`, unit-test `appendCapLog` separately)
  - `cap list --json` shape; args passthrough (`-- -- foo` appended to command)
- Full suite: `make test` (baseline was green: 254 tests)

## Open Questions
(none — design decisions above are mechanical and documented in the plan/PR)

## Visual Review
- [x] Not required (backend/CLI only)

## Base Branch
`main` — PRs for this issue target this branch.
