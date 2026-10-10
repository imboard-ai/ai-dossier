# Issue #1109: zt-run controller CLI

## Problem
Expose the composed zero-trust controller through a repository CLI with closed parsing,
safe output and real maintenance operations. Owner comment 6094631440 requires authenticated
author defaults, displayed explicit consent, verified email overrides and account-bound resume.

## Acceptance Criteria
- [ ] Every subcommand has argument validation, with exit code 3 and a usage line on misuse.
- [ ] `status --json` and `status` carry identical facts (assert the parse of both).
- [ ] `start` on an invalid config exits 3 without creating a run directory. On an unsupported provider it exits 2 with `unsupported_environment`.
- [ ] A second `start`/`resume` on a locked run exits 4.
- [ ] `sweep` without `--apply` deletes nothing.
- [ ] A secret planted in a config value is refused, and no output contains it.
- [ ] The README documents the CLI with an example session, including a hand-off and a resume.
- [ ] Start displays authenticated profile-name/login and numeric-account noreply default, requires interactive consent or `--confirm-author`, and persists the approved identity.
- [ ] Overrides accept only account noreply or verified account emails; resume preserves recorded config and refuses another authenticated account with `author_approval_mismatch`.
- [ ] All listed commands invoke real producers; production has no test-only environment seam.

## Approach
1. Add thin entry point and independently injectable argument/dispatch library. Validate closed flags, config, text and identifiers before constructing commands.
2. Bind actual controller, checkpoint, metrics, adoption, retention and export APIs in the production command adapter.
3. Extend credential-bound composition with loopback authorization and verified author acquisition; retain numeric authenticated identity at every execution boundary.
4. Add explicit unlocked observational RunStore mode, retaining guarded read-only maintenance by default and refusing incomplete/concurrently changed evidence.
5. Extend shared status rendering with approved identity; use fixed messages for errors, OAuth URLs, consent and maintenance counts.
6. Exercise parser injections, actual credential HTTP fakes, durable local stores and built entry subprocesses; document a complete operator session.

## Predicted Files
- `packages/zero-trust/scripts/zt-run.mjs` — real entry.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — closed parser and dispatch.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — production commands.
- `packages/zero-trust/scripts/zt-run.test.mjs` — CLI tests and built smoke.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — real maintenance regression controls.
- `packages/zero-trust/src/controller/wiring.ts` — credential composition and dormant incident cleanup.
- `packages/zero-trust/src/github/contributor.ts` — authenticated author and email reads.
- `packages/zero-trust/src/controller/run-store.ts` — unlocked observational reads.
- `packages/zero-trust/src/controller/run-store.test.ts` — locked writer observational checks.
- `packages/zero-trust/src/status.ts` — author output schema.
- `packages/zero-trust/src/controller/status.ts` — author assembly.
- `packages/zero-trust/README.md` — command contracts and example.

## Reusable Code
RunController start/resume; ContributorAuthorization and listenLoopback; assembleStatus and
renderHuman/renderJson; approveCheckpoint/rejectCheckpoint; readOutcomeBudget;
contributionOutcome/aggregate; recordAdoption; planSweep/applySweep; exportContribution.

## Reachability Evidence
N/A — repository CLI and local filesystem infrastructure, not production-data-dependent states.
Concrete triggers are operator argv, validated local configs and existing durable run stores.

## Risk Areas
Read the full trap index and searched controller/CLI/zero-trust symptoms. Relevant traps:
read-only maintenance must never recover torn journals; author/config digest authority;
credential isolation; missing warm dist; package cwd Vitest; fsync deadlines; safe primitive
status snapshots. Controller modules are trusted; external files and GitHub timing are untrusted.

## Test Scope
Parser misuse matrix for every command; all dispatches; no-output-secret refusals;
human/JSON equality including identity; real writer-lock refusal and unlocked status;
fake /user and /user/emails account controls; actual built help/status smoke;
strict production/test-inclusive typecheck, root lint/build/tests and full package coverage.

## Open Questions
None.

## Visual Review
- [x] Not required (CLI/controller infrastructure).

## Base Branch
`main`; private zero-trust package, no version bump or changeset.
