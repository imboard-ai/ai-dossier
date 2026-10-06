# Issue #1022: zero-trust secret redaction

Planning artifact stored here because root PLANNING-* files are gitignored; WIP sync forbids force-adding ignored files.

## Type
bug

## Problem
The shared guard misses GitHub OAuth, user-to-server and refresh tokens, provider keys and Authorization token headers. Output and persistence must reject these without echoing input. No existing plan artifact; dependencies #1019/#1020/#1021 were verified shipped by the fleet and the claimed tree starts at origin/main 8376b72.

## Acceptance Criteria
- [ ] `assertNoSecrets` throws for `gho_`, `ghu_`, `ghr_`, `ghs_`, `ghp_`, `github_pat_`, `sk-ant-`, `sk-`/`sk-proj-`, `Bearer x`, and `Authorization: token x`, case-insensitively.
- [ ] `renderHuman`/`renderJson`, `IntentDriver` persistence, and `issueReceipt` each reject a value containing a `ghu_` token (one test per sink).
- [ ] The diagnostic never contains the input.

## Approach
1. Export one immutable credential pattern list from redaction.ts, consumed by the existing assertNoSecrets guard. Preserve prefix-only rejection and case-insensitivity; include all GitHub token families and generic sk- keys.
2. Detect Authorization token headers with optional horizontal space before the colon and whitespace after it. Preserve standalone Bearer detection without broadening to ordinary prose mentioning tokens.
3. Extend status and receipt matrices and add guard tests for prefixes, whitespace, embedded credentials, safe public facts, repeated calls and non-echoing diagnostics.
4. Exercise IntentDriver admission and malicious adapter results; assert no secret is stored or returned, and reconciliation behavior remains fail-closed.

## Reachability Evidence
N/A — no new reachable state. Existing string validation/output paths are repaired for demonstrated credential inputs; no production database query applies to this library security defect.

## Predicted Files
- `packages/zero-trust/src/redaction.ts` — shared immutable pattern policy.
- `packages/zero-trust/src/redaction.test.ts` — direct regression/edge-case tests.
- `packages/zero-trust/src/status.test.ts` — both rendering sinks.
- `packages/zero-trust/src/__tests__/intents.test.ts` — persistence admission and adapter evidence.
- `packages/zero-trust/src/__tests__/receipt.test.ts` — issuance rejection before signing.

## Reusable Code
- assertNoSecrets and SecretRedactionError already protect status snapshots, receipt canonicalization and IntentDriver safeString. index.ts already exports redaction.
- Existing status fixture, FakeAdapter/journal helpers and receipt signer fixtures exercise real boundaries.

## Risk Areas
- Keep existing prefix-only conservatism rather than adding word boundaries or minimum lengths that weaken the guard. Avoid global regex state and mutable exported regex objects.
- Trap index: scan primitive snapshots before JSON escapes whitespace; preserve getter snapshot guarantees (#1004).
- Private zero-trust package needs no version bump or lockfile changes. Preexisting npm audit exception requires unchanged-base proof and one CI retry; no unsolicited dependency update.
- Model selection is unavailable; actual model openai/gpt-6.1-sol. Independent review must be recorded honestly with required redo.

## Test Scope
- Run new targeted regressions against isolated detached origin/main, then fixed HEAD (red-before-green).
- Build zero-trust and run its full vitest coverage suite; make check/make lint and build-all for repository CI gates.
- Review potential regex worst cases, case variants, header whitespace, benign mentions and all credential sinks.

## Open Questions
None.

## Visual Review
- [x] Not required (library only)

## Base Branch
`main`
