# Issue #1202: uncertain token cleanup recovery

## Problem
Malformed successful mint responses and transport failures leave unknown credentials in blocked_cleanup forever. The existing operator settlement is unreachable from the CLI.

## Acceptance Criteria
- [ ] AC1 An uncertain installation-token mint journals a conservative expiry bound and settles only after that bound passes, including restart and delayed responses.
- [ ] AC2 Tokens without a fixed lifetime remain unresolved by time; a supported explicit operator command records operator_resolved for the selected run/token after confirmation.
- [ ] AC3 Supported cleanup retries leave blocked_cleanup only after every credential, VM and accounting obligation is settled; recovery and operator resolution require no OAuth or paid work.
- [ ] AC4 The contribution guide documents expiry settlement, operator checks and the recovery command.

## Approach
1. Extend uncertain-mint evidence with an installation-only expiry bound measured after the response/failure is observed, never from request start. Preserve old journal replay.
2. Reuse journal validation for settlement, restricting time settlement to installation tokens (access expiry does not end user refresh authority).
3. Settle expired installation obligations before broker recovery and dormant incident cleanup. Check all unresolved statuses, including unrevocable.
4. Add closed CLI resolve parsing with run, token and confirm-dead required. Under the existing RunStore lifetime lock record the operator acknowledgement, then join normal dormant cleanup without author/OAuth machinery.
5. Document token IDs, manual grant revocation and retained fences. Add broker/replay, parser and real command-binding regression tests.

## Reachability Evidence
N/A — controller infrastructure recovery, not a production-data state. The issue reports an actual live acceptance malformed 201 response; existing broker tests exercise the same uncertain-mint path. Operator recovery acts on existing unresolved journal records.

## Predicted Files
- `packages/zero-trust/src/github/broker.ts` — record bound and settle recovery.
- `packages/zero-trust/src/github/token-journal.ts` — validate durable expiry and local settlement.
- `packages/zero-trust/src/controller/wiring.ts` — dormant cleanup settlement.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — closed resolve command.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — locked operator settlement.
- `packages/zero-trust/src/github/__tests__/broker.test.ts` — uncertain-mint timing/restart tests.
- `packages/zero-trust/scripts/zt-run.test.mjs` — parsing/dispatch tests.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — real persistence and cleanup tests.
- `docs/guides/zero-trust-contributions.md` — recovery guidance.
- `packages/zero-trust/README.md` — broker contract.

## Reusable Code
TokenJournal.record/replay, UNRESOLVED, RunStore cleanup locking, stopStoredRun, existing status rendering and CLI fixed-error output.

## Risk Areas
Delayed responses must not shorten the conservative lifetime. Uncertain transports/crash prefixes without durable bounds must remain operator-resolvable. User access expiry cannot prove refresh-chain death. Preserve VM/accounting blocks, admissions and original tests. Concurrent #1193 identity preparation and #1194 CA changes must stay independent. Trap hits: dormant credential recovery, missing warm dist, fs-heavy test timeouts and shared-worktree state.

## Test Scope
Malformed 201, transport/5xx uncertainty, before/at bound, delayed response, restart, legacy no-bound journals, user-chain negative controls; parser confirmation and UUID validation; real selected-token durable acknowledgement, lock/refusal, remaining-token and resource blocks. Build, lint, zero-trust coverage and repository CI-equivalent suites.

## Open Questions
None.

## Visual Review
- [x] Not required (controller infrastructure and CLI only)

## Base Branch
`main`
