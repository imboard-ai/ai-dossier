# Issue #1094: model harness and budget metering

## Problem
The controller admits proposals but has no provider-neutral producer. Owner-approved decision A selects controller-side Chat Completions; the historical scheduling comment is superseded. #1119 will consume this interface for closed typed questions; it is not implemented here.

## Acceptance Criteria
- [ ] The decision record exists with options A, B and C, their trade-offs and the PRD sections that rule out B and C.
- [ ] The OpenAI-compatible adapter parses tool calls, text and malformed responses (bad JSON arguments, an unknown shape, a missing `choices`) without throwing on untrusted content.
- [ ] The API key value never appears in any error, return value, log line or journal. The test plants a recognizable key and scans every output.
- [ ] `meteredComplete` reserves before calling, settles with observed usage, keeps the full hold when usage is unknown, and never calls the provider when the reservation is refused (scenario 9 precondition).
- [ ] A timeout aborts the request and settles conservatively, never as zero.
- [ ] Zero-priced rates (subscription or local models) still enforce the token and time ceilings (PRD §5.1).

## Approach
1. Define controller-only request/result types, bounded arguments and sanitized model errors.
2. Implement injected-fetch non-streaming OpenAI-compatible adapter, call-time environment key, strict response parsing, bounded body and deadline, no redirects, one explicitly budgeted retry.
3. Meter serialized UTF-8 input bytes, output bound and all attempts through existing estimateBudget/reserve/settle; preserve unknown charges and reject admission before any provider call.
4. Add reusable scripted adapter and offline adversarial/real-ledger tests, including transitive VM isolation scanner.
5. Document public APIs and decision A/B/C; no version bump or changeset for private package.

## Reachability Evidence
N/A — controller infrastructure selected explicitly by owner; not a production-data condition. Recorded provider-shaped responses and configured requests exercise each new branch offline.

## Predicted Files
- `packages/zero-trust/src/model/adapter.ts` — types and bounded request helpers (new).
- `packages/zero-trust/src/model/openai-compatible.ts` — injected transport (new).
- `packages/zero-trust/src/model/metered.ts` — budget wrapper (new).
- `packages/zero-trust/src/model/__tests__/scripted-model.ts` — reusable fake (new).
- `packages/zero-trust/src/model/__tests__/model.test.ts` — offline provider/ledger tests (new).
- `packages/zero-trust/src/model/__tests__/isolation.test.ts` — transitive VM import fence (new).
- `packages/zero-trust/src/index.ts` — exports.
- `packages/zero-trust/README.md` — spec of record.
- `docs/features/zero-trust-full-cycle/decisions/model-harness.md` — decision (new).

## Reusable Code
Existing BudgetLedger, estimateBudget, BudgetError, assertNoSecrets and credential-isolation scanner patterns. No imports from GitHub credential modules, including type-only imports.

## Risk Areas
Unknown usage and failed/retried calls retain full holds. Deadline must cover fetch and response body, including injected non-cooperative transports. Snapshot request before estimation to prevent mutation. Never expose transport exception or provider text containing the key. Warm dist may be stale: build before process tests. Biome warnings fail. Coverage 90/85. Known #1084 alone is retried, not repaired.

## Test Scope
Recorded Chat Completions shapes, malformed JSON/schema, UTF-8 argument limit, secret echo/errors/logs/journal, timeout/abort and hanging body, 429/5xx only authorized retry, real temporary BudgetLedger admission/observations/unknown holds/free token and time ceilings. Full package coverage/build, repository lint and CI parity; independent full security/architecture/conformance review.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only).

## Base Branch
Fresh `origin/main`; PR targets `main`.
