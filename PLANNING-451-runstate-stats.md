# Issue #451: CLI: `ai-dossier runstate stats` — per-phase durations from milestone trails

## Problem

Runstate trails already carry every timestamp needed for timing analysis — each milestone
stamps `at=`. But reading that today means hand-parsing issue comments: fetching the JSON,
filtering on the `<!-- runstate:v1 -->` marker, pairing consecutive milestones, and doing
date arithmetic by eye. The data is free at run time; the analysis should cost one command.

Durations are **derived**, never stored — no milestone gains a `duration=` key. This is the
analysis side of the timing decision made in #440.

## Acceptance Criteria

- [ ] AC1 `ai-dossier runstate stats --issue <n> [--repo owner/name] [--json]`: reads the issue's runstate trail and prints a per-phase table: phase, status, started (prev milestone's at), ended (its at), duration (human + seconds). Multi-run trails (multiple `run=` ids) are grouped per run id; the ship `awaiting-merge`→`done` gap is reported as `merge-wait`.
- [ ] AC2 `--issues <a,b,c..d>` (list/range, same parsing as fleet) aggregates across issues: per-phase median/min/max duration, per-run total, and a per-`model=` breakdown when gate milestones carry it (gate-issue ≥1.4.1).
- [ ] AC3 Handles imperfect trails: missing phases, `blocked`/`partial` statuses, literal-unexpanded `at=` values (skip with a warning), and issues with no runstate comments (say so, exit 0).
- [ ] AC4 `--json` emits machine-readable output (per-run phases array + aggregates); the human table uses tabular alignment.
- [ ] AC5 Unit tests with fixture trails covering AC1–AC3 (including a real-world-shaped broken trail).
- [ ] AC6 Read-only: only `gh issue view` calls; no writes, no network beyond gh.

## Approach

1. **New pure module `cli/src/runstate-stats.ts`** — all timing analysis, dependency-free
   and `gh`-free, mirroring how `cli/src/runstate.ts` keeps the protocol pure and
   `cli/src/commands/runstate.ts` owns the I/O. It consumes the `ParsedMilestone[]` that
   `parseMilestones()` already produces, so there is one parser for the wire format.
2. **`parseIssueSelection(raw)`** — fleet's grammar: `1,2,3`, `1..9`, mixed `1,2,5..8`;
   de-duplicated and sorted ascending. Rejects malformed input by name, and caps the
   expanded set so a typo'd range cannot fan out into hundreds of `gh` calls.
3. **`computeRunStats(issue, milestones)`** — groups milestones by `run=` (a resumed run
   keeps its id, so grouping survives resumes), orders each group by `at`, and pairs each
   milestone with the previous **usable** one in its group to get `started`/`ended`/seconds.
   The first milestone of a run has no predecessor → duration unknown, printed `-`.
4. **`merge-wait` relabelling** — a `ship` milestone whose predecessor in the same run is
   `ship status=awaiting-merge` is emitted under the phase name `merge-wait`, so the CI +
   watcher gap is a first-class row rather than hidden inside `ship`.
5. **Imperfect-trail handling** — a milestone whose `at=` is not a real timestamp (the
   literal `$(date -u …)` seen on real trails) is skipped with a warning, **and breaks the
   chain**: the next milestone reports `started=-` rather than silently spanning the hole
   and reporting a duration that is two phases wide.
6. **`aggregate(runs)`** — per-phase median/min/max over every sample, per-run totals, and a
   per-`model=` breakdown keyed off the gate milestone's `model=` (absent on pre-1.4.1
   trails → bucketed as `unknown`).
7. **Command wiring in `cli/src/commands/runstate.ts`** — `registerStatsSubcommand`, reusing
   the existing `fetchMilestones()` (already `gh issue view --json comments`, already has
   the auth/404/network failure taxonomy) plus `requireIssueTarget` guards. Read-only by
   construction: no new subprocess call is added.
8. **Version bump** — `cli/package.json` 0.10.0 → 0.11.0, required by the `version-bump` CI
   check added in #448 because this PR changes `cli/src/**`.

## Reachability Evidence

- State: `runstate stats` output over a real trail | Trigger: an operator running the command
  against an issue that a full-cycle run has already walked | Prod check: this project has no
  production database; the equivalent real-data check is whether trails of the required shape
  actually exist. Ran `gh issue view --json comments` against four real issues —
  `imboard-ai/imboard-monorepo#3684`, `#3685`, `imboard-ai/ai-dossier#440`, `#448` → **31
  runstate milestones across 4 runs**, all eight phases represented | Verdict: **reachable**.
- State: the literal-unexpanded `at=` branch (AC3) | Trigger: a milestone hand-written by an
  agent before the `runstate post` CLI existed | Prod check: same four trails → **1
  occurrence** (`#3684` gate: `at=$(date -u +%Y-%m-%dT%H:%M:%SZ)`) | Verdict: **reachable** —
  and it is exactly the "real-world-shaped broken trail" AC5 asks for, so it becomes a fixture
  verbatim.
