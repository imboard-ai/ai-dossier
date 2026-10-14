# Issue #1219: Reasoning completion headroom

## Problem
The live gpt-5-mini gate reproduced a defect: the 1,024 total completion cap was exhausted on reasoning before report_decision could finish. Execution's 16,384 cap likewise includes hidden reasoning. Existing accounting correctly settles total completion usage; role caps must be chosen before reservation, never widened by transport.

## Acceptance Criteria
- [ ] AC1 Reasoning profiles provide larger default total completion allowances for typed decisions and planning/implementation/repair, while legacy defaults remain unchanged.
- [ ] AC2 Trusted per-phase profile overrides are validated, persisted, forwarded through composition, and included in decision cache identity.
- [ ] AC3 Reservations cover the exact wire completion cap before dispatch (including retries); reported reasoning-inclusive completion usage settles once, and insufficient budget prevents dispatch.
- [ ] AC4 Truncated reasoning-only replies remain fail-closed; regressions demonstrate the old cap defect and document the new caps without promising model success.

## Approach
1. Resolve role-specific decisionOutputTokens and agentOutputTokens in the existing request profile: 8,192/32,768 for total-completion profiles, 1,024/16,384 otherwise.
2. Use resolved caps when constructing decision and agent-loop requests, preserving explicit decision caller overrides and exact metering/wire semantics.
3. Validate optional positive safe-integer profile caps in controller config and adapter options; preserve the existing profile forwarding and cache fingerprint.
4. Exercise composed custom and default profiles, refused reservations, retry bounds, malformed truncation settlement and cache separation with deterministic offline fixtures.
5. Update user/accounting documentation and run scoped tests, build, lint and package coverage.

## Reachability Evidence
N/A — transport/configuration infrastructure change, no new lifecycle state or data-reachable flow. Existing trigger is a gpt-5-mini phase profile; issue evidence identifies 5/6 failing passes at exactly 1,024 completion tokens in the live/offline reproduction.

## Predicted Files
- `packages/zero-trust/src/model/adapter.ts` — resolve/validate caps.
- `packages/zero-trust/src/model/openai-compatible.ts` — expose trusted options.
- `packages/zero-trust/src/decision/providers/llm.ts` — decision role cap.
- `packages/zero-trust/src/controller/agent-loop.ts` — execution role cap.
- `packages/zero-trust/src/controller/config.ts` — persist caps.
- `packages/zero-trust/src/model/__tests__/model.test.ts` — wire/accounting/truncation regression.
- `packages/zero-trust/src/controller/__tests__/model-profile.test.ts` — actual composed requests.
- `packages/zero-trust/src/controller/config.test.ts` — override validation.
- `packages/zero-trust/README.md` — harness contract.
- `docs/guides/zero-trust-contributions.md` — profile settings.
- `docs/features/zero-trust-full-cycle/acceptance-runbook.md` — reservation explanation.

## Reusable Code
modelRequestProfile, modelRequestBody, meteredComplete, existing config validation and real controller composition fixture.

## Risk Areas
Read AGENTS and full agent-traps; hits: #1186 profile forwarding/estimate equality, no-charge provenance, fs-heavy suite retry, stale pool dist. Larger reservations can refuse a small budget: retain fail-closed admission. No change to global user ceilings or malformed-output acceptance. No paid live call required; deterministic tests establish headroom plumbing, not a provider success guarantee. Peers #1217 interrupts, #1220 handoff evidence, #1223 revision scope are excluded. Actual executor openai/gpt-6.1-sol; no Task/model override available. Private package needs no release bump.

## Test Scope
Red-before-green focused cap regression against isolated base; model/config/composed profile tests; package build, lint and full zero-trust coverage with bounded workers if host-load deadlines flake. Assert wire/ledger equality during fetch, zero fetch on budget refusal, observed total completion counts and malformed result handling.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
