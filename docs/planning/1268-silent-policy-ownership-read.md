# #1268 (part 1): AI-silent policies still decide ownership

## Problem
`assessPolicy` returned the deterministic floor early when a project's policy files never mention AI (`ai: 'silent'`). The floor cannot produce `directPr: 'welcomed'`, so every AI-silent project ended in the `ownership_unclear` gate hand-off whatever model was configured. Live run on plotly/plotly.py#5136: $0 spend under gpt-5-mini and gpt-5. 7 of 10 popular candidate repos are AI-silent.

## Change
- `packages/zero-trust/src/policy/decide-policy.ts`: drop the early return. For an AI-silent policy, decide only `assignment` and `directPr`. `ai` stays `silent`, so silence is never paid permission inference. Draft, receipt and baseline keep their floors. Floors, contradictions, ambiguity escalation, verbatim citations and all-or-nothing budget refusal apply unchanged to the decided dimensions.

## Acceptance criteria
- ac1: An AI-silent policy asks the provider only `policy-assignment` and `policy-direct-pr`. `ai` stays `silent`, and `decisions` holds only those two keys.
- ac2: AI-silent prose that says "fork, then open a pull request into main" can resolve to `directPr: 'welcomed'` with a validated citation.
- ac3: A discussion-first restriction still binds an AI-silent policy against a permissive model.
- ac4: On an exhausted budget, an AI-silent policy returns the floor with `reason: 'budget'` and makes no completion calls.
- ac5: The README and the user guide describe the new behaviour.

## Out of scope
Part 2 of #1268 (`resume --ownership engage|direct-pr`) stays open on the issue.

## Open questions
None.
