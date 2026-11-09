# #1268 part 2: operator answer to a policy gate hand-off

## Problem

A gate hand-off with `ai_unclear` or `ownership_unclear` has no human resolution path:
`resume` re-runs the same assessment and reaches the same hand-off. Two live cases: an
AI-silent project with fork-and-PR prose (`ownership_unclear`), and a project that invites
coding agents but whose `CONTRIBUTING.md` line "Claude's connector can sign in on its own,
with no key to paste" matches `ai-ban-1` (AI mention + negation), so the floor escalates
and the model may not clear it (`ai_unclear`).

## Design

- `zt-run resume --policy <dimension=value,...> --policy-note <why>`: closed grammar in
  `policy/operator.ts` (`ai`, `assignment`, `directPr`; no `banned`, no `unclear`).
- `changePolicy` (controller/edits): requires `paused_user` from `gating` and a retained
  `gate_assessment` hand-off whose reasons are only `ai_unclear`/`ownership_unclear`. Journals a
  `policy` user change: decisions, note, operator login, the assessment's shared `inputDigest`.
- Gate step: the latest decision replaces only `unclear` dimensions (`applyOperatorPolicy`),
  never a banned assessment. A different input digest hands off with `operator_policy_stale`.
  The answered assessment is the admitted `gate.policy`, so freshness checks keep it.
- Evidence: `gate_assessment.operatorPolicy` (+ `applied`, `stale`), shown in status as
  `policyGate.operatorPolicy`. The hand-off notice names the `--policy` path only for
  answerable reasons.

## Acceptance criteria

- ac1: an ownership hand-off answered with `--policy directPr=welcomed` proceeds past the gate.
- ac2: decisions only replace `unclear`; bans and settled readings are untouched.
- ac3: refused outside a policy hand-off (`policy_not_at_gate`), and for malformed input or a
  missing note (`invalid_policy_decision`), before anything is journaled.
- ac4: a changed policy retires the decision (`operator_policy_stale`).
- ac5: guide and README document the flow.

## Open questions

None. Pause then resume to reach `paused_user` matches the existing `--model-profile` path.
