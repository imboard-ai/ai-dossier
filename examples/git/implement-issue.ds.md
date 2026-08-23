---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Implement Issue — Code and Test",
  "version": "1.3.1",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2026-06-25",
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
    "hash": "b03b46d90fa08362daa01715eeaefac882c52e9db820c5ca0266363b489030f0"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "hU39KumGt+ld/LvN2WBqEr/XA+DPQl3yKCEqsSHaCyXU2CQICCseJIv0zdc7k9Q9El1/sP8wrYO2jqKvLF8lBw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-07-26T12:47:33.413Z",
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

Read the planning file at `planning_file` path. Extract:

- The approach (what to implement)
- Files to modify
- Reusable code to leverage
- Test strategy

### Step 2: Implement

1. Implement the solution following existing code patterns
2. Keep changes minimal and focused on the issue
3. Reuse existing functions and utilities identified in the plan's "Reusable Code" section
4. Do not add tests inline — Step 3 handles testing separately

### Step 3: Auto-Fix Lint

**Before building**, run the project's auto-fixer to avoid lint iteration loops.

**First, prefer the project's combined script.** Grep `package.json` / `Makefile` for a single script that bundles everything CI runs — common names: `hygiene`, `hygiene:ci`, `check`, `lint:fix`, `format`, `precommit`. If one exists, run it (or its `:fix` / `:write` variant) — this is the single source of truth and matches what CI will check.

**If no combined script, detect the toolchain and run ALL configured fixers** — running only the linter when the project also uses a separate formatter is the #1 reason CI hygiene fails after local checks pass:

- Biome (combined lint + format): `npx biome check --write .`
- ESLint + Prettier (two separate tools — run BOTH): `npx eslint --fix . && npx prettier --write .`
- ESLint only (no separate formatter — verify there is no `.prettierrc*` or `prettier` in `package.json`): `npx eslint --fix .`
- Python with Ruff (combined lint + format): `ruff check --fix . && ruff format .`

Check config files to identify the toolchain: `biome.json`, `.eslintrc*` / `eslint.config.*`, `.prettierrc*` / `prettier` key in `package.json`, `pyproject.toml`.

### Step 4: Test

1. **Detect test framework**: Look for jest.config, vitest.config, .mocharc, pytest.ini, or test scripts in package.json / pyproject.toml
2. **If tests exist for changed files** — run them. Fix failures (max 2 attempts). If still failing with unclear path, escalate to user.
3. **If no tests exist for the changed code** — create focused unit tests:
   - Test the public API of changed/new modules
   - Cover happy path + key edge cases + error paths
   - Follow existing test patterns and conventions in the repo
   - Place tests where the project convention expects them (e.g., `__tests__/`, `*.test.ts`, `*.spec.ts`)
4. **Run the full test suite** to catch regressions (e.g., `npm test`)
5. **If tests fail**, check whether they are **pre-existing failures** by comparing against the base branch:
   ```bash
   git stash && git checkout <base_branch> && npm test 2>&1 | tail -5 && git checkout - && git stash pop
   ```
   If the same tests fail on `base_branch`, they are pre-existing — ignore them and proceed. Only fix failures caused by your changes (max 2 attempts).

> **Backend registry routes require an integration test (this repo).** If this change adds or modifies a route under `packages/backend/src/api/v1/registry/routes/`, it MUST ship with an integration test that exercises that route in the same PR. A new route without one fails the route-coverage ratchet (`pnpm --filter imboard_be test:route-coverage:check`) in CI — the baseline may only shrink, never grow. Add the test under `tests/integration/` following the existing supertest specs, then confirm the route is now covered with `pnpm --filter imboard_be test:route-coverage`. The human reviews the PR; the agent authors the coverage.

### Step 5: Final Lint Pass + CI-Mode Verify

1. Run lint auto-fixer one more time after tests (test creation may introduce lint issues) — same commands as Step 3.

2. **Verify in CI-check mode before reporting complete.** Run the same checks CI will run, in check (read-only) mode — if anything reports issues that the fixer didn't resolve, fix manually before continuing. CI WILL fail otherwise.
   - Prefer the project's CI script if one exists (e.g., `npm run hygiene:ci`, `npm run check`).
   - Otherwise run check-mode equivalents of every tool in Step 3:
     - Biome: `npx biome check .`
     - ESLint + Prettier: `npx eslint . && npx prettier --check .`
     - Ruff: `ruff check . && ruff format --check .`
   - Also run typecheck if the project has one (`npx tsc --noEmit`, `mypy .`, etc.) — auto-fix doesn't catch type errors.

3. **If this change added a NEW package / workspace / module**, confirm its typecheck and tests are wired into the PR CI pipeline — not just runnable locally. A package that CI never typechecks or tests is a silent blind spot that breaks only under feature pressure later. If the CI wiring is missing and you can add it, do so in this change; otherwise record it in the output as an explicit follow-up.

### Step 6: Output

Report what was done:

```
Implementation complete.
Files changed: <count>
Tests: <created N new / ran N existing> — all passing
Pre-existing failures: <count ignored or "none">
```

List the changed files:

```bash
git diff --name-only
```

## Output

- `changed_files`: list of modified/created files
- `tests_created`: number of new test files created
- `tests_run`: number of test files executed
- `pre_existing_failures`: count of ignored pre-existing test failures

## Validation

- [ ] Planning file was read and approach was followed
- [ ] Implementation addresses the issue requirements
- [ ] Existing code patterns were followed
- [ ] Reusable code from the plan was leveraged (not re-implemented)
- [ ] Lint auto-fixer was run before AND after testing
- [ ] Tests exist and pass for changed code (created if missing)
- [ ] Any new/changed backend registry route ships with an integration test in the same PR (route-coverage ratchet stays green)
- [ ] Full test suite was run
- [ ] Pre-existing failures were verified against base branch (not blindly fixed)
- [ ] CI-mode verification (check-only) passes — including any separate formatter (e.g. Prettier) and typecheck
- [ ] Any newly added package/workspace/module is wired into PR CI (typecheck + tests), or the gap is recorded as a follow-up

## Troubleshooting

**No test framework detected**: Default to vitest (Node.js) or pytest (Python); install if needed.

**Pre-existing test failures**: Run tests on the base branch to confirm. Only fix failures caused by your changes.

**Lint auto-fix breaks code**: Review the changes — some auto-fixes may be incorrect. Revert problematic auto-fixes.

**Tests fail after 2 attempts**: Escalate to user — may need design discussion.

**ESLint passes locally but CI hygiene fails on Prettier**: You skipped Step 3's "ESLint + Prettier are two tools, run BOTH" rule. ESLint does not format. Re-run `npx prettier --write .` then verify with `npx prettier --check .`.
