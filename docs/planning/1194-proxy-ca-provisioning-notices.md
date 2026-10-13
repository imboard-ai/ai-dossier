# Issue #1194: expired proxy CA ends a run as terminal unsupported_environment

## Problem
The operator's 24-hour Squid inspection CA can expire and make mirror fetches fail. Provisioning failures currently durably transition to terminal unsupported, hiding a recoverable infrastructure failure and its excerpt.

## Acceptance Criteria
- [ ] AC1 Before provisioning, check that the proxy CA is still valid, and hand off with a clear notice such as `proxy_ca_expired: restart the proxy (zt-proxy up)`. Don't mark the run terminal.
- [ ] AC2 Don't map a mirror or provisioning failure to the terminal `unsupported_environment`. Keep that for genuine environment refusals (unsupported ecosystem or profile, no KVM).
- [ ] AC3 Record the provisioning failure's excerpt in the run's diagnostic.
- [ ] AC4 Document the CA lifetime in the runbook, or make `up` print the expiry time.
- [ ] AC5 Document that `up --out` must not overwrite the differently shaped run proxy endpoints file.

## Predicted Files
- `packages/zero-trust/src/controller/wiring.ts` — preflight at provisioning allocation and narrow failure mapping.
- `packages/zero-trust/src/controller/proxy-preflight.ts` — bounded X.509 validity check of configured controller CA.
- `packages/zero-trust/src/controller/stop-notice.ts` — fixed recoverable infrastructure actions.
- `packages/zero-trust/src/controller/evidence-runner.ts` — recoverable provisioning error contract.
- `packages/zero-trust/src/ecosystem/classify.ts` — pause rather than terminal environment refusal.
- `packages/zero-trust/src/controller/verifier.ts` — update failure contract documentation.
- `packages/zero-trust/src/controller/proxy-preflight.test.ts` — certificate validity, bounds and file refusals.
- `packages/zero-trust/src/controller/__tests__/provisioning-notices.test.ts` — composed allocation fence, failure excerpt, resume and genuine environment refusal.
- `packages/zero-trust/src/controller/evidence-runner.test.ts` — teardown and nonterminal state assertions.
- `packages/zero-trust/src/controller/verifier.test.ts` — recoverable failure contract.
- `packages/zero-trust/src/ecosystem/classify.test.ts` — recoverable classification.
- `docs/guides/zero-trust-contributions.md` — CA metadata, lifetime and output-file trap.
- `docs/features/zero-trust-full-cycle/acceptance-runbook.md` — operator recovery instructions.

## Approach
1. Add optional controller-only `caCertificateFile` to the closed derived endpoints format (legacy/non-inspecting external proxies remain supported). Document it as required setup for our Squid proxy, pointing at its public certificate.
2. Re-read the certificate before every actual provisioning allocation, using bounded no-follow regular-file reads and X509Certificate validity dates. Expired, not-yet-valid, unavailable/malformed CA yields a fixed actionable hand-off before allocation.
3. Keep failed provisioning cleanup first, then pause durably; retain the failed command's existing bounded redacted log excerpt and digest in diagnostic. Return hand_off and bind a stop notice to the actual stopped history. Clear that notice on retry.
4. Keep genuine UnsupportedEnvironmentError and unsupported ecosystem/profile refusals terminal. Preserve cleanup failure priority and all network restrictions.
5. Exercise actual composed controller paths with physical-edge doubles, including resumed corrected input, zero allocation on CA refusal, redaction, and genuine unsupported controls.

## Reachability Evidence
N/A — infrastructure input, not a production database state. Issue #1194 records an actual #1115 live-run failure: expired inspection CA caused mirror 404 and baseline npm failure. The proxy script generates an OpenSSL certificate with `-days 1`.

## Reusable Code
- `recordStopNotice` and `clearStopNotice` on main bind fixed actions to state/history.
- Evidence runner already retains bounded, redacted LogArtifact and destroys failed workspaces.
- Existing composed `rig` injects only VM/GitHub/model/clock edges and exposes durable artifacts.

## Risk Areas
- Concurrent #1193 identity/pre-start OAuth and #1202 token expiry share wiring; constrain edits to provisioning allocation and failure mapping. #1191 is not a dependency; do not import its unmerged controller changes.
- Preserve cleanup precedence, credential cleanup and provisioning network proof; never broaden routes or retry automatically.
- Existing endpoints have no CA metadata; explicitly document backward-compatible non-inspecting proxy omission rather than guess a filesystem path.
- Agent traps: package build required after a stale pool claim; filesystem-heavy tests may need bounded reduced parallelism; global published absolute CLI avoids stale pool dist.

## Test Scope
Certificate validity and malformed/unreadable/oversize/symlink cases; composed expired certificate (zero VM/model work), mirror failure (excerpt and pause), corrected-input explicit resume; cleanup/genuine unsupported negative controls. Run zero-trust build, focused suites, full package coverage and repository CI-parity gates.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only).

## Base Branch
`main`
