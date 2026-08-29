# Issue #462: feat(cli): plan:v1 issue-comment artifact — post, get, validate

## Problem
RFC-0001 section C.6 (`rfcs/0001-batch-cycles.md` — referenced as context; the RFC file itself is not committed to this repo). Issues are currently planned up to three times (triage, fleet prep, plan-issue). The fix is one canonical per-issue plan artifact stored on the issue as a comment, validated-and-refined rather than recreated. It must live on the issue (not a PLANNING file) because batch preparation runs before any branch exists.

Scope: `cli/` — new `ai-dossier plan <post|get|validate>` command group; docs: artifact format spec.

## Acceptance Criteria
- [ ] AC1 `plan post --issue N --file <md>` posts a comment beginning `<!-- plan:v1 head=<sha> -->` with sections: Problem, Acceptance Criteria, Predicted Files, Approach, Test Scope; posting again supersedes (readers take the last plan:v1 comment — append-only like runstate)
- [ ] AC2 `plan get --issue N [--json]` prints the latest artifact (parsed fields in JSON mode); distinguishable "no plan" exit
- [ ] AC3 `plan validate --issue N` runs deterministic checks — referenced files exist at current HEAD, head-distance (commits since `head=`), risk-floor path scan of Predicted Files — and emits a JSON verdict `{valid, reasons[]}` without any model call
- [ ] AC4 Format documented; unit tests with mocked `gh`

## Approach
1. New pure protocol module `cli/src/plan-artifact.ts` — the `plan:v1` marker grammar, section parsing (Problem, Acceptance Criteria, Predicted Files, Approach, Test Scope), artifact validation, and the risk-floor path patterns. Pure/deterministic — no `gh`, no network, no fs — mirroring `cli/src/runstate.ts`.
2. Extract the private gh-subprocess helpers from `cli/src/commands/runstate.ts` (exec/exec result taxonomy, ghFailure + GH_FAILURE_CASES, parseGhJson, asString, repoArgs, requireRepoSlug, isSafeArg/hasControlChar, fail, snippet) into a shared `cli/src/gh.ts`, imported by both command files. Tests keep working — they mock `node:child_process`, not the module.
3. New `cli/src/commands/plan.ts` with three subcommands:
   - `post --issue N --file <md> [--repo owner/name] [--dry-run]` — validates the file has all five sections, stamps `<!-- plan:v1 head=<short-sha> -->` (short sha of current HEAD via git, `--head` override available), comments the artifact. Supersede semantics = append-only comments; readers take the LAST plan:v1 comment (same as runstate).
   - `get --issue N [--json] [--repo]` — fetches comments, parses latest plan:v1 artifact. Text mode prints the artifact body; JSON mode prints parsed fields (head, sections, comment url/createdAt). No plan → stderr message + exit 1.
   - `validate --issue N [--repo]` — fetches latest artifact, runs deterministic checks and prints `{valid, reasons[]}` JSON: (a) Predicted Files paths (backticked paths in that section) exist at current HEAD via `git cat-file -e HEAD:<path>`; (b) head-distance = `git rev-list --count <head>..HEAD`; (c) risk-floor scan — Predicted Files matching deterministic patterns (auth, payment/billing, migration/schema, secrets/keys, protocol) are flagged as elevated-risk reasons. `valid=false` for structural failures (no artifact, unparseable, missing head=, referenced file absent); head-distance and risk-floor hits are informational reasons that do not fail validity. No model call anywhere.
4. Register in `cli/src/cli.ts` next to `registerRunstateCommand`; bump `cli/package.json` 0.13.0 → 0.14.0 (AGENTS.md rule: publishable package src change requires version bump; CI version-bump enforces).
5. Docs: new `docs/reference/plan-artifact.md` format spec (marker grammar, sections, supersede semantics, validate verdict shape and check semantics) + index entry in `docs/reference/README.md` + command mention in `cli/README.md` if it lists commands.
6. Tests: `cli/src/__tests__/plan-artifact.test.ts` (pure parsing/validation/risk patterns) and `cli/src/__tests__/commands/plan.test.ts` (mocked `execFileSync` exactly like `commands/runstate.test.ts` — post body shape, supersede/last-wins, get no-plan exit, validate verdicts incl. git stubs).

