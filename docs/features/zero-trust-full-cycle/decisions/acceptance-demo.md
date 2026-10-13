# Decision record: live acceptance demo (#1115)

- **Date:** 2026-10-13.
- **Status:** **PASS, with open quality defects.** The owner's live run took the seeded issue through
  `awaiting_contributor`, then `submitted` with exactly one PR, then a maintainer review, then a
  revision on the same PR through a compare-and-swap push. `zt-acceptance-check` passed live both
  before and after the revision. Contributions mechanics work end to end. Candidate *quality* does
  not yet hold: two of the three live candidates deleted an existing upstream test, and review and
  verification let it through (#1205). That blocks a public launch, not this gate.
- **Spec:** [acceptance runbook](../acceptance-runbook.md); [PRD](../prd.md) §7 scenarios S4 and S5;
  epic #1002.
- **Builds on:** [github-credentials](github-credentials.md) (gate 3) and
  [release-gate-4](release-gate-4.md) (gate 4).

## Setup

- Upstream `imboard-ai/ztfc-upstream-fixture`, issue #2 (seeded bug: `toSeconds()` divides by 100
  instead of 1000). Contributor `ydhidden`; its fork is `ydhidden/ztfc-upstream-fixture`.
- Controller built from `main` at `a1a5061` (after #1204). Local QEMU/KVM, package proxy stack,
  `gpt-4.1-mini` for planning, implementation and decisions.
- Every upstream write came from a person: `ydhidden` clicked **Create pull request** on the prefilled
  compare link, and the maintainer posted the review. The tool pushed only to the contributor's fork
  branch, with a short-lived installation token that the broker revoked and verified after each push.

## The accepted run: `ztc-11f6f1ac7a983e18`

| Stop | State / reason code | Time (UTC) |
|---|---|---|
| start | `gating` | 12:39:19 |
| | `planning` / `gate_passed` | 12:41:07 |
| | `implementing` / `plan_approved` | 12:42:38 |
| | `verifying` / `candidate_ready` | 12:43:21 |
| | `shipping` / `verification_passed` | 12:46:08 |
| **A** | `awaiting_contributor` / `contributor_handoff` | 12:46:52 |
| **B** | `submitted` / `publication_observed` | 12:48:51 |
| | `awaiting_review` / `review_awaited` | 12:49:10 |
| | `revising` / `revision_requested` | 12:53:57 |
| | `verifying` / `candidate_ready` | 12:55:22 |
| | `shipping` / `verification_passed` | 12:58:20 |
| **C** | `submitted` / `publication_observed` | 12:59:18 |

From start to the hand-off took 7.5 minutes, and the revision took 5.3 minutes from review admission to confirmed head.
Active compute time was 295 s.

- **PR:** https://github.com/imboard-ai/ztfc-upstream-fixture/pull/5
- **Base:** `fda6f7fa90963590c25f87a52366d3207ef94d80`
- **First verified candidate:** `566db4d26cb417123edb0dfed0f2c7e22bb7320f`. This is the one-line divisor fix
  plus a new test file. The regression test fails on base and passes on the candidate.
- **Revised verified candidate:** `a4f25afcca008f01e6d5355758e626441b4b47a4`, on the same PR.
- **Maintainer review:** move the regression test into `test/duration.test.js` and restore the
  doc comment. The maintainer's org membership is private, so GitHub reports them as
  `CONTRIBUTOR`. They were admitted with `resume --revise --reviewers <login>` (#1198). The
  feedback screen accepted the review at confidence 1.0.

### Cost

| Session | Estimated spend |
|---|---|
| 1 (gate → hand-off) | $0.48 |
| 2 (revision) | $0.36 |

The run's total was $0.84 of its $2.50 per-session ceiling. `metrics` across all eleven demo
contributions reports a cost per submitted contribution of $0.62 estimated and $0.23 observed. Model
spend for the whole demo, including the failed attempts below, stayed under $5.

### Check script

Before the revision (stop B):

```text
CHECK        RESULT  DETAIL
receipts     PASS    1 receipt(s), 1 verified candidate(s)
identity     PASS    imboard-ai/ztfc-upstream-fixture and ydhidden/ztfc-upstream-fixture match the signed IDs
fork-branch  PASS    ztfc/ztc-11f6f1ac7a983e18 = 566db4d26cb417123edb0dfed0f2c7e22bb7320f
single-pr    PASS    https://github.com/imboard-ai/ztfc-upstream-fixture/pull/5 (open)
pr-body      PASS    2 command(s) for 566db4d26cb4
pr-head      PASS    566db4d26cb417123edb0dfed0f2c7e22bb7320f
ALL CHECKS PASSED
```

After the revision (stop C, `--after-revision`):

```text
CHECK        RESULT  DETAIL
receipts     PASS    2 receipt(s), 2 verified candidate(s)
identity     PASS    imboard-ai/ztfc-upstream-fixture and ydhidden/ztfc-upstream-fixture match the signed IDs
fork-branch  PASS    ztfc/ztc-11f6f1ac7a983e18 = a4f25afcca008f01e6d5355758e626441b4b47a4
single-pr    PASS    https://github.com/imboard-ai/ztfc-upstream-fixture/pull/5 (open)
pr-body      PASS    2 command(s) for 566db4d26cb4; head is a4f25afcca00 (body not updated after the revision)
pr-head      PASS    566db4d26cb4 -> a4f25afcca008f01e6d5355758e626441b4b47a4
ALL CHECKS PASSED
```

## What the revision got wrong

The maintainer asked for a test move and a doc comment. The revision did both. It also:

- replaced the `ms` implementation with a hand-written `s`/`m` parser, which drops hours;
- changed the thrown error from `TypeError` to `Error`;
- deleted the existing test `rejects text that is not a duration`.

Verification passed because the test that would have failed was gone. The check script checks
mechanics, not content, so it passed too. A maintainer should not merge this PR. The same failure
happened in the first candidate of the previous attempt (PR #4, closed). Both are tracked in #1205.

## Attempts before the accepted run

| Run | Ended | Cause | Outcome |
|---|---|---|---|
| `ztc-90b4f6f2e6148c49` | `blocked_cleanup` in ship | GitHub's new stateless installation-token format failed the token check | #1200, fixed by #1201. The leftover blocked run is #1202. |
| `ztc-347d5669d788766f` | refused after `awaiting_contributor` (PR #3) | hand-off transition stamped twice by two clocks | #1203, fixed by #1204. PR #3 closed by the maintainer. |
| `ztc-f7cc6d8442c8d214` | `unsupported` in acquire | host rebooted mid-demo and stopped the proxy containers | operator environment; the stack was brought back up |
| `ztc-f95681f9e3aaa1f0` | `paused_user` on revise (PR #4) | the feedback screen rejected a "cover hours too" request as outside the approved plan; the rejection is final for the session, so an edited review is not re-judged | by design; see below. PR #4 closed for #1205. |

The rejected feedback was the runbook's own example review. The screen's question requires a change
to be confined to the original issue *and* the approved plan. A narrow plan therefore excludes
reasonable maintainer requests the issue covers ("wrong for every valid duration"). The runbook's
example should name a change the plan already covers. Whether the question should drop the plan
from its scope is a product decision for #1002.

## Defects

Defects filed as sub-issues of #1002 during the demo:

| Issue | Summary | State |
|---|---|---|
| #1178 / #1180 | Policy template listing redirect made every gate hand off | fixed |
| #1179 / #1183 | Silent gate hand-off in `gating` | fixed |
| #1181 | Export bundles are empty for live runs | open |
| #1182 | The tool cannot revoke the contributor's App grant after cancel | open |
| #1184 | Time parked in `gating` counted as active | fixed |
| #1185 / #1187 | Anonymous reads hit the 60/hour limit | fixed |
| #1186 | OpenAI reasoning models fail every call and leave holds reserved | open (holds fixed by #1197) |
| #1189 | Policy decisions miscounted source line numbers | fixed |
| #1191 | Active-time and budget refusals exit silently | open |
| #1193 | `start` asks the contributor to authorize twice | open |
| #1194 | An expired proxy CA ends a run as terminal `unsupported_environment` | open |
| #1195 | OpenAI rejected the agent tool schema | fixed |
| #1198 | Reviews from private org members are ignored | fixed (`--reviewers`) |
| #1200 | New installation-token format blocks shipping | fixed |
| #1202 | An uncertain token mint leaves the run in `blocked_cleanup` | open |
| #1203 | Hand-off transition stamped twice | fixed |
| #1205 | A candidate can delete an existing test and still pass | fixed (review inventories test titles and runs the original tests on the patched source) |

Not filed as a product defect: the check script fails `pr-body` until the PR tracker has started,
which happens on the `resume` after `submitted`. The runbook's stop B should say to run that second
`resume` before the check.
