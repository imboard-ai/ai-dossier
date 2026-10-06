# Issue #1008: controller-signed verification receipt and single-use shipping authorization

## Problem
Implement the pure controller receipt contract for the approved zero-trust full-cycle PRD (§5.7/5.9). The receipt must authenticate immutable verification evidence and authorize only explicitly bound, journaled shipping operations. No existing plan artifact was present.

## Acceptance Criteria
- [ ] AC1 Receipt binds exactly the §5.9 fields: schema version; contribution/run/session IDs; contributor login; upstream repository **ID**, issue, default branch; fork repository ID; canonical base/parent SHA and candidate SHA; profile digest; policy digest; per-command evidence (command, exit status, suites counted or `unknown`, sanitized log digest); network policy by phase; issued-at/expires-at; permitted shipping operations.
- [ ] AC2 Canonical serialization (sorted keys, no insignificant whitespace) and SHA-256 receipt digest; signature over the canonical bytes via `packages/core/src/signers` (ed25519).
- [ ] AC3 Shipping authorization: expires 15 minutes after issuance; **single-use per journaled operation** (consumed-nonce set persisted). Verification rejects: bad signature, expired, replayed nonce, wrong parent, wrong contributor, wrong upstream/fork ID, candidate SHA ≠ SHA presented for shipping.
- [ ] AC4 Result vocabulary cannot express a pass for timeout/unreadable/skipped: per-command status ∈ `passed | failed | inconclusive | skipped`; receipt-level `verified` is true only if every required command is `passed`. No string "all tests passed" is ever generated when any status ≠ passed (test).
- [ ] AC5 Renderer for the optional collapsible PR receipt block (§5.7 field list).

## Approach
1. Strict versioned JSON schema and runtime validation from the same schema, bounded primitive fields; immutable snapshots and strict exact identities. Unknown counts, nonzero/unknown exit status and non-passed required results cannot earn verified admission.
2. Canonical recursive sorted-key JSON, domain-separated versioned payload, SHA-256 digest; inject the actual core Signer, require ed25519 and verify against a separately trusted controller key, never trust envelope key alone.
3. Bind operation grants to nonce, kind, target, expected remote SHA and existing Intent key; require a persisted attempted intent and fresh current policy/profile/identity/command/network checks at admission.
4. Dedicated controller-owned consumed-nonce Journal under an exclusive cross-process filesystem lock. Explicit initialization only; missing/corrupt history fails closed. Persist/fsync before returning authorization; no stale-lock stealing after crash. Reconciliation and reauthorization remain controller responsibilities.
5. Render a bounded escaped/redacted HTML details block from validated primitive evidence only, with no logs/credentials or blanket test-success language.

## Reachability Evidence
N/A — explicit greenfield pure cryptographic/authorization mechanism specified by the approved PRD, not a production-data-dependent state. Inputs are independently supervised command evidence plus canonical SHAs; adversarial fixtures exercise admission. Provider shipping wiring is a later slice.

## Predicted Files
- `packages/zero-trust/src/receipt/schema.ts` — versioned schema, types, validation.
- `packages/zero-trust/src/receipt/issue.ts` — canonical issuance and signing.
- `packages/zero-trust/src/receipt/verify.ts` — signature and exact admission bindings.
- `packages/zero-trust/src/receipt/nonces.ts` — durable atomic nonce journal.
- `packages/zero-trust/src/receipt/render.ts` — sanitized optional PR block.
- `packages/zero-trust/src/__tests__/receipt.test.ts` — adversarial receipt and crash/concurrency fixtures.
- `packages/zero-trust/src/index.ts` — exports.
- `packages/zero-trust/package.json` — core signer + schema dependencies.
- `package-lock.json` — workspace dependency synchronization.
- `packages/zero-trust/README.md` — trusted controller integration contract and durability assumptions.

## Reusable Code
- `@ai-dossier/core`: public Ed25519Signer/Ed25519Verifier and Signer/SignatureResult interfaces (actual shape: algorithm/signature/public_key/signed_at), key-material matching.
- `Journal` — fsync-backed JSONL, torn-write/corruption fail-closed, restrictive permissions.
- `idempotencyKey`, `IntentDriver` — immutable contribution/target/kind/SHA operation intents; adapter independently enforces authorization.
- `assertNoSecrets` — reject prohibited credential patterns before persistence/output.

## Risk Areas
- Consume before side effects; a crash after consumption cannot justify retrying without reconciliation and fresh policy/receipt. A stale lock deliberately blocks recovery until owner reconciliation.
- Avoid mutation across async signature verification and consume; reject getters/non-JSON objects using descriptor snapshots.
- Core's signature result and key normalization are exported already; no core package change required.
- Existing hostname fixture trap (#1004): reproduce baseline failures in isolated base before documented external test-only normalization. Native Node 20/22 CI must pass.
- No subagent tools available: security, architecture, quality, performance and conformance reviews performed inline and reported honestly.

## Test Scope
Round-trip actual core signer; schema/identity/parent/SHA/profile/policy/network/required command mismatch; tamper evidence/digest/signature/key; exact injected expiry; failed/inconclusive/skipped/unknown evidence; escaped output/secrets; operation scope and nonce replay after restart; separate processes racing consume; crash/torn journal, missing store, stale lock and fsync failures. Build/lint/full make test for lockfile change, then native PR CI.

## Open Questions
None.

## Visual Review
- [x] Not required (backend library and textual PR receipt renderer; no application UI).

## Base Branch
`main` — fresh origin/main at `53d44e5722c09bdc50532e86f88605c129c72a6d`.