## Reachability Evidence
- N/A — no new data-reachable state. This is a dev-tooling CLI command group (new command, new comment format), not a user/product flow backed by production data; there is no production datastore for this repo to query. The trigger (an agent running `ai-dossier plan post`) is direct human/agent invocation by construction.

## Files to Modify
- `cli/src/plan-artifact.ts` — NEW: marker grammar, section parser, artifact validator, risk-floor patterns (pure)
- `cli/src/gh.ts` — NEW: gh/git subprocess helpers extracted from runstate command
- `cli/src/commands/runstate.ts` — import shared helpers from `gh.ts`, drop local copies (behavior unchanged)
- `cli/src/commands/plan.ts` — NEW: `plan post|get|validate` command group
- `cli/src/cli.ts` — register the plan command
- `cli/package.json` — version 0.13.0 → 0.14.0
- `cli/src/__tests__/plan-artifact.test.ts` — NEW: unit tests (pure module)
- `cli/src/__tests__/commands/plan.test.ts` — NEW: command tests with mocked gh/git
- `docs/reference/plan-artifact.md` — NEW: artifact format spec
- `docs/reference/README.md` — index the new spec page
- `cli/README.md` — command list mention (if commands are listed)

## Reusable Code
- `cli/src/commands/runstate.ts` — the entire command pattern: exec() failure taxonomy, GH_FAILURE_CASES, parseGhJson/asString, requireIssueTarget/repoArgs/requireRepoSlug, fail(), dry-run/json conventions; extract and reuse rather than reimplement
- `cli/src/runstate.ts` — model for a pure protocol module (marker constant, parser over comment bodies, validation returning string[] errors); `isIssueNumber` is reused directly
- `cli/src/__tests__/commands/runstate.test.ts` + `__tests__/helpers/test-utils.ts` — test harness pattern (vi.mock('node:child_process'), createTestProgram, exit-code capture)
- `cli/src/table.ts` — only if validate needs tabular output; JSON verdict is the contract so probably unused

## Risk Areas
- Extraction of runstate.ts helpers: 910 existing CLI tests are the safety net — they must stay green with zero behavior change (they mock node:child_process at module level, so the extraction is transparent)
- Marker ambiguity: `<!-- plan:v1 head=<sha> -->` must not collide with `<!-- runstate:v1 -->` readers; readers filter on the `<!-- plan:v1` prefix — document that the marker must be the FIRST characters of the comment
- Predicted Files path extraction depends on the authoring format (backticked paths in bullets); the spec must pin the format and the parser must be tolerant of plain `path/to/file` bullets without backticks
- `validate` runs git in the CURRENT repo/cwd — document that it validates against the local clone's HEAD; missing local repo → blocked reason, not a crash
- GitHub comment size cap: same MAX_BODY_LENGTH consideration as runstate (65536 hard GitHub limit); artifacts are plan-sized (small) but `post` should still refuse a file over the cap pre-flight
- Issue #477 (open) consumes these artifacts in plan-issue — overlap warning from gate; read it before finalizing the artifact JSON shape so the consumer contract matches

## Test Strategy
- Pure module: marker parse/build round-trip, section extraction, missing-section errors, last-plan-wins across multiple comments, non-plan comments ignored, Predicted Files path extraction (backticked and bare), risk-floor pattern hits, verdict assembly
- Commands (mocked execFileSync): post validates sections then comments exact body (assert gh args), post --dry-run prints without posting, get JSON shape, get no-plan exits 1, validate reasons for missing file / distance / risk patterns, gh-failure taxonomy reuse
- Existing suite: `npm run test --workspace cli` must stay green (910 tests baseline; 1 flaky on first run, green on re-run)

## Open Questions
(none — ACs are self-contained; the RFC file referenced as context is not in the repo but the issue body fully specifies the requirements)

## Visual Review
- [x] Not required (backend/CLI only)

## Base Branch
`main` — PRs for this issue target this branch.
