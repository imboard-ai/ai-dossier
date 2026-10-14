# Issue #1186: Reasoning model requests and rejected-call accounting

## Problem
The live #1115 acceptance run selected gpt-5-mini: max_tokens and default logprobs caused pre-generation HTTP 400 errors, and unknown settlements stranded reservations. #1191 (PR #1214) already supplies Controller.step refusal stop notices and held diagnostics; consume that implementation.

## Acceptance Criteria
- [ ] AC1 Send max_completion_tokens, or make the parameter name a model-profile option, and let the profile disable logprobs.
- [ ] AC2 Budget reasoning tokens in maxOutputTokens.
- [ ] AC3 Release a reservation with no-charge evidence when the provider returns a 4xx before generation.
- [ ] AC4 Record a stop notice when a held reservation blocks step().

## Approach
1. Add validated per-phase maxTokensParameter and logprobs options, with reasoning-family defaults for gpt-5 and o-series. Keep wire serialization and budget input estimates identical and bind profile choices into decision cache identity.
2. Treat maxOutputTokens as the combined visible-plus-reasoning completion bound; account completion_tokens once (reasoning detail is a subset).
3. Retain private adapter-origin rejection evidence only for recognized first-attempt pre-generation OpenAI API errors. Use the existing ledger.release with sanitized evidence; unknown endpoints, malformed or billed responses, transport failures, server failures, and any prior retry stay reserved.
4. Add offline transport/config/decision and durable-ledger regressions, including reopen and next admission. Reuse #1191 notices and tests.
5. Update model-profile/accounting docs and run the package build, focused tests and full CI-equivalent gate.

## Reachability Evidence
N/A — provider-protocol bug fix, not a production database state. The issue records a real gpt-5-mini OpenAI HTTP 400 in live acceptance #1115. Offline recorded-shape responses reproduce the existing path.

## Predicted Files
- `packages/zero-trust/src/model/adapter.ts` — profile and serialization.
- `packages/zero-trust/src/model/openai-compatible.ts` — profile and rejection evidence.
- `packages/zero-trust/src/model/metered.ts` — identical estimate and safe release.
- `packages/zero-trust/src/controller/config.ts` — strict optional phase fields.
- `packages/zero-trust/src/decision/providers/llm.ts` — profile-aware likelihood defaults.
- `packages/zero-trust/src/model/__tests__/model.test.ts` — transport and accounting regressions.
- `packages/zero-trust/src/controller/config.test.ts` — validation regressions.
- `packages/zero-trust/src/decision/__tests__/decision.test.ts` — profile defaults.
- `packages/zero-trust/README.md` — model harness contract.
- `docs/guides/zero-trust-contributions.md` — configuration reference.

## Reusable Code
- BudgetLedger.release records explicit no-charge evidence; settle(null) deliberately retains unknown holds.
- modelRequestBody shares wire bytes with metering; snapshotModelRequest bounds and detaches input.
- createLlmDecisionProvider already hashes endpoint/profile evidence into cache identity.
- Controller.step inherited #1191 stop notices require no duplicate implementation.

## Risk Areas
- HTTP status alone is insufficient billing evidence, especially after retry or with an arbitrary compatible service.
- Completion token details include reasoning tokens; summing details again overcharges.
- Trap index: ignored PLANNING files use docs/planning; warm builds may lack zero-trust dist; null usage remains conservative; retry deadlines cannot widen.
- zero-trust is a private package; check version gate rather than guessing release behavior.

## Test Scope
Recorded OpenAI reasoning/legacy/custom profiles; strict config persistence; metered request-byte bound and combined reasoning usage; first rejection release and reopen; unknown/billed/retried errors retain holds; existing #1191 notice regressions; package and root CI-equivalent tests.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` (updated origin/main including #1191).
