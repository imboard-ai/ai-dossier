# Issue #459: feat(cli): support opencode as a spawned agent in ai-dossier run

## Problem
`ai-dossier run` can only spawn Claude Code as its agent CLI: `detectLlm()` auto-detects only `claude` on PATH, and `buildLlmCommand()` only knows `claude -p`. Fleet operation already uses OpenCode (with models like Kimi K3), and the upcoming `dossier-sched` dispatcher (#464) needs `run` to spawn either agent CLI. No comments on the issue beyond runstate milestones — body is the full requirement set.

## Acceptance Criteria
- [ ] AC1 `--llm opencode` spawns a headless opencode run with the dossier content as prompt; auto-detection tries `claude` first, then `opencode`, preserving current default behavior
- [ ] AC2 `--model`, `--permission-mode`-equivalent, and budget flags are mapped to opencode's equivalents where they exist; unsupported flags produce a clear warning, not silent dropping
- [ ] AC3 Run-log entries record which agent CLI was spawned
- [ ] AC4 Unit tests for detection order and command construction for both agents

## Approach
1. `detectLlm()` (helpers.ts): auto path falls through `which claude` → `which opencode`; returns canonical ids `claude-code` / `opencode`; failure message lists both CLIs. Explicit values still pass through unchanged.
2. `LlmExecDescriptor` gains an `agent: 'claude-code' | 'opencode'` discriminator (drives usage parsing and run-log recording).
3. `buildLlmCommand()` gains an `opencode` branch (verified against the locally installed opencode CLI):
   - headless: `opencode run --format json [--model X]`, dossier content piped via stdin (confirmed: `echo prompt | opencode run --format json` reads stdin as prompt; emits JSONL events)
   - interactive: `opencode run -i [--model X] "<content>"` (bare `opencode [project]` takes a project path, not a message — `-i` is the seeded-session interactive mode)
   - `--model` maps to `--model`; `--budget`, `--permission-mode`, `--allowed-tools` have no opencode CLI equivalents → `console.warn` per flag (permissions/tools live in `opencode.json`)
4. New `parseOpenCodeUsage()`: parses opencode's JSONL events — concatenates `type:"text"` parts into `result_text`, sums `input`/`output` tokens and `cost` from `step_finish` parts; `model: null` (not present in events — falls back to requested `--model` alias, never fabricated). Non-JSON line → null.
5. run.ts: dispatch headless usage parsing on `descriptor.agent`; generalize the "unparseable output" warning (currently claude-specific); spawned run-log entries record the resolved agent in `llm` (e.g. `opencode`, not the raw `auto`); "Supported:" error lists `claude-code, opencode, auto`; `--llm` help text mentions opencode.
6. Version bump cli 0.12.0 → 0.13.0 (publishable package `src/` change — CI version-bump gate), CHANGELOG entry.

## Reachability Evidence
- State: `--llm opencode` / opencode auto-detect as spawnable agent | Trigger: user runs `ai-dossier run --llm opencode <dossier>` (or auto with only opencode installed) | Prod check: N/A — not a data-reachable state; CLI flag surface with a documented consumer (#464 dossier-sched "Uses run-spawn machinery from cli/ (see #459 opencode)") and the issue body itself documents fleet operation on OpenCode | Verdict: N/A (no datastore check applicable)

## Files to Modify
- `cli/src/helpers.ts` — detectLlm order + message; LlmExecDescriptor.agent; buildLlmCommand opencode branch + unsupported-flag warnings; parseOpenCodeUsage
- `cli/src/commands/run.ts` — help text for `--llm`/passthrough options; agent-dispatched usage parsing; generalized warning; run-log `llm` records resolved agent for spawned entries; "Supported:" message
- `cli/src/__tests__/helpers.test.ts` — detection order (claude preferred, opencode fallback, none), opencode command construction (headless/interactive/model/unsupported-flag warnings)
- `cli/src/__tests__/agent-usage.test.ts` — parseOpenCodeUsage (JSONL shape from live capture, malformed input, empty)
- `cli/src/__tests__/commands/run.test.ts` — run-log records resolved agent; opencode headless stdout re-emission
- `cli/package.json` — 0.12.0 → 0.13.0
- `CHANGELOG.md` — Unreleased → Added entry

## Reusable Code
- `cli/src/helpers.ts:parseAgentUsage()` — existing claude JSON parser; `parseOpenCodeUsage` mirrors its null-semantics (`AgentRunUsage`, never fabricate)
- `cli/src/helpers.ts:normalizeAllowedTools()` — stays claude-only (opencode has no allowed-tools flag)
- `cli/src/run-log.ts:RunLogEntry` — `llm` + `spawned_command` fields already exist (#458/#475); no schema change needed
- Existing test harness: `vi.mock('node:child_process')` + `vi.mocked(execFileSync)` for `which`; `vi.spyOn(console, 'warn')` for warning assertions

## Risk Areas
- opencode arg limits: interactive mode passes content as a message arg (Linux MAX_ARG_STRLEN ~128KB single-arg cap) — dossiers are typically <50KB; headless (stdin) has no such cap
- `step_finish` token semantics: `input` excludes cache reads (verified: piped 11-word prompt → input 73, cache.read 28736) — record what opencode reports, no adjustment
- Multiple `step_finish` events per run (multi-step agent loops) — sum tokens/cost across all; `result_text` concatenates `text` parts in order
- Don't break `defaultLlm` config (`dossier config defaultLlm opencode` must keep working — plain string passthrough, no validation added)
- CI `version-bump` gate requires the cli package version bump

## Test Strategy
- Unit (existing suites, no live agent execution — `which` mocked):
  - detectLlm: claude present → `claude-code`; claude absent + opencode present → `opencode`; both absent → null; explicit values pass through
  - buildLlmCommand opencode: headless args `run --format json` + stdin content; `--model` forwarded; interactive `run -i` + content arg; budget/permission-mode/allowed-tools → console.warn (spy), not in args
  - buildLlmCommand claude-code: unchanged (regression — existing tests must stay green)
  - parseOpenCodeUsage: captured JSONL fixture → text/tokens/cost; non-JSON line → null; empty → null
  - run command: spawned entries log `llm: 'opencode'` when resolved; claude path unchanged
- Full suite: `npm test` (make test) — baseline green (254 passing)

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
