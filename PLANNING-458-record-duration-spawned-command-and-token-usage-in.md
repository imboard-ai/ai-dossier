# Issue #458: feat(cli): record duration, spawned command, and token usage in run log

## Problem
`~/.dossier/runs.jsonl` records only timestamp/dossier/source — no tokens, durations, or spawned command. Without this, we cannot baseline cost per issue nor validate that batching reduces tokens (Batch Cycles RFC-0001, Migration Step 0), and the automation-mining loop has nothing to mine.

## Acceptance Criteria
- [ ] AC1 Each run log entry additionally records: wall-clock duration (ms), the exact agent command spawned (binary + args, prompt content excluded), model id, and exit code
- [ ] AC2 When the spawned agent CLI reports usage (e.g. `claude -p` JSON output mode), input/output token counts and cost are recorded; when unavailable, fields are null — never fabricated
- [ ] AC3 Existing `runs.jsonl` files with old-schema entries still parse (`history` command works on mixed files)
- [ ] AC4 `ai-dossier history <dossier>` displays duration and token/cost fields when present
- [ ] AC5 Unit tests cover: new-schema write, mixed-schema read, usage-unavailable path

## Approach
1. **`cli/src/run-log.ts`**: extend `RunLogEntry` with optional nullable fields (backward compatible): `duration_ms`, `spawned_command`, `model`, `exit_code`, `input_tokens`, `output_tokens`, `total_cost_usd`.
2. **`cli/src/helpers.ts`**: headless `buildLlmCommand` adds `--output-format json` so claude reports usage; new exported `parseAgentUsage(stdout)` parses the result JSON (`usage` object, `total_cost_usd`/`cost_usd`, `modelUsage` fallback, `model`, `result` text) and returns nulls when absent — never fabricates.
3. **`cli/src/commands/run.ts`**: `startTime` at action start; move the post-verification `appendRunLog` to each exit point (exec success/fail, dry-run, no-LLM, unknown-LLM) via a `finishRunLog` helper that stamps `duration_ms` and null-defaults for all new fields; headless spawn switches stdout to `pipe`, parses usage, re-emits the result text (raw stdout fallback when not JSON); `spawned_command` = `cmd + args` joined (stdin/prompt content excluded); `model` = reported model ?? `--model` option ?? null; nested-skip and verification-failed paths get the new fields too (exit_code 0 / 1).
4. **`cli/src/commands/history.ts`**: add DURATION, TOKENS(in/out), COST columns (uses `formatDuration` from `../duration`); `-` for old-schema entries.
5. **`cli/package.json`**: version bump 0.11.0 → 0.12.0 (repo rule: src changes to publishable packages require a bump; CI version-bump job enforces it).

## Reachability Evidence
- N/A — no new user-reachable state; this records telemetry for the existing `run` flow. The flow is demonstrably exercised: 463 old-schema entries in the real `~/.dossier/runs.jsonl` (two appended by this very session), which also makes mixed-schema read (AC3) a real scenario, not a theoretical one.

## Files to Modify
- `cli/src/run-log.ts` — extend `RunLogEntry` schema (new optional nullable fields)
- `cli/src/helpers.ts` — `--output-format json` in headless `buildLlmCommand`; new `parseAgentUsage()` + `AgentRunUsage` type
- `cli/src/commands/run.ts` — timing capture, stdout capture in headless, append at exit points with new fields
- `cli/src/commands/history.ts` — display duration/tokens/cost columns
- `cli/package.json` — version bump
- `cli/src/__tests__/run-log.test.ts` — new-schema write, mixed-schema read
- `cli/src/__tests__/agent-usage.test.ts` (new) — parseAgentUsage: classic usage shape, modelUsage shape, non-JSON/unavailable paths
- `cli/src/__tests__/commands/run.test.ts` — usage recorded when reported; nulls when unavailable; spawned_command/duration_ms/exit_code
- `cli/src/__tests__/commands/history.test.ts` — new columns; old-schema entries render without crash

## Reusable Code
- `cli/src/duration.ts:formatDuration()` — human duration rendering for the history table
- `cli/src/__tests__/helpers/test-utils.ts:createTestProgram()` / `parseNameVersionImpl` — command test harness
- `cli/src/__tests__/run-log.test.ts:makeEntry()` — entry factory pattern for schema tests

## Risk Areas
- Moving `appendRunLog` to after execution means a hard crash mid-spawn loses the entry (today it is written before). Accepted: an entry carrying exit code/duration must post-date execution; two entries per run would corrupt cost baselining.
- Headless stdout is now buffered and re-emitted at completion. `claude -p` text mode already prints only at completion, so effective UX is unchanged; stderr still streams.
- `spawnSync` mocks in existing tests return `{ status: 0 }` with no `stdout` — new code must tolerate undefined stdout (guard in `parseAgentUsage`).
- 463 existing old-schema entries on this machine: every read path must treat new fields as possibly-absent (`?? null` / `-` in display).
- `--output-format json` must not leak into interactive mode (TUI breaks) — only the headless branch of `buildLlmCommand`.

## Test Strategy
- `run-log.test.ts`: append a full new-schema entry and assert JSONL roundtrip includes new fields; read a mixed old+new file, assert both parse and new fields present only on the new entry.
- `agent-usage.test.ts` (new): classic `usage` shape; `modelUsage` (camelCase + snake_case) fallback; `total_cost_usd` vs `cost_usd`; non-JSON stdout → null; empty/undefined stdout → null; missing usage → all-null fields.
- `run.test.ts`: headless spawn returning usage JSON → `appendRunLog` gets tokens/cost/model/exit_code/duration_ms/spawned_command; headless non-JSON stdout → null usage fields + raw stdout re-emitted; interactive → null usage fields; `--model` recorded when no reported model.
- `history.test.ts`: entry with new fields renders duration/tokens/cost; old-schema entry renders `-` without crash.
- Run: `cd cli && npm test`; then `make test` (all workspaces) and `make build` + biome check.

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/CLI only)

## Base Branch
`main` — PRs for this issue target this branch.
