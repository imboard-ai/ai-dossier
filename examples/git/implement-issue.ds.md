---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Implement Issue — Code and Test",
  "version": "1.0.0",
  "status": "Stable",
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
    "hash": "82187eb600bfea99bbff9e36ee9e3c16eb91db334ca2afeaa5ba972dd733a45b"
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

**Before building**, run the project's auto-fixer to avoid lint iteration loops:

- Node.js with biome: `npx biome check --write .`
- Node.js with eslint: `npx eslint --fix .`
- Python with ruff: `ruff check --fix .`
- Or whatever the project's `lint:fix` script is (check package.json / Makefile)

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

### Step 5: Final Lint Pass

Run lint auto-fixer one more time after tests (test creation may introduce lint issues):

- Same commands as Step 3

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
- [ ] Full test suite was run
- [ ] Pre-existing failures were verified against base branch (not blindly fixed)

## Troubleshooting

**No test framework detected**: Default to vitest (Node.js) or pytest (Python); install if needed.

**Pre-existing test failures**: Run tests on the base branch to confirm. Only fix failures caused by your changes.

**Lint auto-fix breaks code**: Review the changes — some auto-fixes may be incorrect. Revert problematic auto-fixes.

**Tests fail after 2 attempts**: Escalate to user — may need design discussion.
