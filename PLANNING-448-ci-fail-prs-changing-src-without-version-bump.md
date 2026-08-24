# Issue #448: CI: fail PRs that change a publishable package's src without bumping its version

## Problem

Twice in two days a feature merged with its package version unbumped, so
`publish-packages.yml`'s `Check if <pkg> needs publishing` step compared `CURRENT` to the
already-published version, found them equal, and silently skipped the release. npm then
lagged `main` (#442 for worktree-pool 0.5.2, #446 for cli 0.10.0). "Merged" quietly stopped
meaning "released".

The publish workflow's skip is correct behaviour — republishing an identical version is
impossible. The missing control is at PR time: nothing tells the author that the change they
are merging will never reach npm.

No comments on the issue beyond the agent pickup; the body alone is sufficient.

## Acceptance Criteria

- [ ] AC1 A PR check (job in the existing CI workflow, or a script it calls) that, for each publishable package (packages/core, cli, mcp-server, packages/worktree-pool), fails when the PR diff touches that package's `src/**` (or `bin/**`) but its `package.json` `version` equals the version on origin/main.
- [ ] AC2 Version-only and docs/test-only changes pass; changing src in two packages requires two bumps.
- [ ] AC3 The failure message names the package and the exact fix (`bump <pkg> version`).
- [ ] AC4 An escape label (`no-release-needed`) skips the check for genuinely internal changes, and the check says so when skipped.
- [ ] AC5 Covered by a test (script-level or workflow-level fixture) so the guard itself can't silently break.

## Approach

1. **New script `scripts/check-version-bumps.mjs`** — plain Node ESM, zero runtime deps.
   Lives in `scripts/` (not in any publishable package) so that editing the guard itself
   never trips the guard.
2. **Auto-discover publishable packages** from the root `package.json` `workspaces` globs:
   a workspace is publishable when its `package.json` has a `name` + `version` and is not
   `"private": true`. Today that resolves to exactly the four packages AC1 names
   (`registry` is `private: true` and is correctly excluded). Auto-discovery means a future
   fifth package is guarded on day one instead of being silently unprotected.
3. **Release-relevant file predicate.** A changed path counts when it is under
   `<pkg>/src/**` or `<pkg>/bin/**` **and** is not a test file. This exclusion is load-bearing,
   not cosmetic: every package in this repo keeps its vitest specs *inside* `src/` as
   `*.test.ts` (17 in core, 51 in cli, 14 in mcp-server, 7 in worktree-pool). Without the
   exclusion, AC2's "test-only changes pass" would be false on the very first test-only PR.
   Excluded: `*.test.*` / `*.spec.*`, and anything under `__tests__/`, `__mocks__/`,
   `__fixtures__/`, or `fixtures/`.
4. **Version comparison against the merge base.** Head version comes from the checked-out
   `<pkg>/package.json`; base version from `git show <mergeBase>:<pkg>/package.json`. Equal
   version + release-relevant change = violation. A package whose `package.json` does not
   exist on the base ref is brand new — no bump required (its first publish is the release).
5. **Escape hatch (AC4).** `--labels` receives the PR's labels as CSV; when it contains
   `no-release-needed` the script prints an explicit "skipped by label" line and exits 0.
   The workflow passes `join(github.event.pull_request.labels.*.name, ',')`.
6. **Wire into `.github/workflows/ci.yml`** as a new `version-bump` job (checkout with
   `fetch-depth: 0` so the merge base is reachable). Runs on every PR alongside `lint`/`test`.
7. **Test (AC5)** — `scripts/check-version-bumps.test.mjs`, vitest (repo convention), driving
   the pure `analyze()` core with synthetic file lists plus a real end-to-end run against a
   throwaway git fixture repo, so both the matching logic and the git plumbing are covered.
   Wired into `make test` / `make test-coverage` via a root `test:scripts` script so the CI
   `test` job already executes it.

## Reachability Evidence

- State: PR-time version-bump violation | Trigger: a PR diff touching `<publishable-pkg>/src/**`
  with an unchanged `version` | Prod check: **N/A — no production data path.** This is
  repo-internal CI infrastructure; there is no user-reachable state and no prod database to
  query. Reachability is instead established by two real occurrences in repo history:
  PR #442 (worktree-pool 0.5.2 unbumped) and PR #446 (cli 0.10.0 unbumped), both cited in the
  issue. Verdict: reachable (2 confirmed historical occurrences).

## Files to Modify

- `scripts/check-version-bumps.mjs` — NEW. Guard implementation; exports `discoverPackages`,
  `isReleaseRelevant`, `analyze` for testing, plus a CLI entry point.
- `scripts/check-version-bumps.test.mjs` — NEW. Vitest coverage of the pure logic and of an
  end-to-end run against a temporary git repo fixture.
- `.github/workflows/ci.yml` — add the `version-bump` job (checkout `fetch-depth: 0`,
  fetch base branch, run the script with `--base`/`--labels`).
- `package.json` (root) — add `vitest` devDependency + `test:scripts` script.
- `vitest.scripts.config.mjs` — NEW. Scopes the root vitest run to `scripts/**/*.test.mjs`
  so it does not collide with the per-workspace vitest configs.
- `Makefile` — run `test:scripts` from the `test` and `test-coverage` targets.

## Reusable Code

- `.github/workflows/ci.yml` — existing `lint` / `test` job shape (checkout@v4 +
  setup-node@v4 with `cache: 'npm'`); the new job mirrors it rather than inventing a new one.
- Root `package.json` `workspaces` array — already the single source of truth for which
  directories are packages; the script reads it instead of hardcoding a fifth copy of the list
  (`publish-packages.yml` already hardcodes it four times, which is precisely the drift this
  guard should not add to).
- `publish-packages.yml`'s `Check if <pkg> needs publishing` steps — the semantics the guard
  mirrors at PR time (`CURRENT == PUBLISHED` ⇒ skip); the guard's job is to make that skip
  impossible to reach unintentionally.
- Node 20+ builtins only (`node:fs`, `node:path`, `node:child_process`) — the repo requires
  Node >= 20, so no dependency is needed for glob expansion of the simple `packages/*` pattern.

## Risk Areas

- **Tests live inside `src/`.** The single highest-risk detail (see Approach 3). If the test
  exclusion regresses, every docs/test-only PR starts failing CI. Covered by an explicit unit
  test asserting a `src/foo.test.ts`-only diff passes.
- **Merge-base availability.** `actions/checkout@v4` defaults to a shallow clone; without
  `fetch-depth: 0` (or an explicit `git fetch origin main`) `git merge-base` fails. The script
  fails loudly with a clear message rather than silently passing if the base ref is unreachable —
  a guard that fails open is worse than no guard.
- **Guard self-reference.** Keeping the script in `scripts/` (never in a package `src/`) is
  what prevents an infinite "bump to change the bumper" loop.
- **Root vitest vs. workspace vitest.** The repo has four workspace `vitest.config.ts` files.
  The root run must be scoped by explicit `include` to `scripts/**` only, or it would re-run
  (or double-count) workspace suites.
- **New package edge case.** A package added in the same PR has no `package.json` on the base
  ref; treated as exempt, with a test.
- `docs/agent-traps.md` does not exist in this repo — nothing to grep.

## Test Strategy

- New unit tests (`scripts/check-version-bumps.test.mjs`):
  - src change + unchanged version ⇒ violation, message names the package and `bump <pkg> version`
  - src change + bumped version ⇒ pass
  - `package.json`-only (version-only) change ⇒ pass (AC2)
  - docs-only and `src/**/*.test.ts`-only changes ⇒ pass (AC2)
  - two packages' src changed, one bumped ⇒ exactly one violation, naming the unbumped one (AC2)
  - `bin/**` change ⇒ treated like `src/**`
  - private workspace (`registry`) src change ⇒ ignored
  - `no-release-needed` label ⇒ skipped with an explicit "skipped" line (AC4)
  - new package absent on base ⇒ exempt
  - end-to-end: a temp git repo with two commits, run the real CLI entry point, assert exit
    code and stdout
- Existing suites: `make test` (all workspaces) must stay green; `npm run lint` (Biome) must
  pass on the new files.
- Self-check: this PR itself touches no publishable package's `src/`, so the new guard passes
  on its own PR — verified by running the script locally against `origin/main`.

## Open Questions

(none)

## Visual Review

- [x] Not required (backend/infra only)

## Base Branch

`main` — PRs for this issue target this branch.
