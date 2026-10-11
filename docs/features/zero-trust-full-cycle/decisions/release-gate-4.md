# Decision record: lifecycle and upstream failures (release gate 4)

- **Date:** 2026-10-11.
- **Status:** **GO**. Every gate-4 item has a passing scenario through the real controller,
  the shared global-invariant audit holds after every scenario, and no scenario is
  `it.fails`. Part 1 (lifecycle) is #1113 (PR #1171); part 2 (upstream) and this record are
  #1114.
- **Spec:** [PRD](../prd.md) §9 pre-release gate 4, §5.8, §5.9 (write reconciliation,
  permission freshness, budget lifecycle), §6 release invariants, §7 scenarios 9–11, 16, 18,
  19 and 20; epic #1002 gate checkbox.
- **Suites:**
  [`gate4-lifecycle.test.ts`](../../../../packages/zero-trust/src/__tests__/gate4-lifecycle.test.ts)
  (part 1, 15 scenarios),
  [`gate4-upstream.test.ts`](../../../../packages/zero-trust/src/__tests__/gate4-upstream.test.ts)
  (part 2, 29 scenarios), and the shared audit
  [`gate4-audit.ts`](../../../../packages/zero-trust/src/__tests__/gate4-audit.ts).
- **Builds on:** [execution-profile](execution-profile.md) (gate 1),
  [package-proxy](package-proxy.md) (gate 2), [github-credentials](github-credentials.md)
  (gate 3, the hybrid hand-off).

## Method

Every scenario drives `createController` from `src/controller/wiring.ts` with real journals,
stores, receipts, nonces, intent and hand-off drivers, the PR tracker, the budget ledger and
local bare Git repositories for the upstream and the fork. Only the physical edges are
scripted: the GitHub transport (`github-fake.ts` plus credential-free reads), the model
adapter, the VM adapter and the clock. Nothing in the controller is mocked; a lost answer is
produced at the edge (for example, the real `git push` lands in the bare fork and only its
answer is dropped). The suites run in normal CI with no network and no VM.

Each test title names the actor, the expected outcome and the owning release slices (PRD
§7). After every scenario, including refusal paths, `gate4Suite()` runs one audit:

- every physical fork push matches exactly one journaled push attempt whose nonce row names
  a receipt-v2 granting that operation and candidate SHA;
- the fork has no ref but the run's branch, and whatever that branch holds is either a
  `push_verified` write with a receipt-v2 and a supervisor-observed pass, or a commit the
  scenario declared out of band, which must still be there;
- every `passed` verification record has a held boundary and commands that match an
  observed supervised execution (argv, `network: none`, exit status, suite count, candidate
  files);
- no publication or tracking record claims CI `passed`;
- every destroyed guest has a destroy call, and any remaining guest is reported as
  `blocked_cleanup`;
- no access, refresh or installation credential is left live;
- no non-GET request ever reached an upstream pull-request or issue endpoint.

Negative controls show the audit rejects a forbidden upstream mutation, an unreceipted
push, a duplicated push observation, a vanished supervised command (part 1) and an
undeclared out-of-band remote (part 2). Every verification record must load, except
those a scenario corrupts on purpose and declares.

## Gate items

