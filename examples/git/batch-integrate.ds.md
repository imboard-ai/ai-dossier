---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "batch-integrate",
  "title": "Batch Integrate — Verify N Members Once, Repair What Is Yours, Escalate What Is Not",
  "version": "1.5.2",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-25",
  "objective": "Merge a batch's members onto its integration branch, run the repo's batch gate (gate.batch when declared) ONCE for all of them, repair mechanical failures, escalate semantic ones, never evict on a signal the verification cannot stand behind, run the risk-floor review over review=full members' commits, refuse to ship any member with no real review, release claims, and ship one PR",
  "category": [
    "development",
    "orchestration"
  ],
  "tags": [
    "batch-cycles",
    "integration-branch",
    "parent",
    "verification",
    "handover",
    "conformance",
    "review"
  ],
  "risk_level": "high",
  "risk_factors": [
    "modifies_files",
    "network_access",
    "creates_pull_request"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Reverts a member's commits when evicting it. Force-pushes the integration branch only after an eviction, with --force-with-lease.",
    "Posts a parent-run phase=review milestone on a member issue whose own review never ran (review_by=parent), or evicts that member"
  ],
  "inputs": {
    "required": [
      {
        "name": "batch",
        "description": "Batch id",
        "type": "string"
      },
      {
        "name": "integration_branch",
        "description": "Branch every member is based on and lands onto",
        "type": "string"
      },
      {
        "name": "members",
        "description": "Issue numbers and their member branches",
        "type": "array"
      },
      {
        "name": "worktree",
        "description": "Absolute path to the parent's worktree on the integration branch, dependencies installed",
        "type": "string"
      }
    ],
    "optional": []
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "content_scope": "self-contained",
  "checksum": {
    "algorithm": "sha256",
    "hash": "9d7ee5df5115c1afafb8e3a137ef02763b4e54bc385fe38501ff8edbd374dcf8"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "2gsqDHnLOoNFcZBkq40eTgJL3gXExLY3PlCxZGCvpct9BtywnqHbC3pP5exYnf6+8CjY93I0vbAWFTR3gPiBAg==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-25T08:49:00.765Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Batch Integrate

## Objective

N members implemented N issues in isolation. You make them one shippable change: merge, verify **once**, repair what is yours to repair, and ship a single PR. The one expensive verification replacing N is the entire economic case for the batch.

**Your defining constraint: everything you act on is second-hand.** You did not write this code. Every decision — did the suite finish, did it pass, whose change broke it, is this infrastructure or code — is an inference from an artifact. Each has an expensive wrong answer.

## Prerequisites

- Every member has pushed its branch and posted a `## handover:v1` comment. **Read them all before you start.** They are your only access to each author's intent, and they name what each member deliberately left unverified — which is exactly the surface you now own.
- The repo declares its verification capabilities. You invoke what the repo declares; you never hardcode a script name.
- Each member's **review level** — `ai-dossier sched status --json` (the member entry's `review`, `light` when absent) — and its **review evidence**: the latest `phase=review` milestone on the member issue (`ai-dossier runstate last --issue <n> --json`).

### Step 0: Review-evidence gate — no member ships unreviewed

For every member, read its `phase=review` milestone. It is **missing review** when any of:

- there is no `phase=review` milestone for this batch's run, or it is `blocked` / `partial` with a required agent pending;
- `agents_done` is `0`, `none`, or empty — imboard#4178's member (run `r-4178-928b`) posted exactly this, `status=done agents_done=0`, and nothing had looked at the diff;
- the member is `review=full` and `agents_done` lacks `security` or `conformance`, or the milestone's `tier` is not `full` — a light-grade review on a risk-floor member is not the review it was admitted on;
- the member is `review=light` and `agents_done` lacks `conformance` (the correctness reviewer floor).

**Refuse to ship a member with missing review.** Two remedies, in this order:

1. **Run the missing review yourself**, on a decision-grade model (Step 4b), over that member's commits only (Step 5's per-member diff), at the member's level per member-cycle Step 4b; apply fixes as batch-level repairs and verify them (Step 4). Post it on the member issue: `ai-dossier runstate post --issue <n> --phase review --status done ... --kv agents_done=<the agents that ran> --kv review=<level> --kv review_by=parent`.
2. If that cannot complete, **evict** the member (Step 4's eviction path, claim-release included) with reason `review-missing`. The rest of the batch still ships.

Record every member caught by this gate in the batch summary — it is a member-cycle defect signal, not noise.

## Actions to Perform

### Claim-release protocol

Run this protocol in the same step that records any member disposition: eviction, supersession, gate decline, or shipment. Remove `in-progress`, then remove every assignee returned by GitHub. For a non-shipping disposition, also post a comment naming the batch id and reason:

```bash
gh issue edit "$issue_number" --remove-label "in-progress"
gh issue view "$issue_number" --json assignees --jq '.assignees[].login' | while read -r login; do
  gh issue edit "$issue_number" --remove-assignee "$login"
done
```

This protocol is safe to repeat, and an already-closed issue with a stale claim must still run it.

### Step 1: Merge members onto the integration branch

Merge each member branch in turn. Expect most to be clean.

**When two members conflict, look at whether they are independent.** Members that each anchored an addition to the same structural landmark — the same component, the same registry, the same list — will collide when one of them relocates it, even with disjoint file predictions. Members that are slices of one designed sequence (PR1/PR2/PR3 of a feature) are not independent at all and will conflict by construction.

A conflict is **not** grounds for eviction. Resolve it so every member's intent survives. If resolving requires deciding what a feature *should* do, that is semantic — escalate it (Step 4). If the two features genuinely cannot coexist, say so and name which member to evict and why; do not silently drop one member's work to get a clean merge.

Then bring the base up to date. **A batch that outlives another batch's merge inherits its changes** — on an active repo the base can move by several commits during a single batch's lifetime. Merge the base branch in and resolve; additive collisions in shared constant or registry files are the common case and resolve by union.

**Bring the base up to date by REBASING, not merging.** A branch that accumulates merge commits from the base can no longer be rebase-merged at ship time (Step 6), and once those merge commits carry your conflict resolutions a local rebase re-conflicts too. Rebase while the branch is still linear and you keep both options; merge and you have chosen your ship strategy without noticing.

A batch that outlives another batch's merge inherits its changes, and on an active repo the base can move by several commits during one batch's lifetime. Re-check the base immediately before shipping — and treat a long-lived batch as a reason to ship what you have rather than to add members.

**Three resolutions, not two.** Beyond "keep both" and "escalate" (Step 4):

- **Union — but only for FLAT regions.** Concatenating both sides is safe for adjacent top-level declarations or a list of constants. When the conflict sits INSIDE a syntactic construct — an interface, an object literal, a call expression — *your* block's closing delimiter lies past the `=======` marker and concatenating silently drops it. The result looks like a clean resolution and fails to compile at a line far from the conflict. Recover the exact closing from the pre-merge version (`git show <branch>:<path>` on the side that owned the block) and typecheck each resolved file individually.
- **Supersession.** The base may have ALREADY implemented what a member was written to do — a second issue solving the same problem, often better factored, landing while the batch ran. Take the base's implementation, drop the member's, and keep any tests the member added that still assert the behaviour: a different implementation of an equivalent contract makes them added coverage, not dead weight. Close that member's issue as superseded, naming what actually shipped — a reader tracing the member's commit must not conclude it is what is live — and run the claim-release protocol **in the same step** (the claim prep's manifest step wrote; supersession is one of the disposals that must release it).

### Step 2: Cheap gates first

Run the repo's cheap checks over the combined branch — typecheck, lint/format, and any fast repo-wide guard — **before** paying for the expensive suite.

This ordering is not a nicety. Members' real defects are disproportionately caught here: formatting that fails a shared gate, a repo-wide convention guard, a compile error at a merge seam. Finding one of those *inside* the expensive run costs the whole run.

Repair what these surface (Step 3), then proceed.

**Run the cheap gates to completion, repair, re-run them, and only then start the expensive verification.** This is not merely sequencing — measured across three batches, **every real member defect was caught by a hygiene/typecheck-class gate and none was ever first caught by the integration suites**: a mongoose call needing an `ordered` flag, a repo-wide formatting-convention violation, and a set of assertions that were unreachable because the fixture never satisfied the handler's own validator.

Yet two of those three batches burned a **full expensive cycle** discovering one, because the cheap pass ran as a stage *inside* the expensive run rather than before it. A 6-8 minute pass that prevents one 50-90 minute cycle pays for itself on the first defect, and on this evidence there is roughly one per batch.

### Step 3: Run the expensive verification ONCE, and read its result in four states

Invoke the repo's declared **batch gate** for the combined branch: `ai-dossier cap run gate.batch` when the capability manifest declares an active `gate.batch` — the repo's CI-parity gate, affected-scoped over the union of the members' diffs, the same gate one ordinary PR pays, paid once (#770 P8 / ai-dossier#777). Fall back to `test.full` only when no `gate.batch` is declared. The scheduler's `batch-validate` (sched with #777) already runs this ladder; when you invoke the gate yourself, keep to the same order. A repo whose only full gate declares itself timeout-prone and has no `gate.batch` is refused at enqueue — a batch that exists there was formed before the rule; say so, and expect `automation-broken` rather than a verdict.

On imboard, `test.full` is documented as slower than any reasonable `cap run` timeout (two runs killed at 30 and 60 minutes); batches #4244 and #4253 blocked at `batch-validate` with `suite-unreadable`. That is why the batch gate is `gate.batch`, not the full suite. Then classify the outcome — **four ways, never two:**

| Verdict | Meaning | Action |
|---|---|---|
| `ok` | verification passed | proceed to review and ship |
| `task-failed` | a real defect, with evidence the verification earned | repair (below), then evict on budget exhaustion |
| `automation-broken` | the verification could not stand behind its own answer | **BLOCK. Change nothing. Retry or surface.** |
| `capability-unavailable` | the repo declares no such verification | skip it and say so; never treat absence as a pass |

**The `automation-broken` branch is the one that saves work, and it is not rare.** Shared infrastructure — a test-database pool, a container registry, a runner — is contended by everything else running against it. A contended resource produces failures that look exactly like member regressions: whole suites red, dozens of failing test names, often in a suite whose subject matter matches a member's change.

Distinguish them by cause, not by name. Read the actual error under a failing test. If every failure traces to a connection timeout, a lease failure, a setup helper throwing on a 5xx, or a runner crash — that is `automation-broken`. Zero genuine assertions among many failing test names is the signature.

**Never revert a member's commits on a signal the verification cannot stand behind.** A retry costs minutes; a wrong eviction destroys a member's work and the money that produced it.

### Step 4: Repair what is mechanical, escalate what is semantic

The split is **authority, not difficulty.**

**Yours (mechanical):** formatting, a call-signature or API-shape error, a missing flag, a merge seam, a convention a repo-wide guard names. You have the diff and the trace; that is enough.

**Not yours (semantic):** any question whose answer requires knowing what a member's feature *should* do. An assertion mismatch inside a member's own subject matter is the common shape. Repairing your way to green through one of these is precisely how a batch ships a change that does not do what its issue asked.

Escalate a semantic failure to a bounded member-tier agent with the failure evidence and the relevant handovers, and give it explicit permission to report that it cannot decide. That is cheap and it is reliably better than guessing.

**Repair, then VERIFY.** Re-run the affected member's own tests before you commit a repair. A repair is a change to code you did not write, against intent you inferred — it can regress the member. Applying a fix and moving on is how a "trivial" repair ships a defect.

Commit repairs as batch-level commits, attributable to no member.

**Bound the repair budget per member.** Exhausting it is the signal to evict, not to keep trying. Evicting means reverting that member's commits, re-running verification, and requeueing the issue with the failure evidence attached — the rest of the batch still ships. **Run the shared claim-release protocol in the same step that records an eviction or a gate decline.** This is load-bearing, not bookkeeping — a requeued member still carrying `in-progress` is skipped by the next prep run's readiness screen forever (the claim prep's manifest step wrote; the read side trusts it absolutely), so a missed release strands the issue in "looks busy but is not" until someone applies stale-claim recovery by hand.

### Step 4b: Which model decides — a different axis from tier

`ModelTier` grades how hard something is to **write**. It does not grade how consequential
something is to **decide**, and the two come apart exactly where this dossier does its work.

**Dispatch on `fable` (`--model fable`) wherever the output is a JUDGMENT:** the aggregate
review below, the fix-vs-evict call, and any conflict resolution that turns on what a feature
*should* do. Reach for it where a major product or technical decision is due, where the change
is architectural, or where risk is elevated — security or otherwise.

**Do not** apply it to member implementation: there the member's own `tier` governs, and a
member writing a small fix does not need a decision-grade model to type it.

The distinction is not cosmetic. In the sibling `batch-issues-preparation` dossier the risk
floor — auth, payments, migrations, security — was being decided by the CHEAPEST tier, whose
answer then selected the model that did the work. A judgment feeding a capability choice should
never be the least capable step in the chain.

### Step 5: Aggregate review, plus the risk-floor review over `review=full` members

**Aggregate review — every member.** Review the combined diff for **cross-member interaction** — seams, duplicated helpers, conflicting assumptions between members. Per-issue acceptance criteria were already verified by each member's own conformance verdict; re-reviewing them here dilutes the pass over a large diff and finds less.

**Risk-floor review — `review=full` members only (#770 P1, Option A; at most 2 per batch).** A risk-floor issue (auth, billing/payments, security, migrations, deploy) rides the batch on the promise that it gets the review full-cycle would have given it. Its member ran a full-tier review of its own change; you review **its commits as they landed on the integration branch** — after your merges, conflict resolutions and repairs, which the member never saw:

```bash
# the member's own commits carry the (#<n>) subject trailer (member-cycle Step 4)
SHAS=$(git log --reverse --format=%H --grep="(#<n>)" origin/<base_branch>..HEAD)
git show --format='%H %s' $SHAS            # the member's changes as integrated, commit by commit
FILES=$(git show --name-only --format= $SHAS | sort -u)
git diff origin/<base_branch>...HEAD -- $FILES   # the same files in the final combined state (catches repairs/resolutions)
```

Run `imboard-ai/git/review-issue`'s Stage 1 risk-floor tier (`full`: every dimension agent, **Security** first among them) over that diff, on a decision-grade model (Step 4b). Also check every batch-level repair or conflict resolution that touched one of that member's files. Findings route like any other: mechanical → repair and verify (Step 4); semantic → escalate; an unresolvable security finding → evict that member, never ship around it. Name the risk-floor review per `review=full` member in the PR body.

`review=light` members get the aggregate review only.

### Step 6: Ship one PR

Re-check Step 0 immediately before opening the PR: **no member with missing review ships.** Open a single PR closing every member issue that survived. **Merge with rebase, never squash** — per-issue commits carry the attribution eviction, revert, and bisect all depend on, and squashing destroys it.

### Step 6a: Verify closure and release claims

After the merge is confirmed (`mergedAt` non-null, `state` `MERGED`), verify the final state instead of trusting `Closes #N`. For each surviving member, retain its own shipping commit SHA from the rebase-merged PR, set `issue_number` and `member_sha`, then query its state. An open member must receive one comment naming the PR, merge timestamp, and its own shipping commit SHA, then be explicitly closed and recorded in `closed_by_workflow`. Include a durable `batch-close:v1` marker in that comment. A closed member with that marker is `already_closed` on a rerun; a closed member without it is `closed_by_github`:

```bash
STATE=$(gh issue view "$issue_number" --json state --jq .state)
if [ "$STATE" = OPEN ]; then
  gh issue comment "$issue_number" --body "<!-- batch-close:v1 batch=$batch pr=$pr -->
Shipped in #$pr at $merged_at; member commit: $member_sha. Closing explicitly because the batch verified GitHub did not close it."
  gh issue close "$issue_number"
  closed_by_workflow+=("$issue_number")
elif gh issue view "$issue_number" --json comments --jq '.comments[].body' | grep -Fq "<!-- batch-close:v1 batch=$batch pr=$pr -->"; then
  already_closed+=("$issue_number")
else
  closed_by_github+=("$issue_number")
fi
```

Run the claim-release protocol for every shipped member after this state check. Its idempotency repairs an already-closed issue with a stale claim on rerun.

Query the batch anchor after every member. If it is still open **and every member shipped** — closed as completed by this PR or a commit in the base, none evicted, handed back, or requeued — comment with the batch PR, merge timestamp, and the complete member-to-shipping-commit list, then close it explicitly. Otherwise leave the anchor open and post one comment naming which member did not ship and why: an anchor with a failure trail stays open for an operator (ai-dossier#768). On rerun, a closed anchor receives neither a duplicate comment nor another close request.

Report `closed_by_github`, `closed_by_workflow`, `already_closed`, and `claims_released` in the batch summary. A non-zero `closed_by_workflow` count is an operational signal that GitHub's closing-reference behavior is not being relied on silently.

The PR body should carry a section per member and name every batch-level repair with its cause.

**If rebase-merge is refused, ship with a MERGE COMMIT — never a squash.** A host will refuse to rebase a branch containing merge commits; on an otherwise-green PR, a message to the effect of *"this branch can't be rebased"* means merge commits, not a conflict. The requirement here is that **per-issue commits survive**, because eviction, revert and bisect all depend on them. A merge commit preserves every one of them and satisfies that requirement. A squash destroys them and never does.

**The PR's own CI is not redundant with your run.** It typically runs a different selection, in a clean environment, against its own infrastructure. It will catch things your run did not, and it is the trustworthy signal when your own run was degraded by contention. Your job is not finished when your local gate is green.


### Step 6b: Manual recovery — a hand-shipped batch still ends at Step 6a

When the batch left this dossier's path — the scheduler blocked it, an agent or a human took the integration branch over, or the PR was opened by hand — the recovery is not finished when its PR merges. Two rules, both mandatory:

1. **The PR body carries `Closes #<member>` for every shipped member and `Refs #<anchor>` — never `Closes #<anchor>`.** A GitHub closing keyword on the anchor skips every failure-trail check (a handed-back, evicted, not-planned, or dropped member). The anchor is closed only on positive evidence: by Step 6a, or by the scheduler's own evidence-gated close (ai-dossier#768).
2. **Run Step 6a after the merge, exactly as the happy path does** — member closure verification with the `batch-close:v1` marker, claim release, then the anchor query. Opening, merging, or rebase-merging the PR yourself does not exempt the recovery from it: Step 6a is the step that verifies and closes the anchor, and skipping it is how an anchor stays open after all its work has shipped.

**Record the hand-opened PR in the scheduler ledger.** A PR opened by hand is usually picked up automatically once it merges (the scheduler looks for exactly one merged PR from the batch branch, ai-dossier#789). If `sched status` still shows the batch blocked with no PR, for example because several merged PRs came from that branch, record it explicitly with `ai-dossier sched attach-pr --batch <id> <pr>` (ai-dossier#824). The command refuses a fork, an unmerged PR, the wrong base or head, or a PR created before the batch, and it never closes the anchor itself.

Close the anchor only when every member is closed as completed by the shipped PR or a commit in the base, and none was evicted, handed back, or requeued. If any member is still open, closed as not planned, or carries a failure, leave the anchor open and say which member and why in one comment on it — an anchor with a failure trail stays open for an operator.

**If rebase-merge is refused, ship with a MERGE COMMIT — never a squash.** A host will refuse to rebase a branch containing merge commits; on an otherwise-green PR, a message to the effect of *"this branch can't be rebased"* means merge commits, not a conflict. The requirement here is that **per-issue commits survive**, because eviction, revert and bisect all depend on them. A merge commit preserves every one of them and satisfies that requirement. A squash destroys them and never does.

**The PR's own CI is not redundant with your run.** It typically runs a different selection, in a clean environment, against its own infrastructure. It will catch things your run did not, and it is the trustworthy signal when your own run was degraded by contention. Your job is not finished when your local gate is green.

## Signal discipline — normative, not advisory

Everything you decide is read from an artifact. These rules exist because an actor who knew them still got each one wrong in practice:

1. **Liveness is proven, never inferred.** Track the process you launched, by the identity you captured at launch. A pattern match finds the wrong process — including, on a shared machine, somebody else's; and a pattern specific enough to name your target also matches your own command line.
2. **Completion requires an explicit terminal marker from the runner.** Output silence is not completion — a quiet log is often a long test running silently.
3. **A failure filter must match the runner's actual output.** Verify your filter matches something known-present before trusting a zero from it. A filter that finds nothing is indistinguishable from a condition that is not there.
4. **A non-zero exit code is a status, not necessarily an error.** Read the tool's contract.
5. **Absence of a result is not a result.** "0 tests ran" is a suite that never ran, not a pass. An empty capture is not a verdict.
6. **A result field named "success" is not a verdict.** Agent CLIs report a success-shaped subtype alongside an error flag. Read the error flag and the result text.
7. **Split every cost, duration and outcome statistic by outcome before quoting it.** A median over mixed populations inverts conclusions — fast failures masquerade as fast successes.
8. **Verify against what will ship, not your working tree.** A stack trace citing a line number your patch moved means the running code does not contain your patch.
9. **Never extrapolate progress linearly.** Verification stages are wildly uneven; one group can take an hour and the next a minute.

## Success Criteria

- Every surviving member merged, with per-issue commits intact
- The repo's batch gate (`gate.batch` when declared) run **once** for the batch, not once per member
- No member shipped without real review evidence — every shipped member's `phase=review` milestone names the agents that ran (never `agents_done=0`); a missing one was remedied by the parent (`review_by=parent`) or the member was evicted
- Every `review=full` member (≤ 2) received the risk-floor review over its integrated commits, named in the PR body
- No member evicted on an `automation-broken` signal
- Every repair verified against the affected member's own tests before commit
- One PR, rebase-merged, closing every surviving member issue
- Evicted members requeued with their failure evidence; the batch ships what survived
- Every merged member and the anchor have their final issue state verified; open members are closed explicitly with their traceability evidence, and the anchor is closed only when every member shipped (otherwise it stays open with one comment naming the member and why)
- The batch summary separates GitHub closures from workflow closures and records claim release
- Every disposed member's batch claim released in the step that recorded the disposal — evicted, superseded, gate-declined, and shipped members carry no `in-progress` label or assignee (the claim prep's manifest step wrote)
- A hand-recovered batch's PR referenced the anchor with `Refs #<anchor>` (never a closing keyword), and Step 6a ran after its merge (Step 6b)
