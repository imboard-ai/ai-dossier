# Issue #441: CI: auto-refresh examples/git snapshot from the registry weekly

## Problem
`examples/git/*.ds.md` is a hand-copied snapshot of the published `imboard-ai/git/*`
dossier family. It drifts within days — it was last refreshed manually in PR #431
(2026-08-23) and is already behind: `full-cycle-issue` 3.6.1 → 3.12.3 published,
`ship-issue`, `setup-issue-workflow`, `fleet-cycle` all moved same-day. Manual refresh
doesn't scale — this needs a scheduled workflow that pulls the latest published
versions, validates them, and opens a PR only when something actually changed.

## Acceptance Criteria
- [ ] AC1 Weekly scheduled workflow (extend `test-examples.yml` or a sibling): for each
      file in `examples/git`, `ai-dossier pull <name> --force`, copy latest from cache,
      and if anything changed open (or update) a single PR
      `chore(examples): refresh git/ snapshot`.
- [ ] AC2 The PR body lists old→new versions per dossier.
- [ ] AC3 `scripts/test-examples.sh` runs on the refreshed set in the same workflow
      before the PR is opened.
- [ ] AC4 No-op weeks create no PR.

## Approach
1. **New `scripts/refresh-examples-snapshot.mjs`** — pure-logic-first, mirroring the
   `scripts/check-version-bumps.mjs` convention (exported functions + a companion
   `.test.mjs`, orchestration in a thin CLI wrapper):
   - `extractVersion(dossierMarkdown)` — parses the `---dossier\n{...}\n---` frontmatter
     JSON block and returns `.version` (or `null` if absent/unparseable).
   - `dossierNameFromFile(basename)` — `full-cycle-issue` → `imboard-ai/git/full-cycle-issue`
     (all current `examples/git/*.ds.md` files map 1:1 onto `imboard-ai/git/<basename>`,
     confirmed against every filename currently in the directory).
   - `cachePathFor(name, version)` — mirrors the CLI's own cache layout
     (`~/.dossier/cache/<owner>/<category>/<name>/<version>.ds.md`), confirmed by an
     actual `pull --force` run in an isolated `$HOME` during planning.
   - `buildPrBody(changes)` — renders the old→new version table (AC2); if `changes` is
     empty, callers never reach this (AC4 short-circuits first).
   - `main()`: for each `examples/git/*.ds.md`, read old version → run
     `node cli/dist/cli.js pull <name> --force` (confirmed unauthenticated/no-login-required
     in CI — see Reachability Evidence) → copy the freshly cached file over the example →
     record `{name, old, new}` only when the file content actually differs (`diff`, not
     just version-string equality, since a checksum/timestamp-only change should still be
     treated as "changed" for AC1's "if anything changed"). Writes the PR body to
     `$RUNNER_TEMP/refresh-pr-body.md` (outside the repo tree, so it never shows up in
     `git status`) and prints `changed=true|false` to `$GITHUB_OUTPUT` when present.
2. **Extend `.github/workflows/test-examples.yml`** with a new job
   `refresh-examples-snapshot`, gated `if: github.event_name == 'schedule'` (same gating
   style already used by `create-issue-on-failure`), reusing the workflow's existing
   weekly `cron: '0 6 * * 1'` trigger rather than adding a second schedule:
   - `permissions: contents: write, pull-requests: write` (job-scoped, matching
     `publish-packages.yml`'s `publish` job — repo default is `read`).
   - checkout → setup-node@22 → `npm ci` → `make build-all` (need `cli/dist/cli.js`
     for both the pull step and `test-examples.sh`).
   - `node scripts/refresh-examples-snapshot.mjs`, capture `changed` output.
   - **If `changed == 'true'`**: run `bash scripts/test-examples.sh` (AC3 — validates the
     *refreshed* working tree, which only this job has, since `test-examples`'s own
     matrix job validates the *pre-refresh* snapshot on every push/PR/schedule run and
     is a separate job on a separate runner). A failure here stops the job before any
     PR step runs — a broken refresh must never open a PR.
   - **If it passed**: commit on a fixed branch `chore/examples-git-refresh` (fixed name,
     not date-stamped, so a second scheduled run before the first PR merges *updates*
     the same PR instead of opening a duplicate — this is what AC1's "open (or update)"
     requires), `git push --force-with-lease`, then `gh pr list --head
     chore/examples-git-refresh --state open --json number` to decide
     `gh pr create --title "chore(examples): refresh git/ snapshot" --body-file
     "$RUNNER_TEMP/refresh-pr-body.md" --base main --head chore/examples-git-refresh`
     vs `gh pr edit <number> --body-file ...` (+ `git push` already updated the branch's
     commit). Git identity: `github-actions[bot]` /
     `github-actions[bot]@users.noreply.github.com`, matching `publish-packages.yml`.
   - **If `changed == 'false'`**: job ends after the refresh step — no test run, no PR
     (AC4).
3. **`scripts/refresh-examples-snapshot.test.mjs`** — unit tests for the three pure
   functions (`extractVersion`, `dossierNameFromFile`, `buildPrBody`) using the vitest
   convention already established by `check-version-bumps.test.mjs`
   (`vitest.scripts.config.mjs`, run via `npm run test:scripts` / `make test`). Network
   calls (`pull`) and git/gh orchestration are intentionally left untested at the unit
   level (same boundary `check-version-bumps.mjs` draws around its own `git()` calls) —
   correctness there is covered by the workflow's own `test-examples.sh` gate (AC3) at
   run time, not by a unit test mocking `child_process`.

## Reachability Evidence
- State: "CI can pull dossiers with no `~/.dossier` login" | Trigger: workflow runs on
  a clean `ubuntu-latest` runner with no prior `ai-dossier login` | Check: ran
  `HOME=<fresh tmpdir> node cli/dist/cli.js pull imboard-ai/git/full-cycle-issue --force`
  during planning → succeeded, printed `✅ imboard-ai/git/full-cycle-issue@3.12.3
  (updated) [public]`, wrote the cache file with no auth prompt. Confirmed in
  `registry-client.ts`: `Authorization` header is only attached `if (this.token)` — GET
  dossier/content endpoints (`registry/api/v1/dossiers/*`) never check for one. Verdict:
  reachable — no CDN/jsdelivr fallback needed, the CLI's own `pull` works unauthenticated
  as-is.
- State: "refreshed `examples/git/*.ds.md` differs from the currently committed copy" |
  Trigger: any dossier in the `imboard-ai/git/*` family being republished since the last
  refresh | Check: not a prod-data question (no user-facing state) — directly observable:
  `full-cycle-issue` alone moved 3.6.1 → 3.12.3 between PR #431 (2026-08-23) and today
  (2026-08-25/26), a 3-day span. Verdict: reachable, and frequently so — this is the
  premise of the issue itself.
- All other aspects of this change (workflow YAML, script logic) are infra/CI, not a new
  user-reachable product state. N/A for reachability.

## Files to Modify
- `.github/workflows/test-examples.yml` — add `refresh-examples-snapshot` job.
- `scripts/refresh-examples-snapshot.mjs` — new. Pull + copy + diff + PR-body logic.
- `scripts/refresh-examples-snapshot.test.mjs` — new. Unit tests for the pure functions.
- `examples/README.md` — no functional change expected; touch only if the refresh
  mechanism needs a one-line mention (optional, low priority).

## Reusable Code
- `scripts/check-version-bumps.mjs` — direct structural template: pure exported
  functions + `CheckUnavailableError`-style loud failure + a thin `run()`/CLI wrapper +
  paired `.test.mjs`. Reused for file layout and the "never fail open" philosophy
  (a pull failure or unparseable frontmatter must error loudly, not silently skip a
  dossier and report a clean diff).
- `scripts/test-examples.sh` — reused as-is for AC3; no changes needed, it already
  walks every `.ds.md` under `examples/` generically.
- `.github/workflows/publish-packages.yml` `publish` job — reused for the
  `permissions: contents: write` job-scoping pattern and the `github-actions[bot]` git
  identity / commit-and-push shape.
- `.github/workflows/test-examples.yml` `create-issue-on-failure` job — reused for the
  `if: github.event_name == 'schedule'` gating idiom on a job sharing the workflow's
  existing triggers.
- `cli/src/commands/pull.ts` — confirms the `--force` re-download semantics and the
  `~/.dossier/cache/<owner>/<category>/<name>/<version>.ds.md` cache layout the refresh
  script copies from.

## Risk Areas
- **Version-bump guard**: `scripts/check-version-bumps.mjs` only flags changes under a
  workspace package's `src/`/`bin/`. This PR touches only `.github/workflows/**`,
  `scripts/**`, and `examples/**` — none of those are inside `cli/src`,
  `packages/core/src`, `mcp-server/src`, or `packages/worktree-pool/src` — so the guard
  reports "no publishable package source changed" and needs no version bump and no
  `no-release-needed` label. Confirmed by reading the guard's `isReleaseRelevant()`
  logic directly, not assumed.
- **Idempotent PR on repeat runs**: using a fixed branch name means a force-push
  overwrites the branch's history each week. Anyone with local commits based on the old
  branch tip would need to rebase — acceptable for a bot-owned branch nobody else should
  be building on, but worth noting in the PR body/commit message so it reads as
  expected, not alarming.
- **`test-examples.sh` failure on a bad upstream publish**: if a newly published
  `imboard-ai/git/*` dossier itself fails validation (e.g. a broken checksum), AC3 means
  the job fails *before* opening a PR — which is correct (never publish a known-broken
  snapshot) but does mean that week is silently a no-PR week from the PR's perspective.
  The job itself still goes red in Actions (visible), and the existing
  `create-issue-on-failure` job only triggers off the `test-examples` job, not this new
  one — a genuinely broken upstream dossier would need a human to notice the red
  workflow run. Out of scope to fix here (AC4 only requires "no-op weeks create no PR",
  which a failed run also satisfies); flagging as a real gap for a future issue rather
  than silently absorbing it into this one.
- **`--force-with-lease` on first run**: the branch won't exist yet on the first
  execution, so the push step must not assume `--force-with-lease` alone works against a
  nonexistent remote ref — plain `git push -u origin chore/examples-git-refresh --force-with-lease`
  handles both the create and update case correctly (git treats a missing remote ref as
  "safe to create"), so no special-casing needed, just confirmed during implementation.

## Test Strategy
- `npm run test:scripts` (`make test`) — new `scripts/refresh-examples-snapshot.test.mjs`
  covering `extractVersion`, `dossierNameFromFile`, `buildPrBody` (including the "no
  changes → empty table / not called" edge implicitly via AC4's short-circuit).
- Manual/CI-level: `workflow_dispatch` is already a trigger on `test-examples.yml` (kept
  general, not scoped to schedule) so the new job can be manually triggered post-merge to
  confirm the real pull → copy → validate → PR path end-to-end without waiting a week —
  note this only if `workflow_dispatch` should also gate the new job (see Open
  Questions).
- `bash scripts/test-examples.sh` continues to run unchanged as part of both the
  existing `test-examples` job and (on a refreshed tree) the new job.
- `make build-all` must succeed for `cli/dist/cli.js` to exist before either pull or
  validate steps run.

## Open Questions
(none — the one candidate ambiguity, whether `workflow_dispatch` should also trigger
`refresh-examples-snapshot` for manual testing, is a judgment call with a safe default:
gate strictly to `schedule` as the issue's AC1 specifies ("Weekly scheduled workflow"),
and rely on `workflow_dispatch` on the whole file plus local testing of the script for
verification instead of widening the auto-PR trigger surface.)

## Visual Review
- [x] Not required (CI workflow / script only, no frontend)

## Base Branch
`main` — PR for this issue targets this branch.