- State: the `model=` breakdown (AC2) | Trigger: gate milestones from gate-issue ≥1.4.1 |
  Prod check: 4 trails → **0 occurrences** (all four predate the key; this run's own gate
  milestone is the first) | Verdict: reachable but not yet populated — which is why the spec
  already says "when gate milestones carry it". Absent `model=` buckets as `unknown` rather
  than erroring, and both paths are covered by fixtures.
- State: the batched-timestamp trail (several milestones sharing one `at=`, giving 0s
  durations) | Trigger: an orchestrator posting a phase's backlog at once | Prod check:
  `#3685` → **4 milestones at `19:04:58Z`** | Verdict: reachable; 0s is reported as 0s, not
  as missing.

## Files to Modify

- `cli/src/runstate-stats.ts` — **new**. Issue-selection parsing, run grouping, phase timing,
  `merge-wait` relabelling, aggregation, duration formatting, generic table rendering.
- `cli/src/commands/runstate.ts` — register the `stats` subcommand; human + `--json` rendering;
  `--issue`/`--issues` mutual exclusion; reuse `fetchMilestones`, `requireIssueTarget`.
- `cli/src/__tests__/runstate-stats.test.ts` — **new**. Pure-logic fixtures for AC1–AC3.
- `cli/src/__tests__/commands/runstate.test.ts` — command-level tests for `stats` (mocked gh),
  alongside the existing `post`/`last`/`verify`/`mint` suites.
- `cli/package.json` — version 0.10.0 → 0.11.0 (`version-bump` CI check).

## Reusable Code

- `cli/src/runstate.ts:parseMilestones()` / `parseMilestone()` — the wire-format parser.
  Already tolerant of hand-written milestones, which is exactly what AC3 requires. **Do not
  write a second parser.**
- `cli/src/runstate.ts:PHASES` — canonical phase order; used to order aggregate rows so the
  table reads gate → … → report rather than alphabetically.
- `cli/src/commands/runstate.ts:fetchMilestones()` — `gh issue view <n> --json comments`,
  with the "gh exited 0 but printed non-JSON" and "no comments array" guards already in place.
  Satisfies AC6 for free: `stats` adds no new subprocess.
- `cli/src/commands/runstate.ts:requireIssueTarget()` / `repoArgs()` / `fail()` — the guard
  and failure conventions every other subcommand uses.
- `cli/src/commands/runstate.ts:ghFailure()` — the auth/404/403/network failure taxonomy.

## Risk Areas

- **Chain breaks must not inflate durations.** Skipping a bad-timestamp milestone and then
  pairing across the hole would report one duration covering two phases and look plausible.
  The break is explicit; the following row is `-`.
- **`--issues` fan-out.** One `gh issue view` per issue is unavoidable, but a mistyped range
  (`1..10000`) would issue thousands of calls. Capped, with the cap named in the error.
- **Median definition.** Even sample counts average the two middle values; stated in the code
  so a reader is not left guessing between the two conventions.
- **Clock skew / negative durations.** Milestones are stamped by whichever machine ran the
  phase. A negative gap is reported as-is with a warning rather than clamped to 0 — hiding it
  would hide a real problem.
- **Multi-run ordering.** Two runs on one issue can interleave in comment order after a
  resume; grouping by `run=` first, then sorting each group by `at`, keeps each run coherent.
- No `docs/agent-traps.md` exists in this repo, so there is nothing to grep for prior traps.

## Test Strategy

- **New** `cli/src/__tests__/runstate-stats.test.ts` — pure functions, no mocks:
  - AC1: a clean 8-milestone trail → 8 rows, correct started/ended/seconds, `merge-wait`
    present between the two ship rows, `report` last.
  - AC1 multi-run: two `run=` ids on one issue → two groups, neither borrowing the other's
    timestamps.
  - AC2: `parseIssueSelection` over `1,2,3`, `1..9`, `1,2,5..8`, duplicates, reversed ranges,
    junk, and the over-cap range; aggregation median/min/max on odd and even sample counts;
    `model=` bucketing with and without the key.
  - AC3: missing phases (gate → implement, no setup/plan); `blocked` and `partial` statuses;
    the `#3684`-shaped literal `at=$(date -u …)` fixture (warning + chain break); an empty
    trail; and the `#3685`-shaped batch where four milestones share one timestamp → 0s.
  - Formatting: `formatDuration` boundaries (0s, 59s, 60s, 3599s, 3600s, multi-hour) and the
    table renderer's alignment.
- **Extend** `cli/src/__tests__/commands/runstate.test.ts` — `stats` with a mocked `gh`:
  human output, `--json` shape, `--issue`/`--issues` mutual exclusion, no-milestones exit 0,
  and an assertion that only `gh issue view` is invoked (AC6).
- **Existing suites must stay green**: `npm run test -w cli` (1142 tests at #440), plus
  `npm run test -w packages/core` and `-w mcp-server` for CI parity, and `make build-cli`.
- **End-to-end smoke**: run the built CLI against the four real issues above — the trails that
  produced the fixtures — and confirm the rendered tables match the hand-checked arithmetic.

## Open Questions

(none)

## Visual Review

- [x] Not required (CLI/backend only)

## Base Branch

`main` — PRs for this issue target this branch.
