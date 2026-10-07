# Issue #1096: per-run boundary evidence

## Type
feature

## Problem
Production runs need their own boundary probe evidence, currently collected only by the VM gate harness.

## Acceptance Criteria
- [ ] AC1 With `FakeVmAdapter` (or a minimal fake if that issue has not landed): a clean probe gives a verdict for which `isCleanHeldVerdict` is true, with `runId` set.
- [ ] AC2 Each of these gives `held: false`: a canary echoed in any guest output (raw, hex, base64), a listener connection, a non-denied probe record, a malformed report line, a missing category, or a broker-abuse request that was accepted.
- [ ] AC3 `runBoundaryVerdict` over two VMs where only the second leaks fails, and the verdict carries the run's ID.
- [ ] AC4 Planted files and listeners are cleaned up on every path, including errors.
- [ ] AC5 The gate suite (`vm-gate.e2e.test.ts`, env-gated) still passes through the moved helpers, and the `zero-trust-vm.yml` KVM job stays green.

## Approach
1. Move canary/listener/broker/root helpers into production boundary-probe; keep harness re-exports and timings/limits.
2. Prepare a session before VM creation; probe the node hostile lifecycle and optional Python witness offline, recording every returned byte and rejecting incomplete commands/reports.
3. Finish in a cleanup-safe path with the run's OutputCollector and ID. Preserve incomplete/failed sessions as failed inputs, never clean evidence.
4. Aggregate each VM's full evidence with evaluateBoundary, rejecting missing per-VM coverage and mismatched IDs. Persist private immutable per-VM inputs via the existing private publication primitives, rejecting secrets before publication.
5. Document APIs and lifecycle, unit-test adversarial inputs and partial setup failures, exercise production probe in env-gated KVM test.

## Reachability Evidence
N/A — controller infrastructure/refactor of an existing gate. No database-reachable product state. The existing hostile gate exercises these operations and authorizeShipping already demands this evidence.

## Predicted Files
- `packages/zero-trust/src/vm/boundary-probe.ts` — production lifecycle and aggregation/persistence.
- `packages/zero-trust/src/vm/boundary-probe.test.ts` — fake VM and real local listener lifecycle tests.
- `packages/zero-trust/src/__tests__/vm-e2e-harness.ts` — re-export moved helpers.
- `packages/zero-trust/src/__tests__/vm-gate.e2e.test.ts` — real production-probe coverage.
- `packages/zero-trust/src/index.ts` — public exports.
- `packages/zero-trust/README.md` — spec of record.

## Reusable Code
evaluateBoundary/parseReports/parseReport; OutputCollector; VmAdapter; validateRequest; privateDir/publishPrivate; assertNoSecrets.

## Risk Areas
Truncation, split canary chunks, missing phase reports, partial setup failure, early cleanup, cross-VM coverage masking, wrong run identity and secret-bearing artifacts must fail closed. Trap index: warm pool can lack private dist; warnings fatal; KVM requires its udev gate. Credential module imports remain isolated. Host endpoints remain runtime-only private data.

## Test Scope
Strict package build, 90/85 coverage, warnings-fatal repository lint, full repo required gates, credential isolation, lifecycle/error/adversarial unit tests and existing KVM workflow. No live external network in unit tests. Package is private, no version bump.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