Results: both suites passed locally (15/15 and 29/29) and in
[CI](https://github.com/imboard-ai/ai-dossier/actions/runs/38119269518) on Node 20 and 22
(PR #1175 at `3d84e09`; this record's own wording changed after that run). In CI the
isolated lifecycle timing step took 20 s (Node 20) and 18 s (Node 22) against its 60 s
limit, and the upstream suite ran in the coverage job in 89 s and 76 s. "L" is
`gate4-lifecycle.test.ts`, "U" is `gate4-upstream.test.ts`.

| Gate item (PRD §9 / epic checkbox) | Scenario (test title) | File | Result |
|---|---|---|---|
| Pause/cancel: cancellation at gating | `actor=contributor outcome=cancelled phase='gating' owner='S2/S5'` | L | pass |
| Pause/cancel: cancellation while implementing | `actor=contributor outcome=cancelled phase='implementing' owner='S3/S5'` | L | pass |
| Pause/cancel: cancellation while verifying | `actor=contributor outcome=cancelled phase=verifying owner=S3/S5` | L | pass |
| Pause/cancel: cancellation while shipping, before the push | `actor=contributor outcome=cancelled phase='shipping before push' owner='S4/S5'` | L | pass |
| Pause/cancel: cancellation with a pending hand-off, submitted PR reported | `actor=contributor outcome=cancelled with submitted PR reported phase=pending handoff owner=S4/S5` | L | pass |
| Pause/cancel: pause and checkpoint resume (scenario 9) | `actor=contributor outcome=pause/checkpoint resume retains candidate and ledger owner=S3/S5` | L | pass |
| Cleanup failure (scenario 20) | `actor=VM provider outcome=blocked_cleanup denies execution/publication; CleanupCompleted only blocked owner=S1/S5` | L | pass |
| Budget exhaustion (scenario 9) | `actor=contributor/model usage outcome=reservation refuses next call; approved money ceiling resumes same session/history owner=S1/S3/S5` | L | pass |
| Budget exhaustion during verification | `actor=execution clock outcome=verification exhaustion never passes owner=S1/S3` | L | pass |
| Budget lifecycle: crash with open holds (scenario 19) | `actor=controller process SIGKILL outcome=real unknown hold survives reopen, fresh work fenced, guest teardown funded owner=S1/S3/S5` | L | pass |
| Expired credentials: refresh refused | `actor=GitHub expired contributor chain outcome=refresh reauthorize stops with authorize, no stale push owner=S4/S5` | L | pass |
| Expired credentials: 15-minute window mid-push | `actor=Git operation expiry outcome=revoked midpush, absent remote voids attempt, fresh receipt retries owner=S1/S4` | L | pass |
| Fork delay (gating-origin wait, #1113 decision) | `actor=GitHub fork timing outcome=gating prerequisite wait without compute then initial shipping owner=S4/S5` | L | pass |
| Fork delay: a bound fork that disappears blocks, no rebind | `actor=GitHub bound fork deletion outcome=blocked at shipping without rebind owner=S1/S4/S5` | L | pass |
| Fork delay: over-broad App installation | `actor=contributor App configuration outcome=broad installation blocked owner=S1/S4` | L | pass |
| Lost API response: push acknowledgment (scenario 18) | `actor=GitHub transport outcome=lost push acknowledgment reconciled from the remote SHA, no second push owner=S4` | U | pass |
| Lost API response: unobserved PR submission (scenario 11) | `actor=contributor outcome=unobserved prefilled PR found once by head, base, state=all and marker owner=S4` | U | pass |
| Lost API response: repeated PR submission (scenario 11) | `actor=contributor outcome=double submission is an ambiguous hand-off, never a third link, until one marked PR matches owner=S4` | U | pass |
| Lost API response: unobserved engagement comment (scenario 16) | `actor=contributor outcome=unobserved engagement comment reconciled after restart without a duplicate request owner=S2` | U | pass |
| Policy change after implementation: AI ban (scenario 16) | `actor=maintainer outcome='AI ban' after implementation blocks before any receipt, evidence retained owner=S2/S4` | U | pass |
| Policy change after implementation: issue closed | `actor=maintainer outcome='issue closure' after implementation blocks before any receipt, evidence retained owner=S2/S4` | U | pass |
| Policy change after implementation: invitation revoked | `actor=maintainer outcome='invitation revocation' after implementation blocks before any receipt, evidence retained owner=S2/S4` | U | pass |
| Policy change during a revision: AI ban | `actor=maintainer outcome='AI ban' during a revision blocks before the revision push, evidence retained owner=S2/S5` | U | pass |
| Policy change during a revision: issue closed | `actor=maintainer outcome='issue closure' during a revision blocks before the revision push, evidence retained owner=S2/S5` | U | pass |
| Policy change during a revision: invitation revoked | `actor=maintainer outcome='invitation revocation' during a revision blocks before the revision push, evidence retained owner=S2/S5` | U | pass |
| Upstream drift before the push | `actor=upstream maintainer outcome=base advances before push: rebase, fresh verification, shipped SHA equals verified SHA, old SHA never receipted owner=S3/S4` | U | pass |
| Upstream drift after the push | `actor=upstream maintainer outcome=base advances after push: limitation recorded, not re-verified owner=S3/S4` | U | pass |
| Upstream drift on a touched file | `actor=upstream maintainer outcome=base advances on a touched file: rebase_conflict hand-off, nothing pushed owner=S3` | U | pass |
| Remote divergence before the push | `actor=contributor outcome=out-of-band fork commit before push: remote_diverged, nothing overwritten owner=S4` | U | pass |
| Remote divergence before a revision | `actor=contributor outcome=out-of-band fork commit 'before the revision' blocks, nothing overwritten owner=S4/S5` | U | pass |
| Remote divergence after revision admission (lease race) | `actor=contributor outcome=out-of-band fork commit 'after revision admission (CAS race)' blocks, nothing overwritten owner=S4/S5` | U | pass |
| Expected history rewrite during a revision (scenario 18) | `actor=contributor outcome=expected revision history rewrite is a CAS push from the last verified SHA owner=S4/S5` | U | pass |
| Shipping integrity: artifact modified after verification (scenario 10) | `actor=filesystem outcome=verification evidence 'record byte altered' after the verdict refuses the receipt and needs fresh verification owner=S3/S4` | U | pass |
| Shipping integrity: torn verification record | `actor=filesystem outcome=verification evidence 'record torn' after the verdict refuses the receipt and needs fresh verification owner=S3/S4` | U | pass |
| Shipping integrity: altered boundary evidence | `actor=filesystem outcome=verification evidence 'boundary evidence altered' after the verdict refuses the receipt and needs fresh verification owner=S3/S4` | U | pass |
| Shipping integrity: a transient read failure is not a block | `actor=filesystem outcome=transiently unreadable verification record fails the step without blocking, then ships owner=S3/S4` | U | pass |
| Shipping integrity: changed SHA after verification | the drift-before-push scenario above: the rebased SHA is freshly verified and the old verified SHA is never receipted or pushed; the direct receipt refusal is `scenario 10: changed SHA after verification refuses without effects` in `shipping.integration.test.ts` | U | pass |
| Report parsing: malformed junit (regression evidence) | `actor=repository tests outcome='malformed' junit report in 'regression evidence' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: malformed junit (independent verifier) | `actor=repository tests outcome='malformed' junit report in 'independent verifier' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: missing junit (regression evidence) | `actor=repository tests outcome='missing' junit report in 'regression evidence' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: missing junit (independent verifier) | `actor=repository tests outcome='missing' junit report in 'independent verifier' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: oversize junit (regression evidence) | `actor=repository tests outcome='oversize' junit report in 'regression evidence' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: oversize junit (independent verifier) | `actor=repository tests outcome='oversize' junit report in 'independent verifier' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: zero suites (regression evidence) | `actor=repository tests outcome='zero-suite' junit report in 'regression evidence' is inconclusive and never ships owner=S3` | U | pass |
| Report parsing: zero suites (independent verifier) | `actor=repository tests outcome='zero-suite' junit report in 'independent verifier' is inconclusive and never ships owner=S3` | U | pass |

## What the scenarios found

Part 1 fixed its findings in #1113. Part 2 found five production gaps; each is fixed in
#1114 with the scenario above as its regression (all five scenarios failed on the base
commit and pass with the fix):

1. **A stale publication freshness check failed the step instead of blocking.** A policy
   ban, issue closure or invitation revocation seen by the receipt's freshness check during
   initial shipping left the run in `shipping` with a generic diagnostic, and no freshness
   evidence. It now moves to `blocked` with the report retained as `shipping_freshness`.
   Revisions already blocked this way through the tracker.
2. **A diverged fork branch before the first push left the run unresumable.** The intent
   journal blocked with `remote_diverged` and nothing was overwritten, but the controller
   stayed in `shipping` and every resume failed in recovery. The initial path now adopts the
   intent journal's recorded block, as revision tracking does, and retains the expected and
   observed SHAs. Its status text claims "nothing was overwritten" only for refusals proven
   before any write.
3. **Verification evidence altered after the verdict failed the step instead of
   blocking.** A corrupted or torn record, or altered boundary or log evidence, now blocks
   with no receipt and no push. A transient read failure of the record still fails the
   step without blocking, and the run ships once the record is readable again.
4. **The `rebase_conflict` reason was dropped.** Drift onto a touched file became a bare
   `paused_user`. The reason and paths are now retained as `drift_handoff`.
5. **An ambiguous reconciliation pointed the contributor back at the prefilled link.** With
   two marked PRs the run issued no new link, but `zt-run status` still told the contributor
   to submit through the old one. A history-bound `stop_notice` now carries the hand-off
   text, and status shows it only for exactly that stop. An unreadable listing keeps it;
   once exactly one marked PR matches, it is retired.

## Residual risks

- **Edge fidelity.** GitHub, the model and the VM are scripted. Real API consistency and
  timing (for example, a listing that trails a just-created PR) are covered by the
  fail-closed reconciliation rules, not by these suites. The live acceptance demo on the
  controlled upstream/fork pair (#1115) is the owner-run end-to-end check on real services.
- **An ambiguous double submission is hard to resolve in place.** Reconciliation lists PRs
  with `state=all`, so closing the extra PR does not make the match unique; retargeting it
  to another base does. The run hands off and never issues another link.
- **A deleted invitation comment is unknown, not revoked.** Revocation is modelled as a
  later maintainer refusal (a negative comment), which blocks. If the inviting comment is
  deleted, permission cannot be established; shipping fails closed with a step failure and
  a diagnostic. That is a hand-off to a person (PRD §5.9 "if authority cannot be
  established, hand off"), but not a recorded `blocked` state.
- **An unreadable boundary or log evidence file blocks.** The verifier's loader reports a
  missing or unreadable evidence file as `evidence_mismatch`, so even a transient read
  failure of such a file blocks the run (fail closed). Only the record itself has a
  separate transient `unavailable` outcome.
- **Resuming a run whose verification record was altered refuses during journal replay**
  (`invalid_outcome`). The run stays `blocked` and never ships; a new run verifies afresh.
- **A receipt can be issued and never used.** `makeAuthorize` checks freshness before
  issuing the receipt and again afterwards. If permission changes between the two reads,
  the receipt is issued but its nonce is never consumed and nothing is pushed.
- **Out of scope by the owner's threat model** (2026-10-09 and 2026-10-10): hostile
  in-process code, and a same-OS-user adversary editing run-store files on purpose. The
  integrity scenarios cover accidental corruption and torn writes only.

## Verdict

**GO** for release gate 4. All 44 gate scenarios pass through the real controller, the
global invariants hold after each of them, and no scenario is marked `it.fails`. The
residual risks above are recorded limits, not failing gate items. As PRD §9 notes, this
establishes release readiness for the engine, not market validation.
