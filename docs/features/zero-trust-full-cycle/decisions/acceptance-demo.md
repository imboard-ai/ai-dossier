# Decision record: live acceptance demo (#1115)

- **Date:** 2026-10-13.
- **Status:** **PASS, with open quality defects.** (The first post-fix re-run did not pass; see [Post-fix re-run](#post-fix-re-run-2026-10-14). The second passed and closed #1002, with the candidate-quality gap left open as #1252; see [Post-fix re-run 2](#post-fix-re-run-2-2026-10-16).) The owner's live run took the seeded issue through
  `awaiting_contributor`, then `submitted` with exactly one PR, then a maintainer review, then a
  revision on the same PR through a compare-and-swap push. `zt-acceptance-check` passed live both
  before and after the revision. Contributions mechanics work end to end. Candidate *quality* does
  not yet hold: two of the three live candidates deleted an existing upstream test, and review and
  verification let it through (#1205, since fixed; see Defects). That blocked a public launch, not this gate.
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

## Post-fix re-run (2026-10-14)

- **Status: FAIL. #1002 stays open.** The fixes under test held live, but S5 (a verified revision
  of the same PR) was not demonstrated, and a gpt-5-family model did not get past the gate. The
  four new defects are #1219, #1220 and #1223, plus #1217 together with its contributing cause #1218.
- **What it tested:** #1205 (review inventories test titles and reruns the original tests on the
  patched source), #1186 (gpt-5-family request profiles and release of holds on rejected calls),
  and #1191 (durable stop notices). None of these had run live before.
- **Setup:** controller built from `main` at `70c5f2a`. Same upstream/fork pair, App, baked profile and
  runbook as above. The package proxy was restarted for a fresh inspection CA. Issues #6 and #8 are
  fresh copies of the fixture bug. `gpt-4.1-mini` was the baseline (run a, run c), and `gpt-5-mini` was
  used for planning, implementation and decisions (run b). Every upstream PR was created by
  `ydhidden`, and the maintainer posted the reviews.

### Review now catches deleted tests (#1205: PASS)

All three gpt-4.1-mini candidates fixed the divisor (`/ 100` → `/ 1000`) but rewrote
`test/duration.test.js` and dropped the existing test `rejects text that is not a duration`. One
plan even said "Keep existing tests intact". Review refused each one before anything was pushed:

| Run | Paused | Stop notice |
|---|---|---|
| `ztc-18a12fe4c3e88ab2` | 10:54:20 | `paused_user`, review refused the candidate (`test_removed`) |
| `ztc-57183f34c0f3951f` | 11:31:24 | same |
| `ztc-4cc2feace7c94368` | 12:11:47 | same |

The two later runs continued through the documented `edit --patch` path. A 4-line contributor
edit restored the original test next to the model's new one, and the edited candidate passed a
fresh review and verification. The PR body then lists "Includes contributor edits". The first run
was cancelled instead.

### S4: PASS (twice)

| Run | Stop A `awaiting_contributor` | Stop B `submitted` | PR | Verified candidate |
|---|---|---|---|---|
| `ztc-57183f34c0f3951f` | 11:38:13 | 11:43:36 | https://github.com/imboard-ai/ztfc-upstream-fixture/pull/7 | `8819b9572dced4f54ad1a371cf0883d166d00554` |
| `ztc-4cc2feace7c94368` | 12:19:23 | 12:21:34 | https://github.com/imboard-ai/ztfc-upstream-fixture/pull/9 | `4c6404a99a8119e55aabae454310a34fe3f024b5` |

The base is `fda6f7fa90963590c25f87a52366d3207ef94d80` in both runs. In each, the fork branch matched
`candidateSha` at stop A, no comment was posted on the issue, and exactly one PR existed for the head.
`zt-acceptance-check` passed at stop B for both runs:

```text
zt-acceptance-check ztc-4cc2feace7c94368-run-1
CHECK        RESULT  DETAIL
receipts     PASS    1 receipt(s), 1 verified candidate(s)
identity     PASS    imboard-ai/ztfc-upstream-fixture and ydhidden/ztfc-upstream-fixture match the signed IDs
fork-branch  PASS    ztfc/ztc-4cc2feace7c94368 = 4c6404a99a8119e55aabae454310a34fe3f024b5
single-pr    PASS    https://github.com/imboard-ai/ztfc-upstream-fixture/pull/9 (open)
pr-body      PASS    2 command(s) for 4c6404a99a81
pr-head      PASS    4c6404a99a8119e55aabae454310a34fe3f024b5
ALL CHECKS PASSED
```

Run `ztc-57183f34c0f3951f` had the same six PASS rows for PR #7 and `8819b9572dce`.

### S5: FAIL, not demonstrated

The maintainer posted the same in-scope review on both PRs: replace the bare `1000` with
`const MS_PER_SECOND = 1000` and keep both existing tests. The org membership is private, so both
revisions ran with `--reviewers` (#1198).

- **PR #7 (`ztc-57183f34c0f3951f`).** The screen admitted the review, and `revising` started at 11:46:43.
  The revision repeated the #1115 failure: it replaced `ms` with a hand-written parser, changed
  `TypeError` to `Error`, and dropped the original test again, including the one restored by the
  contributor edit. Before review could rule on it, the contributor stopped the `resume` process in
  the terminal: it had printed nothing for several minutes and looked hung (#1218). The controller exited without revoking the
  user token it held and without destroying its verification VM. The next `resume` destroyed the
  VM, could not settle the token, and moved the run to `blocked_cleanup` (11:51:30) (#1217). That
  path ends in terminal `blocked`, so the revision cannot finish.
- **PR #9 (`ztc-4cc2feace7c94368`).** The feedback screen's two passes disagreed: `hand_off`,
  confidence 0.5, reason `disagreement`. That plan said "No refactoring or unrelated changes",
  whereas the PR #7 plan, which admitted the same review at confidence 1.0, did not. The run went
  `revising → paused_user` in 12 s with nothing implemented. The verdict is cached for the session, and
  `resume --revise` is refused from `paused_user`, so the run could not revise its own PR (#1223).
  This is the plan-scope question #1115 deferred, and here it decided the outcome.

S5 in the #1115 record passed before #1205. That revision deleted the same test, which this
re-run shows review now refuses. A revision that keeps the tests has not yet been shown live.

### gpt-5-mini (#1186, #1191): FAIL at the gate

Run `ztc-ac49377b173a99f1` (issue #8): `gating` at 11:55:35, then a hand-off with `ownership_unclear`
at 11:56:37. Exit 0, with a durable stop notice in `status`.

- **The calls work.** All nine decision calls succeeded and settled from `model_usage`. No hold was
  left reserved or unsettled, and the estimate was $0.09. The request-profile and accounting fixes hold.
- **The decisions do not.** Reproduced offline on the same `CONTRIBUTING.md`: gpt-5-mini returns
  `invalid_pass` for 4 of 6 policy questions, while gpt-4.1-mini gets all 6 accepted. Every failing
  pass used exactly 1,024 output tokens. That is the typed-decision cap, and `max_completion_tokens`
  counts reasoning tokens against it, so the visible tool call is cut off (#1219).
- **The notice explains nothing.** `status` shows no per-question results or citations, and it says
  "no model work started" even though the nine calls were charged (#1220).

### Cost

| Contribution | Session 1 | Session 2 (revision) |
|---|---|---|
| `ztc-18a12fe4c3e88ab2` | $0.49 | n/a |
| `ztc-57183f34c0f3951f` | $0.55 | $0.24 |
| `ztc-ac49377b173a99f1` | $0.09 | n/a |
| `ztc-4cc2feace7c94368` | $0.54 | $0.02 |

That is $1.93 estimated and $0.70 observed. All 150 reservations settled.

### Operator friction (not filed)

- Each `zt-run` process asks for a fresh App authorization (#1213). This contribution flow needed
  seven authorization clicks. Two links expired unclicked after about 10 minutes, which leaves
  `start` at `authorization_expired`.
- Revision reviewers from a private org need `--reviewers` on every `resume --revise`.

### Defects filed

| Issue | Summary |
|---|---|
| #1217 | Interrupting `zt-run` during an active phase strands the run in `blocked_cleanup` |
| #1218 | `start`/`resume` print no progress during multi-minute phases |
| #1219 | gpt-5 typed decisions exhaust the 1,024-token cap on reasoning and escalate as unclear |
| #1220 | A policy hand-off at the gate keeps no decision evidence and says no model work ran |
| #1223 | One split vote on revision feedback ends the revision for good |

### Cleanup

Runs `ztc-18a12fe4c3e88ab2`, `ztc-ac49377b173a99f1` and `ztc-4cc2feace7c94368` are `cancelled`.
`ztc-57183f34c0f3951f` stays in `blocked_cleanup` until the contributor revokes the App
authorization and its token is resolved with `resolve --confirm-dead`. VM reconcile reports nothing live in any store,
and the proxy is down. PRs #7 and #9 remain open, and the maintainer will close them.

## Post-fix re-run 2 (2026-10-16)

- **Status: PASS. #1002 closes.** S4 passed. S5's delivery path passed end to end: the maintainer
  review was admitted, and a verified revision was pushed to the same PR by compare-and-swap.
  `zt-acceptance-check --after-revision` passed. No run ended blocked, every reservation settled,
  and gpt-5-mini passed the gate. One quality gap remains, filed as a follow-up and not as a
  blocker: the model's own revision dropped both existing tests again, review refused it, and the
  revision that shipped is a contributor edit (#1252).
- **What it tested:** #1217 (interrupt cleanup), #1218 (live progress output), #1219 (reasoning
  headroom for typed decisions), #1220 (gate hand-off evidence) and #1223 (re-judging new revision
  feedback). The fixes for #1217 and #1220 were not exercised: no `resume` was interrupted, and the
  gate did not hand off.
- **Setup:** controller built from `main` at `47018d2`. The VM profile was freshly baked (522 s
  under KVM; smoke boot-to-broker 38.7 s). The package proxy was restarted for a fresh inspection
  CA, and all 13 policy checks returned their expected outcome. The upstream was still at the seeded
  base `fda6f7fa90963590c25f87a52366d3207ef94d80`, byte-identical to the fixture, so it was not
  re-seeded. Issues #10 (main run) and #12 (gpt-5-mini) are fresh copies of the fixture bug.
  `gpt-4.1-mini` ran the main contribution. `ydhidden` created the PR, and the maintainer posted
  the review.

### Timeline: `ztc-2047cf076b5ee46f` (gpt-4.1-mini, issue #10)

| Time (UTC) | State / reason | Note |
|---|---|---|
| 07:54:10 | `gating` / `run_created` | authorized as `ydhidden`; author identity confirmed |
| 07:54:32 | `planning` / `gate_passed` | gate 22 s |
| 07:56:18 | `implementing` / `plan_approved` | planning 1 min 46 s; the plan said to add the new case "in the existing test file" |
| 07:57:02 | `verifying` / `candidate_ready` | implementation 44 s |
| 07:59:12 | `paused_user` / `user_paused` | review refused `46b2a3be7cc1` (`test_removed`) |
| 08:18:51 | `verifying` / `resume_verifying` | after a 4-line `edit --patch` restoring the original test (`f51cb15e4c56`) |
| 08:23:51 | `shipping` / `verification_passed` | review + verification 5 min |
| 08:24:31 | **Stop A** `awaiting_contributor` / `contributor_handoff` | fork branch = `candidateSha`, no comment on the issue |
| 08:31:41 | **Stop B** `submitted` / `publication_observed` | https://github.com/imboard-ai/ztfc-upstream-fixture/pull/11 by `ydhidden` |
| 08:32:03 | `awaiting_review` / `review_awaited` | tracker started |
| 08:32:26 | — | maintainer review, Request changes (below) |
| 08:34:11 | `revising` / `revision_requested` | `resume --revise --reviewers <maintainer>`; feedback admitted |
| 08:36:12 | `verifying` / `candidate_ready` | revision implemented in 2 min |
| 08:38:37 | `paused_user` / `user_paused` | review refused `997fda46a1fe` (`existing_tests_failed`, `test_removed`) |
| 08:54:13 | `verifying` / `resume_verifying` | after a contributor edit (`eff9248eecca`) |
| 08:59:14 | `shipping` / `verification_passed` | |
| 08:59:48 | **Stop C** `submitted` / `publication_observed` | same PR #11; head `f51cb15e4c56` → `eff9248eecca` by compare-and-swap |

Every `resume` ran to its own durable stop. None was interrupted.

### S4: PASS

The first candidate fixed the divisor but replaced `test/duration.test.js` and dropped
`rejects text that is not a duration`. All three gpt-4.1-mini candidates on 10-14 did the same.
Review refused it before anything was pushed. The same 4-line contributor edit as on 10-14 restored
the test next to the model's new one. The edited candidate passed a fresh review and verification,
and the PR body lists "Includes contributor edits".

```text
zt-acceptance-check ztc-2047cf076b5ee46f-run-1
CHECK        RESULT  DETAIL
receipts     PASS    1 receipt(s), 1 verified candidate(s)
identity     PASS    imboard-ai/ztfc-upstream-fixture and ydhidden/ztfc-upstream-fixture match the signed IDs
fork-branch  PASS    ztfc/ztc-2047cf076b5ee46f = f51cb15e4c5646bf797e5021a8039676c6effeeb
single-pr    PASS    https://github.com/imboard-ai/ztfc-upstream-fixture/pull/11 (open)
pr-body      PASS    2 command(s) for f51cb15e4c56
pr-head      PASS    f51cb15e4c5646bf797e5021a8039676c6effeeb
ALL CHECKS PASSED
```

### S5: delivery PASS; the model's revision did not keep the tests

The maintainer posted the same in-scope review as on 10-14:

> Thanks, the fix is right. One change before merge: please replace the bare `1000` divisor in
> `toSeconds()` with a named constant, `const MS_PER_SECOND = 1000;` declared at the top of
> `src/duration.js`, and divide by `MS_PER_SECOND`. [...] Keep both existing tests as they are.

- **Admission: PASS.** The feedback screen admitted the review on the first judgement, and the
  revision opened session 2 in a fresh VM. The 10-14 PR #9 split vote did not recur.
- **The model's revision: FAIL.** It repeated the #1115 failure. It replaced `ms` with a
  hand-written `switch` parser, changed `TypeError` to `Error`, and rewrote the test file. That dropped both the
  original test and the contributor-restored one. Review refused it (`existing_tests_failed`,
  `test_removed`), and nothing was pushed. That is 3 of 3 gpt-4.1-mini revisions dropping a test
  on this fixture, and 7 of 7 candidates overall (#1252).
- **Delivery: PASS.** A contributor edit made exactly the requested change on top of the submitted
  head (`MS_PER_SECOND` declared and used, both tests unchanged). It passed a fresh review and
  verification. The run then pushed it to the same branch from the last verified head and returned to
  `submitted`. Exactly one PR exists for the head, and its head is the new candidate.

The edit needed two refused attempts first (`invalid_patch`). `artifacts/candidate.diff` shows
a phantom empty line at the end of each file, so a patch built from it does not apply, and the
error does not say which file or hunk failed (#1254).

```text
zt-acceptance-check ztc-2047cf076b5ee46f-run-1 (after revision)
CHECK        RESULT  DETAIL
receipts     PASS    2 receipt(s), 2 verified candidate(s)
identity     PASS    imboard-ai/ztfc-upstream-fixture and ydhidden/ztfc-upstream-fixture match the signed IDs
fork-branch  PASS    ztfc/ztc-2047cf076b5ee46f = eff9248eeccac2724835ea8c19c49cc4ef2f3868
single-pr    PASS    https://github.com/imboard-ai/ztfc-upstream-fixture/pull/11 (open)
pr-body      PASS    2 command(s) for f51cb15e4c56; head is eff9248eecca (body not updated after the revision)
pr-head      PASS    f51cb15e4c56 -> eff9248eeccac2724835ea8c19c49cc4ef2f3868
ALL CHECKS PASSED
```

**Why this closes the epic.** The owner decided to count the contributor-edited revision. Every
workflow guarantee S5 names held live: admission, a fresh session and VM, review, independent
verification, a compare-and-swap push to the same PR, and one PR. The safety net also held: review
refused all three bad candidates of this run before anything reached GitHub. What did not hold is
candidate quality. That is a model and prompt problem, and it is tracked in #1252 rather than
holding this epic open.

### gpt-5-mini gate (#1219, #1220): PASS

Run `ztc-a5a3ecaab7a89d3c` (issue #12, `checkpoints: ["plan"]`): `gating` at 09:44:36,
`planning` / `gate_passed` at 09:46:32, then the plan checkpoint at 09:49:55. The run was then cancelled.

- **#1219: PASS.** All 12 typed policy decisions (6 questions × 2 passes) were `accepted`, with no
  `invalid_pass`, and the gate outcome was `proceed`. On 10-14, 4 of 6 questions failed at the
  1,024-token cap.
- **Accounting: PASS.** All 17 reservations settled from `model_usage`, and none was left reserved.
- **#1220: not exercised.** The gate passed, so no hand-off notice was produced. The stop-notice
  evidence is covered by its tests only.
- The plan proposed adding a new test file at `test/duration.test.js`, the path of the existing
  file. This is the same pattern #1252 describes.

### Cost

| Contribution | Session 1 | Session 2 (revision) | Observed |
|---|---|---|---|
| `ztc-2047cf076b5ee46f` (gpt-4.1-mini) | $0.55 | $0.24 | $0.26 |
| `ztc-a5a3ecaab7a89d3c` (gpt-5-mini, gate + plan) | $0.46 | n/a | $0.13 |

Totals: $1.25 estimated and $0.39 observed. All 89 reservations settled (main run 72, gpt-5-mini 17).
Active time for the main run was 10 min 42 s in session 1 and 10 min 1 s in session 2. Most of the
wall-clock was operator waiting: seven App authorization clicks (#1213) plus four links that expired
unclicked.

### Defects filed

| Issue | Summary |
|---|---|
| #1252 | Model candidates and revisions rewrite test files and drop existing upstream tests |
| #1253 | `resume` reports an expired authorization link as `recovery_failed` (`start` says `authorization_expired`) |
| #1254 | `candidate.diff` adds phantom trailing lines, so edit patches built from it fail with a bare `invalid_patch` |

### Cleanup

Both runs are `cancelled`. VM reconcile reports nothing live in either run store or the smoke
store, and the proxy is down. PR #11 stays open for the maintainer to close. The contributor revoked the App
authorization in `ydhidden`'s settings.
