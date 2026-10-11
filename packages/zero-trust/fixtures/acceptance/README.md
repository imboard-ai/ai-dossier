# Live acceptance fixtures

Inputs for the owner-run acceptance demonstration of the zero-trust engine
([#1115](https://github.com/imboard-ai/ai-dossier/issues/1115)). The procedure is the
[acceptance runbook](../../../../docs/features/zero-trust-full-cycle/acceptance-runbook.md).
Nothing here runs in CI except the policy assertions in `scripts/zt-acceptance-check.test.mjs`.

| Path | Meaning |
|---|---|
| `npm/upstream/CONTRIBUTING.md` | Contribution policy for the controlled upstream. It welcomes direct pull requests on any open issue, makes assignment optional and welcomes AI-assisted contributions that disclose the assistance. |
| `npm/upstream/README.md` | README for the controlled upstream. It has no "Contributing" heading, so the policy reader ignores it. |
| `npm/issue-title.txt`, `npm/issue-body.md` | The seeded bug report, written as an ordinary user report with a failing test and no hint of the fix. |

The upstream's code is `../ecosystem/npm/base/` (the `toSeconds()` bug, the `ms` dependency and
`package-lock.json`), with the `// Known bug` comment line removed from `src/duration.js` so the
source does not announce the bug.

## Policy wording

`CONTRIBUTING.md` is phrased for the deterministic policy floor in `src/policy/`, which can only
make an answer stricter:

- The floor reads every unit (sentence) that mentions a policy topic. A unit that also contains a
  negation (`not`, `no`, `never`, …) or a requirement word (`must`, `required`, `needs`, `before`,
  `first`, …) counts as a restriction for that topic. `No assignment is needed` therefore reads
  as "assignment required".
- Any mention of `draft` makes the floor require a draft PR, and any mention of `template`,
  `receipt block` or `extra sections` forbids the receipt block.
- The only restriction in this file is the deliberate AI-disclosure requirement
  (`Contributors must disclose AI assistance…`). The floor reports no contradictions.

The gate still needs the run's typed decisions (model passes with literal citations) to answer
`disclosure_required`, `not_required` and `welcomed`. The test proves the gate proceeds, with no
engagement comment, when they do.
