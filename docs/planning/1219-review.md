# #1219 review evidence

Run `r-1219-3dfd`, executor and reviewers `openai/gpt-6.1-sol`.

Full-tier report-only review: DRY, security, supportability, maintainability,
documentation, convention and blind conformance. Seven independent OpenCode CLI
workers ran in parallel because this harness exposes no Task tool. Whole round
340.5 seconds, above the five-minute floor. No visual surface (`live=n/a`).

## Findings and serial repair
1. All seven reviewers reproduced the same test defect: omitted likelihood options
   on the custom alias `fixture` resolve to true, but the new default-cap case
   expected omission. Valid, Fix now. Deduplicated to one fix; expectations now
   consume the resolved profile instead of independently inferring defaults.
2. Blind conformance requested stronger AC2 evidence for persisted configuration
   through production adapter construction. Added a real RunStore create/reopen
   and production createController case with no injected model adapters. Distinct
   planning/implementation/repair caps reach recorded HTTP bodies; intentionally
   failed verification exercises the repair path and existing bounded failure.

No production security/accounting defects or product escalations found. Security,
supportability and conformance also independently probed exact durable reservation,
actual retry attempts, larger-cap truncation, zero fetch on budget refusal, known
inclusive settlement, conservative unknown holds and cache separation.

## Reproduction and verification
- Isolated base `e0fd373`, HEAD regression `headroom admits`: fails at decoded decision
  (null), not import/tooling setup. Same regression passes after the fix.
- First full package coverage attempt: 4,983 passed, one new likelihood-expectation
  case failed, 14 skipped. The initial implementation milestone's test-file count
  was inaccurate (103 versus 118 collected); corrected evidence is recorded here.
- Repaired composed-profile suite: all five cases pass, including persisted caps
  and distinct repair selection. Build and root warning-sensitive lint pass.
- Final package coverage and fresh blind conformance are required before shipping.

No paid live-provider replay was performed. Offline response-shape and accounting
regressions establish completion headroom plumbing, not provider success guarantees.
