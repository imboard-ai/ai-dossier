---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Implement Issue — Code and Test",
  "version": "1.7.2",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2026-08-25",
  "objective": "Implement the solution described in the planning document, run tests, and auto-fix lint issues",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "implement",
    "test"
  ],
  "risk_level": "medium",
  "requires_approval": false,
  "risk_factors": [
    "modifies_files"
  ],
  "inputs": {
    "required": [
      {
        "name": "planning_file",
        "description": "Path to the PLANNING-{number}-{slug}.md file",
        "type": "string"
      }
    ],
    "optional": [
      {
        "name": "base_branch",
        "description": "Base branch for comparing pre-existing test failures",
        "type": "string",
        "default": "main"
      },
      {
        "name": "run_id",
        "description": "Runstate run id minted by gate-issue; pass through unchanged",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "implement-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "5956115a9cdcf70c3188810d87aa80a5fda46487c073323d2d871e5e7c02137b"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "5WxbkadA8xzBSasCGd0o3vYg3hKwucnMEMLmEvpBCHfQHfLbb4h/1fDCMNhXiBG1RSrUyZRKOMVjZzKN4PaqAQ==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-25T19:26:53.630Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Implement Issue — Code and Test

## Objective

Implement the solution described in the planning document. Code the changes, run tests, create tests if missing, and auto-fix lint issues.

## Prerequisites

- You are in the correct worktree/directory for this issue
- A `PLANNING-{number}-{slug}.md` file exists with an approved plan
- The codebase builds and tests pass on the base branch

## Actions to Perform

### Step 1: Read the Plan

Read `planning_file`. Extract: the approach, files to modify, reusable code to leverage, the test strategy.

### Step 2: Implement

1. Implement the solution following existing code patterns
2. Keep changes minimal and focused on the issue
3. Reuse existing functions and utilities identified in the plan's "Reusable Code" section
4. Do not add tests inline — Step 3 handles testing separately

### Step 3: Auto-Fix Lint

**Before building**, run the project's auto-fixer to avoid lint iteration loops.

**If `scripts/ci-parity.sh` exists, run `bash scripts/ci-parity.sh` instead of detecting the toolchain** — it is the project's own definition of what CI enforces. Record `ci_parity=pass` (passed first time), `fail-then-fixed` (you fixed and re-ran), `blocked-external` (the script aborts on a pre-existing shared-resource condition — e.g. the test-cluster collection cap — and you ran its gates individually instead; name the condition in the milestone as `ci_parity_note=`), or `skipped` (no script — use the fallback below), and carry it to the runstate milestone.

**If no ci-parity script, prefer the project's combined script.** Grep `package.json` / `Makefile` for one script bundling everything CI runs — `hygiene`, `hygiene:ci`, `check`, `lint:fix`, `format`, `precommit`. Run it (or its `:fix` / `:write` variant): single source of truth, matching what CI checks.

**If no combined script, detect the toolchain and run ALL configured fixers** — running only the linter when the project also uses a separate formatter is the #1 reason CI hygiene fails after local checks pass:

- Biome (combined lint + format): `npx biome check --write .`
- ESLint + Prettier (two separate tools — run BOTH): `npx eslint --fix . && npx prettier --write .`
- ESLint only (no separate formatter — verify there is no `.prettierrc*` or `prettier` in `package.json`): `npx eslint --fix .`
- Python with Ruff (combined lint + format): `ruff check --fix . && ruff format .`

Check config files to identify the toolchain: `biome.json`, `.eslintrc*` / `eslint.config.*`, `.prettierrc*` / `prettier` key in `package.json`, `pyproject.toml`.

### Step 4: Test

1. **Detect the test framework**: jest.config, vitest.config, .mocharc, pytest.ini, or test scripts in package.json / pyproject.toml
2. **If tests exist for changed files** — run them, fixing failures (max 2 attempts). Still failing with no clear path → escalate to user.
3. **If no tests exist for the changed code** — create focused unit tests:
   - Test the public API of changed/new modules
   - Cover happy path + key edge cases + error paths
   - Follow existing test patterns and conventions in the repo
   - Place tests where the project convention expects them (e.g., `__tests__/`, `*.test.ts`, `*.spec.ts`)
4. **Run tests scoped to what changed** — a full-suite run on a large monorepo costs minutes and buys little:
   - pnpm: `pnpm --filter "...[<base_branch>]" run test`
   - npm/yarn workspaces: run `test` in each workspace whose files appear in `git diff --name-only <base_branch>`
   - single package: full suite
   ESCAPE HATCHES — affected-filtering is known to skip everything in these cases. If the diff touches `scripts/**`, `.github/**`, lockfiles, or adds a new package directory, ALSO run the repo's shell tests / full suite. Record the counts for the runstate milestone.
5. **If tests fail**, check whether they are **pre-existing failures** by comparing against the base branch:
   ```bash
   git stash && git checkout <base_branch> && npm test 2>&1 | tail -5 && git checkout - && git stash pop
   ```
   If the same tests fail on `base_branch`, they are pre-existing — ignore them and proceed. Only fix failures caused by your changes (max 2 attempts).

> **Backend registry routes require an integration test (this repo).** If this change adds or modifies a route under `packages/backend/src/api/v1/registry/routes/`, it MUST ship with an integration test that exercises that route in the same PR. A new route without one fails the route-coverage ratchet (`pnpm --filter imboard_be test:route-coverage:check`) in CI — the baseline may only shrink, never grow. Add the test under `tests/integration/` following the existing supertest specs, then confirm the route is now covered with `pnpm --filter imboard_be test:route-coverage`. The human reviews the PR; the agent authors the coverage.

### Step 5: Final Lint Pass + CI-Mode Verify

1. Run lint auto-fixer one more time after tests (test creation may introduce lint issues) — same commands as Step 3.

2. **Verify in CI-check mode before reporting complete.** Run the same checks CI runs, read-only; fix anything the auto-fixer didn't resolve before continuing. CI WILL fail otherwise.
   - If `scripts/ci-parity.sh` exists, run `bash scripts/ci-parity.sh` — it is the authority; update `ci_parity` accordingly.
   - Otherwise prefer the project's CI script if one exists (e.g., `npm run hygiene:ci`, `npm run check`).
   - Otherwise run check-mode equivalents of every tool in Step 3 — Biome: `npx biome check .`; ESLint + Prettier: `npx eslint . && npx prettier --check .`; Ruff: `ruff check . && ruff format --check .`
   - Also run typecheck if the project has one (`npx tsc --noEmit`, `mypy .`, etc.) — auto-fix doesn't catch type errors.

3. **If this change added a NEW package / workspace / module**, confirm its typecheck and tests are wired into the PR CI pipeline, not just runnable locally — a package CI never checks is a silent blind spot. Add the wiring in this change if you can; otherwise record it in the output as an explicit follow-up.

### Step 6: Output

Report what was done, and list the changed files with `git diff --name-only`:

```
Implementation complete.
Files changed: <count>
Tests: <created N new / ran N existing> — all passing
Pre-existing failures: <count ignored or "none">
```

### Step 6b: Sync to Origin

Before posting the milestone, commit everything and push so origin has the durable copy of this phase's work (WIP sync rule — see full-cycle-issue's Runstate Milestones):

```bash
git add -A && git commit -m "wip(implement): #<issue_number> <slug> [skip ci]" && git push
git rev-parse --short HEAD   # note the pushed sha for the milestone
```

`git add -A` respects `.gitignore` — never force-add ignored files (`.env` etc). Commit only if there are changes. If the phase is ending `blocked` or tests-failing-partial rather than clean `done`, STILL commit and push whatever exists as `wip(implement): partial — <reason> [skip ci]`, before posting the `status=blocked` milestone.

### Step 7: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — if implementation aborts, post `--status blocked --kv reason=<short-slug>` instead and stop. The issue number is the `{number}` in the planning filename. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
ai-dossier runstate post --issue <issue_number> --phase implement --status done --run <run_id> \
  --kv head=<short sha of HEAD> \
  --kv files=<n> \
  --kv tests_added=<n> \
  --kv tests_run=<n> \
  --kv ci_parity=pass|fail-then-fixed|blocked-external|skipped
```

Let the CLI stamp `at=` and compute `next=review` — do not pass either; never hand-write the comment. `head=` is the pushed sha from Step 6b (`git rev-parse --short HEAD` after the push) — never a `-dirty` suffix; by protocol there is no uncommitted work left when this milestone posts.

## Output

- `changed_files`: list of modified/created files
- `tests_created`: number of new test files created
- `tests_run`: number of test files executed
- `pre_existing_failures`: count of ignored pre-existing test failures
- `ci_parity`: pass | fail-then-fixed | skipped
- Posts runstate milestone to the issue (`phase=implement`)

## Validation

- [ ] Planning file was read and its approach followed; implementation addresses the issue requirements
- [ ] Existing code patterns were followed; reusable code from the plan was leveraged (not re-implemented)
- [ ] Lint auto-fixer was run before AND after testing
- [ ] Tests exist and pass for changed code (created if missing)
- [ ] Any new/changed backend registry route ships with an integration test in the same PR (route-coverage ratchet stays green)
- [ ] Tests scoped to the diff were run, plus the full suite when an escape hatch applies
- [ ] Pre-existing failures were verified against base branch (not blindly fixed)
- [ ] CI-mode verification (check-only) passes — including any separate formatter (e.g. Prettier) and typecheck
- [ ] Any newly added package/workspace/module is wired into PR CI (typecheck + tests), or the gap is recorded as a follow-up
- [ ] `scripts/ci-parity.sh` was used when present, and `ci_parity` was recorded
- [ ] Everything was committed (`git add -A`) and pushed to origin before the milestone — including on a `blocked`/partial ending — and milestone `head=` is the pushed sha, never a `-dirty` suffix
- [ ] Runstate milestone comment was posted to the issue

## Troubleshooting

| Symptom | Fix |
|---|---|
| No test framework detected | Default to vitest (Node.js) or pytest (Python); install if needed. |
| Pre-existing test failures | Run tests on the base branch to confirm. Only fix failures caused by your changes. |
| Lint auto-fix breaks code | Review the changes — some auto-fixes may be incorrect. Revert problematic auto-fixes. |
| Tests fail after 2 attempts | Escalate to user — may need design discussion. |
| ESLint passes locally but CI hygiene fails on Prettier | You skipped Step 3's "ESLint + Prettier are two tools, run BOTH" rule. ESLint does not format. Re-run `npx prettier --write .` then verify with `npx prettier --check .`. |
