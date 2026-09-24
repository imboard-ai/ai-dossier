---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "batch-issues-preparation",
  "title": "Batch Issues Preparation — classify, DAG, compose batches, enqueue",
  "version": "3.2.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-24",
  "objective": "Turn an issue list/range into admitted, classified, batched scheduler queue entries: free batch compose over the whole set first, body-readiness screen + backfill to min_members, decision-grade classify only admitted members, risk-floor, deploy-pipeline and >8-file issues as review=full members (at most 2 per batch), no batch under 2 members, then anchor, audit, claim and enqueue with a per-member review level",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "batch-cycles",
    "classification",
    "scheduling",
    "runstate",
    "batch-compose"
  ],
  "risk_level": "medium",
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates batch-epic anchor issues and applies labels in the target repo",
    "Posts classify records, rationale comments, and plan:v1 artifacts on ADMITTED batch members only (never on issues batch compose excluded)",
    "Claims each enqueued batch member with the in-progress label and a pickup comment (skipped under dry_run)",
    "Writes scheduler queue entries via sched enqueue --from-manifest (skipped under dry_run)"
  ],
  "inputs": {
    "required": [
      {
        "name": "issues",
        "description": "Issue list/range to prepare — fleet-cycle Phase 1 grammar: explicit list `1,2,3`, range `1..9`, mixed `1,2,5..8`",
        "type": "string"
      }
    ],
    "optional": [
      {
        "name": "dry_run",
        "description": "Produce everything (classify records, plan artifacts, anchor issues, audit file, manifest) but do NOT invoke sched enqueue — the shadow-mode deliverable (RFC-0001 G Step 2): admitted members get classified and planned while execution stays untouched.",
        "type": "boolean",
        "default": false
      },
      {
        "name": "min_members",
        "description": "Minimum viable batch (#770 P4). Survivors below it are backfilled from batch compose's ranked backlog candidates; fewer than 2 after backfill forms no batch.",
        "type": "number",
        "default": 3
      },
      {
        "name": "dispatch_profile",
        "description": "The validated scheduler dispatch profile selected by batch-cycle-skill; carried to every slot member and passed explicitly to sched enqueue.",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "content_scope": "references-external",
  "checksum": {
    "algorithm": "sha256",
    "hash": "a1f16f9315a443fa6689bb393c7202dd63eadb3825df5760311e3533beb619e4"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "9EmBs9+OBgG1Gs9OMazfcS1IiDcxWsGUUq6TTSeWDeHw/C3XoT7OjBUtF1BgaD7ANBEZaky9x49DO+RkHn9YCw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-24T15:56:48.017Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Batch Issues Preparation — classify, DAG, compose batches, enqueue

## Objective

The judgment-heavy front door of Batch Cycles (RFC-0001 C.3): turn a raw issue list/range — potentially hundreds — into classified, dependency-ordered, batched queue entries for the deterministic scheduler (`ai-dossier sched`, #460). Everything after the queue is the scheduler's; everything deeper than a light plan is member-cycle's or full-cycle's.

**Non-responsibilities (RFC-0001 C.3):** execution and supervision (the scheduler's), deep per-issue planning (slot/full cycle's). This dossier never dispatches a cycle, never creates worktrees, branches, or PRs, and never posts batch milestones on anchors — the scheduler owns the batch lifecycle from `batch-setup` onward.

## Prerequisites

- `ai-dossier` CLI >= 0.61.0 (`batch compose` #773, `classify prescreen` schema `prescreen:v4` #772/#805/#818, `sched enqueue` manifest `review` field + the per-batch `review=full` cap #771, `plan post|get`, `runstate mint|post|last`). Beware shadow copies: a repo-local `node_modules/.bin/ai-dossier` can shadow the global install — when a documented command reports `unknown command`, call the newer binary by absolute path.
- GitHub CLI (`gh`) installed and authenticated
- `imboard-ai/git/issue-cycle-classifier` >= 1.4.0 available in the registry (it reads prescreen:v4, treats E.2 rules 1/4/5 as review floors and records `review`, #783/#805/#818)
- Run from the repository that owns the issues — dependency resolution, path grounding, and `sched enqueue`'s project detection run against it

If `dispatch_profile` is supplied, first read `ai-dossier sched status --json` and
verify that it is an exact key in `dispatch.profiles`. Do not infer or silently
fall back to another profile. The value is a batch-level fact, not a per-issue
classification choice.

## Actions to Perform

**Cost order (#770 P5) — free before paid, whole set before members.** Step numbers are kept stable for cross-references, but the execution order is:

1 (resolve) → **3a** (`batch compose`, free, whole set) → **3b** (body-readiness screen + backfill, free) → 2 (DAG over admitted members) → **3c** (decision-grade classify, admitted members ONLY) → 4 → 5 → 6 → 7 → 8 → 9.

No decision-grade classifier is ever dispatched for an issue Step 3a excluded or Step 3b dropped. On the #770 evidence set, the old order spent ~425k decision-grade tokens classifying five hand-picked issues, four of which the free pre-screen already knew could not be batched.

### Step 1: Resolve the Issue Set (fleet-cycle Phase 1 semantics)

1. Parse `issues` into a concrete list of integers — explicit list `1,2,3` → `[1,2,3]`; range `1..9` → `[1..9]`; mixed `1,2,5..8` → `[1,2,5,6,7,8]`. De-duplicate and sort ascending.
2. For each issue, fetch state, title, body, labels, and comments (`gh issue view <n> --json ...`).
3. Drop issues that cannot be prepared — and REPORT every one with its reason (never silently omit). **Step 3a's `batch compose` applies every rule below deterministically** and returns them as `excluded[]` with stable `code`s (`closed`, `assigned`, `in-progress`, `in-flight`, `sched-active`, `hard-block-label`, `batch-anchor`, `not-a-unit`, `data-mutation`, `open-dependency`, `prescreen-full`) — use its list as this skip table rather than re-deriving it by hand:
   - **closed** or **non-existent** (fleet Phase 1 rule)
   - label `epic`, `batch-epic`, `decomposed`, or `needs-clarification` — not implementable as a unit
   - **in-flight or parked**: label `in-progress` or `decision-pending`, OR its latest runstate milestone (`ai-dossier runstate last --issue <n> --json`) is any phase other than `classify`. A classify record landing on an active run's trail breaks its resume — gate-issue reads the LAST milestone and would treat the run as fresh.
   - already an **active entry** in the scheduler queue (`ai-dossier sched status --json`; entries in terminal states may be re-prepared; a missing sched state is an empty queue)

The skipped table goes in the output AND the audit file: issue, reason.

### Step 2: Build the Dependency DAG (fleet-cycle Phase 2 rules; one deliberate divergence — see the file-overlap bullet)

Runs AFTER Step 3a/3b, over the admitted members only (picks that survived plus any backfill) — an excluded issue needs no edges. For every pair of remaining issues, determine whether one must merge **before** the other. **When uncertain, prefer adding a dependency edge (serialize) over assuming independence** — a false parallel is far more expensive than a false serial.

**Explicit dependency signals (authoritative):**

- "depends on #X", "blocked by #X", "after #X" in the issue body or comments
- GitHub issue links / tracked-by / parent-child (epic → sub-issue)
- A declared `base_branch` (`merges into \`<branch>\``) that points at another issue's branch or epic

**Inferred dependency signals (judgment):**

- **File-overlap collision** — two issues that will plausibly modify the same files or modules (use the classify records' predicted files and areas once Step 3 has run; before that, the issue text). Fleet serializes colliding issues; batch cycles deliberately diverge on this one point: when both issues classify slot and land in the SAME batch, overlap is co-batched as an E.4 eviction group instead of serialized — the edge remains and orders the members internally
- **Logical/data ordering** — issue B builds on a capability, schema, or API that issue A introduces
- **Shared migration, lockfile, or global-config surface** — will conflict on merge even if "different features"

Also record each issue's `base_branch` (parsed from `merges into \`<branch>\``; default `main`).

Detect cycles over the combined graph; a true cycle is **surfaced and STOPS the run** — report the cycle's members and edges; the operator resolves it.

For every edge A→B, resolve B's state: edges to merged/closed deps are **satisfied — drop them** from the manifest-facing graph; open deps outside the submitted set make A un-preparable (Step 5 defers it).

### Step 3: Admit, Then Classify Only What Was Admitted (#770 P5)

#### Step 3a: Admission preview over the WHOLE set — free, deterministic, no model

From the target repo:

```bash
ai-dossier batch compose --issues <resolved set> --base <base_branch> --min-members <min_members> --json > "$TMPDIR/compose.json"
```

(`<base_branch>` is the set's common base, default `main`; an issue declaring a different base cannot share this batch — report it `different-base` and leave it out.) The output (`schema: batch-compose:v1`) is the admission decision, and `model_calls` is always `0`:

- `excluded[]` — cannot join a batch, each with `code` + `message`. These are Step 1's skip table. **Never dispatch a classifier for them**, never post anything on them.
- `members[]` — the proposed composition, each with `review: light|full`, `source: pick|backfill`, `review_reasons`. A text-floor keyword hit (risk-floor area or deploy pipeline), a plan:v1 risk-floor path, or a plan:v1 predicting > 8 files (prescreen:v4 `verdict: candidate` + `review: full`) is a `review=full` member, not an exclusion — #770 Option A, #805, #818.
- `backfill[]` — ranked admissible backlog candidates (`rank`, `review`, `shared_packages`, `selected`). Compose already pulled the top-ranked ones into `members[]` when picks fell below `min_members`.
- `status` — `ok` (≥ `min_members`), `under-min` (2 ≤ n < `min_members`), `no-batch` (< 2); `recommendation` says the same in one line.

Compose honours the ≤ 2 `review=full` cap (`--max-full-review`, default from the sched config's `max_full_review_members`) and the ≤ 6 member ceiling; picks it could not fit land in `held[]` with the reason.

#### Step 3b: Body-readiness screen on every admitted member — free, and mandatory for backfill (#802)

Compose's admissibility is not readiness. On imboard, `--backlog` backfill proposed five features/trackers with no stopping point out of six (ai-dossier#802). Until compose scores readiness itself, **the orchestrator** (you — no dispatch) reads each admitted member's body and applies the Step 5 readiness screen:

- **Acceptance present** — an Acceptance / Requirements / AC section or checklist. None, on an `enhancement`/feature → drop `not-ready:no-ac`.
- **Not a tracker** — a punch list, triage/audit roll-up, "N findings", or a task list of many independent items → drop `not-ready:tracker`.
- **Not an initiative/feature-by-shape** — "Part of #epic" with open-ended scope, "after N weeks post a comment", multi-surface rollouts → drop `not-ready:initiative`.
- **Hard exclusions compose cannot see** (below, Step 5) — production data mutation or production ops (SSM/secret writes, DNS, third-party console configuration, prod DB writes), a slice of a designed sequence already represented, a decision → drop with that reason.
- Named-artifact existence and assigned/shipped checks — Step 5's four readiness checks.

Every drop is reported with its reason. **Backfill after a drop:** walk `backfill[]` in `rank` order, skipping already-selected and already-dropped candidates, and admit the next one that (a) keeps the batch within ≤ 2 `review=full` — a `review=full` candidate is skipped while the cap is full — and (b) passes this same screen. Stop at `min_members`, or when the ranked list is exhausted. Prefer bounded bugs/chores/refactors when two candidates are close in rank.

This screen is cheap by design — reading a body, not probing the repo. The decision-grade pass in 3c repeats the readiness judgment with more depth; 3b exists so that pass is never paid for an issue a one-minute read rejects.

#### Step 3c: Decision-grade classify — admitted members ONLY, to set `tier` and confirm `review`

1. **Reuse**: if an issue's LATEST runstate milestone is `phase=classify status=done`, take the verdict from that record — do not re-classify (re-posting would bury the trail). A reused record without a `review` key (pre-#783 classifier) takes `review` from compose's member entry.
2. Otherwise dispatch **one agent per admitted member on a decision-grade model**, passing `--submitted-set <admitted members>` context (bounded: at most 8
   concurrent). **Do NOT use the cheapest tier here.** What this step decides is the RFC-0001
   E.2 risk floor — auth, payments, migrations, security, architecture — and the `tier` every
   downstream member inherits. Running the risk *judgment* on the cheapest model while its
   answer selects the model that does the *work* is inverted: the decision is where capability
   is worth paying for, not the typing.

   This is not a hypothetical. A full backlog sweep classified 7 of 111 issues as `slot`, and
   the supervisor pre-registered that only ONE was truly implementable — the other six carried
   readiness blockers the classifier could not see. The standing diagnosis is that the
   classifier *"finds 'small', not 'ready'"*. That is a judgment failure, not a throughput one.

   **Dispatch this step on `fable`** (`--model fable`, verified to resolve to `claude-fable-5-1`).
   It is the model to reach for where a major product or technical decision is due, where the
   change is architectural, or where risk is elevated — which is exactly this step, and is a
   different axis from `ModelTier`. Tier grades how hard something is to WRITE; this grades how
   consequential it is to DECIDE. The two do not have to agree, and here they actively disagree:
   the cheapest tier was deciding the risk floor.

   The same rule applies wherever a phase is separately dispatched and its output is a JUDGMENT
   rather than an implementation — batch composition (Step 5), and the aggregate review in
   `imboard-ai/git/batch-integrate`. It does NOT apply to member implementation, where the
   member's own `tier` governs.

   Record which model produced each verdict: the weekly scorecard buckets by model x repo x
   tier from the run rows, so this change measures itself once it runs.
3. Collect each verdict from `ai-dossier runstate last --issue <n> --json`: `mode`, `risk`, `est_files`, `est_diff`, `areas`, `test_scope`, `deps`, `confidence`, `review`.
4. **Reconcile with the admission**:
   - `review` is the MAX of compose's and the classifier's — the classifier may raise `light` → `full`, never lower a compose `full` (uncertainty raises review, never lowers it).
   - `mode=full` from the classifier (a MODE floor rule — rules 2, 3, 6–10: e.g. hard rollback, visual/browser review, confidence < 0.6 after escalation; rules 1, 4 and 5 only raise `review`) → the member **leaves the batch**; report it `classifier-full (<rules>)` and hand it to full-cycle (Step 5). Then backfill ONE replacement per Step 3b and classify only that replacement.
   - If raised `review` values push the batch above 2 `review=full`, keep the picks, drop the lowest-ranked `review=full` backfill, and backfill a `review=light` candidate per Step 3b.
5. A classifier `blocked` record (e.g. `unreadable-issue`) drops the issue — reported as skipped. One failed dispatch is retried once; a persistent failure skips that issue, never the whole run.

### Step 4: Ensure a plan:v1 Artifact on Every Issue (#462)

1. `ai-dossier plan get --issue <n>` per remaining issue; exit 0 → an artifact exists, keep it (validate-and-refine belongs to plan-issue / member-cycle, not here).
2. Missing → author a **light** artifact and post it:
   - **Problem** — 1-2 sentences from the issue body
   - **Acceptance Criteria** — verbatim from the issue's requirements/AC checkboxes; else the minimal testable set
   - **Predicted Files** — best effort from the issue text and the classifier's inspection; ground named paths with quick probes (`git grep -l "<module>"`, `ls <path>`); empty only when the issue names nothing and no path is inferable
   - **Approach** — 2-4 bullets from the issue's own scope/approach text
   - **Test Scope** — from the classify record's `test_scope`
3. Post with `ai-dossier plan post --issue <n> --file <md>`; write the scratch markdown under `$TMPDIR` (batch-prep owns no worktree, so nothing may dirty a tree).

### Step 5: Compose Batches (RFC-0001 E.4)

**Review depth is not batch eligibility (#770 P1, operator decision Option A).** `mode` answers "how much process does this issue need?"; sharing one CI run needs only a shared base, independent revert granularity (per-issue commits, rebase-merge, never squash — already guaranteed) and no data mutation. A risk-floor issue — auth, billing/payments, security, migrations-by-keyword — a deploy-pipeline change (E.2 rule 4) and a change predicting > 8 files (E.2 rule 5, #818) need *deeper review*, not *their own CI run*. So:

- **A risk-floor, deploy-pipeline or > 8-file issue (E.2 rules 1, 4, 5) is a `review=full` slot member, not an exclusion.** It dispatches at `strong` tier minimum (sched enforces it at dispatch), runs full-cycle-grade review in member-cycle (all review agents, security included), and batch-integrate runs the risk-floor review over its commits.
- **At most 2 `review=full` members per batch** — bounds deploy blast radius (one deploy carries several risky changes). `sched enqueue` rejects a manifest that exceeds `max_full_review_members`.
- **Hard exclusions** — the only things that genuinely cannot share a PR:
  1. production data mutation or production ops (data migrations/backfills, prod DB writes, secret/SSM writes, DNS, third-party console configuration);
  2. a slice of a designed sequence (PR1/PR2/PR3 of one feature) — never two in one batch;
  3. decisions, epics, trackers (and research/parked items);
  4. a different base branch.
  Excluded issues are reported with the reason and **not** enqueued. Separately, a classifier `mode=full` (a MODE floor — rules 2, 3, 6–10, visual/browser review among them: the batch gate has no browser stage) hands the issue to full-cycle (below). Rules 4 (deploy pipeline) and 5 (> 8 files) are NOT on either list since #818 — they raise `review`.

Split the admitted, classified set:

- `mode=full` members (Step 3c item 4) and every hard exclusion leave the batch. They are **not** turned into full-mode queue entries by this dossier — a batch run never silently converts into N PRs. Report each as `hand to full-cycle: #N (<reason>)`; the caller (batch-cycle-skill) or the operator takes it through `full-cycle-issue-skill` deliberately.
- Issues with an **open dependency outside the submitted set** (compose excludes them as `open-dependency`; a classifier floor rule 9 hit is the same fact) are **deferred**: not enqueued — an out-of-graph dep stays permanently unsatisfied in the queue (enqueue semantics), so enqueueing them would strand them blocked forever. Report as `deferred-external-dep`; re-run prep once the dep merges. **Deferral is transitive**: an issue whose open in-set dependency is deferred is itself deferred (reported as `deferred-external-dep` with the chain) — enqueueing it would strand it on a dep that never enters the queue.
- The remaining `mode=slot` members — `review=light` and `review=full` alike — are packed into batches.

**Minimum viable batch + backfill (#770 P4).** A batch below `min_members` (default 3) amortizes almost nothing — history before this rule: mean 2.2 members, three single-member batches. After Step 3b/3c backfill:

- **≥ `min_members` survivors** → form the batch.
- **2 ≤ survivors < `min_members`** (the ranked backfill list was exhausted) → form the batch and say it is under-min, and why backfill ran dry.
- **Fewer than 2 survivors** → **do NOT form a batch.** Create no anchor, enqueue nothing, claim nothing. Report `no batch formed — hand #N to full-cycle` (or "nothing admissible"). A one-member batch pays the prep overhead and amortizes nothing.

**Readiness screen — judge from the BODY, not the labels.** A survey of 118 open issues in a
real backlog yielded 11 batchable, and **almost nothing was excluded for being too big**: ~53
features/epics, 11 assigned or in progress, 8 decisions, 7 CI-machinery, 6 trackers, 3
data-mutation. Size is not the constraint; readiness is. Four cheap deterministic checks, all
against the issue body:

- **Does every artifact the body names exist on the base branch?** An issue saying "migrate onto
  the helper extracted by #N" depends on #N whether or not it says "depends on". Verify the named
  symbol or file exists; do not trust the prose. This is the single highest-yield check.
- **Does the body enumerate a countable work list?** Count it. A "documentation" issue naming
  eight resource families is not small.
- **Is it assigned, in progress, or already shipped?** An issue whose work merged under another
  number is live bait — check for commits referencing it before batching it.
- **Is it a tracker or a decision?** A body listing many independent findings gives an agent no
  stopping point; one headed "Decision needed" with an options table is not implementable.

Drop what fails and say why. A dropped issue costs nothing; a member forcing work against a
missing dependency costs an agent run and a share of the batch's verification cycle.

**Hard constraints — ALL must hold for every batch:**

1. Same `base_branch`
2. Every member's external deps satisfied: merged, or a member of an **earlier** batch (never a later one). A dep on an issue this run handed to full-cycle or excluded is not in the queue — defer the dependent member (`deferred-external-dep`).
3. **≤ 6 members** (raise further only on measured evidence). Measured across three batch
   executions: 1.9-3.3x wall-clock saving at N=3 versus **3.3-5.7x at N=6**, with the shared
   verification growing only ~15% while the batch doubled, and a member break rate of 2 in 6.
   Member count is not the binding constraint — deploy blast radius and the capacity of the
   repo's shared test infrastructure are.
4. **Combined predicted diff is a REVIEW bound, not a cost bound.** Diff size predicts neither
   cost nor conflict: measured members have run 92 turns for a net −29 lines and 59 turns for
   +193, and a 6,289-line combined batch merged cleanly. Cap it only so the aggregate review
   stays tractable, and say that is what the cap is for.
5. **≤ 1 eviction group.** Members do NOT share a worktree — each works in its own worktree off
   the integration branch and sees no one else's changes until the parent merges (RFC-0001
   §J.3). Overlapping members are therefore permitted but will conflict at integration, which
   the parent resolves. Two shapes must be kept apart:
   - **Slices of one designed sequence** (PR1/PR2/PR3 of a feature) are not independent and
     conflict by construction — never place two in the same batch.
   - **Members sharing a structural landmark** — the same component, registry or list — form an
     eviction group even when their predicted file sets are disjoint. The only conflict observed
     in 14 members was three members each anchoring an addition to the same component, one of
     which relocated it; predicted-path intersection would have cleared that cohort.
6. No two members with `risk=med`+ touching the same area
7. **≤ 2 `review=full` members** (`max_full_review_members`; `sched enqueue` rejects more). Two `review=full` members touching the same risk area also violate constraint 6.

**Packing (deterministic first-fit):** walk slot issues in topological order. For each, first-fit into the earliest existing batch with the same `base_branch` that still satisfies all seven constraints with the candidate added — prefer file-disjoint placement; an overlapping candidate may join only if it creates no second overlap cluster and all its slot-mode deps are members of this batch or of earlier batches (a candidate must never land in a batch earlier than a batch holding its dependency — that would create a backward batch edge). No batch fits → open a new batch. Intra-batch deps stay intra-batch: member order encodes them.

**Prefer MIXED cohorts.** A batch's value is a function of the union of its members' affected scopes, not of member count. A cohort whose members all avoid the repo's expensive verification stage amortizes almost nothing — one measured batch of six frontend/docs members resolved to 3 of 9 workspaces and never triggered the expensive stage at all. Once ONE member triggers it, every further member rides along at nearly no additional gate cost. Compose so at least one member touches the expensive surface.

**Member order within a batch:** dependency order → ascending risk (safest first — evicting a late risky member never invalidates early safe ones) → issue number.

**Batch ids — idempotent reuse:** before minting a new id, check open `batch-epic` anchors (`gh issue list --label batch-epic --state open --json number,title,body`) for one whose body's ordered member task list (`- [ ] #N ...`) exactly matches this batch's computed members, with the same `base_branch`. A match means this run recomputed a batch an earlier (partial or crashed) prep run already anchored — reuse that anchor's `batch_id` (parsed from its title, `Batch <batch_id>: ...`) and issue number; Step 6 creates nothing for this batch. No match → mint fresh: `b-<YYYYMMDD>-<NN>` — bump NN until the id appears neither in `sched status --json` nor among open `batch-epic` anchors.

**Batch-level DAG:** an edge B1 → B2 (B1 merges first) whenever any member edge crosses the two batches — derived from member edges, never invented. A member dep on a full-mode entry already in the queue (enqueued by an earlier run or by hand) gates through that entry's queue dep (kept in the member's manifest `deps`).

### Step 6: Create the Anchor Issues

For batches Step 5 matched to an existing anchor, skip creation entirely — record that anchor's issue number for the output and the audit file and move on. For every other batch:

1. Idempotently create the label:

   ```bash
   gh label create "batch-epic" --color "5319E7" --description "Batch anchor — members share one lifecycle (RFC-0001)" --force
   ```

2. One anchor per batch — title `Batch <batch_id>: #a, #b, #c`, label `batch-epic`, body:
   - task list of members **in execution order**: `- [ ] #N <title> — risk=<r> review=<light|full> est_files=<n> est_diff=<n>` (plus `source=backfill` on backfilled members)
   - `base_branch: <base_branch>` — read back by Step 5's idempotent-reuse match on future runs
   - the eviction group (or "none")
   - batch-level dependencies (or "none")
   - the audit-file path
   - under `dry_run`: a line stating members are NOT enqueued
3. Record anchor numbers for the output and the audit file.

### Step 7: Write the Audit File (fleet-cycle convention)

- Project slug: `gh repo view --json owner,name -q '.owner.login + "-" + .name'`; on failure, basename of `git rev-parse --show-toplevel`.
- `mkdir -p ~/.dossier/logs/batch-prep/<project>`; write `BATCH-PLAN-<UTC YYYYMMDD-HHMMSS>.md` capturing: the resolved set; every skipped issue with its reason; the dependency edges with justification (explicit vs inferred); the `batch compose` output (admitted / excluded with codes / backfill candidates considered); every Step 3b readiness drop with its signal; the classify verdict table (admitted members only — record which model produced each); each batch (id, base, members in order, per-member risk/est/review/source pick|backfill, eviction group, batch deps, anchor #); the issues handed to full-cycle with their reasons; the deferred issues; anchor links; the manifest path.
- `gzip -f` it in place (artifact on disk: `BATCH-PLAN-<ts>.md.gz`). Retention: keep the 20 most recent `BATCH-PLAN-*.md.gz` in that directory, delete older.

### Step 8: Emit the Manifest and Enqueue

1. Final skip-check against `ai-dossier sched status --json` — drop issues that became active queue entries since Step 1 (report).
2. Write the manifest (schema below) to `~/.dossier/logs/batch-prep/<project>/manifest-<ts>.json` (plain JSON — machine-consumed):
   - this dossier emits **slot members only** — issues handed to full-cycle (Step 5) are reported, never enqueued as full-mode entries. The schema's `mode: "full"` rows exist for hand-written manifests.
   - slot members: `{issue, mode: "slot", batch: <batch_id>, anchor: <anchor_issue_number>, review: "light"|"full", deps, tier, base_branch, dispatch?}` — `review` is emitted on **every** member (Step 3c item 4's reconciled value; at most 2 `full` per batch) — deps list only OPEN deps **outside this member's own batch** (same-batch deps are encoded in member order); `anchor` is the batch's anchor issue number from Step 6, emitted on **every** member of the batch (not just the first) — the final skip-check in item 1 below can drop any individual member, and only emitting `anchor` on one entry risks losing the binding if that entry is the one dropped
   - when `dispatch_profile` is supplied, add `dispatch: <dispatch_profile>` to **every slot member** and pass `--dispatch <dispatch_profile>` to the enqueue command.
   - tier: docs/test/chore-only areas + `risk=low` → `mechanical`; `risk=high` → `strong`; otherwise `mid`. A `review=full` member dispatches at `strong` minimum regardless (sched applies the floor at dispatch) — still write the tier the risk maps to.
  Note this mapping is only as good as the `risk` verdict feeding it — which is why Step 3 must not
  be run on the cheapest model.

    Zero entries after skips/deferrals → do NOT invoke `sched enqueue` (it rejects an empty manifest); report the run as a no-op with the audit file.

3. **Claim every enqueued member at manifest time (batch members only).** The readiness screen in Step 1 READS the `in-progress` claim marker; this step WRITES it — at the moment the run commits the members to the queue, so the forming window (selection → dispatch, which can trail by hours) is never unprotected. For every slot member being enqueued, in the same pass, immediately BEFORE item 4:

   ```bash
   gh label create "in-progress" --color "FBCA04" --description "Actively being worked on" --force
   gh issue edit <n> --add-label "in-progress"
   gh issue comment <n> --body "**Batch claim** — selected into batch <batch_id> (anchor #<anchor>)"
   ```

   - **No `--add-assignee "@me"`** — `@me` does not translate to a batch: there is no single agent behind it. The honest marker is the label plus the pickup comment naming the batch id, so a human tracing a claim reaches the batch rather than guessing at a member.
   - **Issues handed to full-cycle are NOT claimed here** — a pickup comment naming a batch id is meaningless without a batch, and full-cycle claims its issue itself at pickup (its Phase 1 Step 2). The claim here covers slot members only.
   - **`dry_run=true` → nothing is claimed** — nothing is enqueued, so nothing is spoken for.
   - **If item 4's enqueue fails**, it is atomic (nothing was saved) — RELEASE the claims this item just added before stopping: `gh issue edit <n> --remove-label "in-progress"` plus a one-line release comment naming the batch id and `enqueue-failed`. An EnqueueError must never leave claimed issues with no queue entry behind them.
   - **Never claim by hand outside this step.** Adding `in-progress` to candidates while a prep run is still executing trips the readiness rule (Step 1) against that run's own selections and drops them. The manifest step is the single claim point.

4. Enqueue, from the target repo. When the manifest contains slot members and
   `dispatch_profile` was supplied, pass the same profile explicitly. The flag is
   required, not optional:
    ```bash
    ai-dossier sched enqueue --from-manifest <manifest-path> --dispatch <dispatch_profile>
    ```

   On `EnqueueError` STOP and surface the error plus the manifest path — enqueue is atomic (nothing was saved; release the item-3 claims first); fix the cause (e.g. duplicate active issue) and re-run. Never silently retry with a trimmed manifest.
5. Verify: `ai-dossier sched status` shows the new entries and batches; note the result in the output.
6. `dry_run=true` → items 1-2 run (the manifest is written and reported), items 3-5 (claims, enqueue and verify) are skipped. Everything before Step 8 — classify records, plan artifacts, anchors, audit — is REAL under dry_run; that is the shadow-mode deliverable (RFC-0001 G Step 2).

### Step 9: Output

```
Batch preparation complete: <n> issues in → <b> batches (<m> slot members, <r> review=full) — model_calls in admission: 0; classifiers dispatched: <c>
Skipped:   <issue: reason, ...>
Deferred:  <issue: open external dep #X, ...>
Batches:   <per batch: id, members in order, eviction group, deps, anchor #>
Admission: <batch compose status + recommendation; excluded: issue → code, ...>
Readiness: <Step 3b drops: issue → not-ready:<signal>, ...; backfilled: issue (rank r, review), ...>
Full-cycle: <issues handed to full-cycle → reason, or "none"; "no batch formed" when < 2 survived>
Claims:    <enqueued members claimed at manifest time, or "none (dry-run)">
Manifest:  <path> (enqueued | dry-run — NOT enqueued)
Audit:     ~/.dossier/logs/batch-prep/<project>/BATCH-PLAN-<ts>.md.gz
```

## Stale claims — recovery

A batch that dies between enqueue and dispatch (prep crashed after claiming, the host rebooted, the scheduler queue was wiped) leaves members carrying `in-progress` with nothing behind the claim — the "looks busy but is not" state. The recovery is deterministic — claim provenance plus two checks — not label archaeology:

**Identify.** An issue's claim is STALE when ALL of:

1. It carries the `in-progress` label AND a `**Batch claim**` pickup comment naming batch `<id>` (the claim's provenance — this is why the comment is not optional);
2. `ai-dossier sched status --json` shows NO active (non-terminal) entry for the issue — nothing queued, nothing dispatched for it;
3. Its latest runstate milestone (`ai-dossier runstate last --issue <n> --json`) is still `phase=classify` — no member/slot trail ever started.

(If the batch DID dispatch, the member's trail exists and the claim is live: any disposal — ship, eviction, supersession — releases it. Nothing here applies to a batch that is merely still forming; prep itself claims at enqueue and a forming batch's claims are correct.)

**Clear.** Release the claim and return the issue to the pool:

```bash
gh issue edit <n> --remove-label "in-progress"
gh issue comment <n> --body "Claim released — batch <id> did not reach dispatch (stale-claim recovery); issue returned to the pool"
```

The next prep run over the backlog then re-selects it normally — its readiness screen sees no `in-progress` and a `classify` record it can reuse.

## The Enqueue Manifest Schema

Consumed by `ai-dossier sched enqueue --from-manifest` (#460 — `parseManifest` is the contract). Envelope:

```json
{
  "project": "<owner-repo slug>",
  "entries": [ ... ]
}
```

`project` is informational (the CLI resolves the project from the working directory); a bare entries array is also accepted, but always emit the envelope.

| Field | Type | Rules |
|---|---|---|
| `issue` | positive integer | required; unique among entries; must not be an active queue entry |
| `mode` | `full` \| `slot` | default `full`; `slot` requires `batch`; `full` must omit `batch` |
| `batch` | non-empty string | batch id; all members of a batch share it and one `base_branch`; a batch id only joins while forming |
| `anchor` | positive integer | optional per `parseManifest` — nothing rejects a `mode: "slot"` entry that omits it. **This dossier's Step 8 nonetheless requires emitting it on every member of a batch** (never omitted), because nothing else does: the first entry `enqueue` processes for a new batch seeds the batch's anchor, later members must supply the same value — a conflicting re-supply is rejected (`assertBatchFactsAgree`) — and if no member ever supplies one, the batch's anchor stays `null` forever and dispatch silently skips the batch rather than erroring (see Troubleshooting) |
| `deps` | positive integer[] | open issue numbers this entry waits on; merged deps dropped; same-batch member deps omitted (member order encodes them); no self-deps; no cycles — enqueue rejects the whole manifest |
| `tier` | `mechanical` \| `mid` \| `strong` | default `mid` |
| `base_branch` | non-empty string | branch the unit works from; must match across a batch's members |
| `review` | `light` \| `full` | slot members only (rejected on `mode: full`); default `light`. **This dossier emits it on every member.** `full` ⇒ strong-tier minimum at dispatch, full-cycle-grade review in member-cycle, risk-floor review in batch-integrate; at most `max_full_review_members` (default 2) per batch — enqueue rejects the manifest otherwise |
| `dispatch` | configured profile name | optional; batch-scoped, emit on every slot member when `dispatch_profile` was selected |

Example:

```json
{
  "project": "imboard-ai-ai-dossier",
  "entries": [
    { "issue": 102, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "review": "light", "deps": [], "tier": "mechanical", "base_branch": "main", "dispatch": "zai" },
    { "issue": 103, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "review": "full", "deps": [], "tier": "strong", "base_branch": "main", "dispatch": "zai" },
    { "issue": 104, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "review": "light", "deps": [], "tier": "mid", "base_branch": "main", "dispatch": "zai" }
  ]
}
```

## Pitfalls and Decision Points

| Situation | Decision / why |
|---|---|
| Uncertain whether two issues collide | Add the dependency edge (serialize). False serial < false parallel. |
| Dependency cycle detected | Surface it and STOP the run. |
| Issue in-flight (label or runstate trail) | Skip it — a classify record on an active trail breaks the run's resume. |
| Issue carries `in-progress` from a batch claim | Skip it at Step 1 — that is the claim's read side doing its job; the claim was written by the earlier prep run's Step 8. If the two stale-claim checks (sched status + `classify` trail) prove the batch died before dispatch, release it per "Stale claims — recovery" and re-run. |
| Open dep outside the submitted set | Classify and plan it, but defer enqueue — out-of-graph deps stay permanently unsatisfied in the queue. |
| One overlap cluster would become two | Refuse the candidate — ≤ 1 eviction group per batch, hard. |
| Slot issue depends on an issue this run handed to full-cycle | Defer it (`deferred-external-dep`) — the dep is not in the queue. A dep on a full-mode entry ALREADY in the queue is allowed; the scheduler gates on it. |
| Risk-floor or deploy-pipeline keyword, or a > 8-file plan, on an otherwise-ready issue | `review=full` member, not an exclusion (Option A, #818). Only the four hard exclusions (and a classifier mode floor) keep an issue out. |
| A third `review=full` candidate | Hold it for the next batch; backfill a `review=light` one instead. Never exceed 2 per batch. |
| Fewer than 2 survivors after backfill | No batch: no anchor, no manifest entries, no claims. Report `hand #N to full-cycle`. |
| Backfill candidate is a feature/tracker with no AC | Drop it at Step 3b (`not-ready:<signal>`, ai-dossier#802) and take the next ranked candidate. |
| Re-running compose after plan:v1 artifacts were posted shows a member as `review=full` (path-floor / file-count) or held `review-full-cap`, or reports `prescreen-full` | CLI >= 0.61.0 (prescreen:v4, #805/#818): a plan:v1 risk-floor PATH or > 8 predicted files makes the member `review=full` — not an exclusion — so a member admitted `review=light` may come back `review=full`, and may be held `review-full-cap` if that exceeds the per-batch cap; `prescreen-full` no longer fires under `--rules v2`. Reuse the member's existing classify record rather than treating the re-run as new evidence against an issue already admitted in this run. On an older CLI (prescreen:v2/v3) a path-floor or file-count hit still excluded — upgrade. |
| No slot-eligible issues | Valid outcome — zero batches; report every issue with its reason, and skip `sched enqueue`. |
| Everything skipped/deferred/full | Report honestly; an empty batch plan is not an error — and skip the enqueue call (it rejects a zero-entry manifest). |
| Classifier floor rule hits after reuse of an old classify record | Trust the record — re-classification buries trails; the member-cycle tripwires catch stale verdicts at execution time. |

## Validation

- [ ] Issue set resolved from list/range; `ai-dossier batch compose --json` ran over the WHOLE set before any model dispatch; its `excluded[]` reported as skipped with codes
- [ ] Step 3b body-readiness screen applied to every admitted member (mandatory for backfill); drops reported with their signal; backfill walked `backfill[]` in rank order within the ≤ 2 `review=full` cap
- [ ] Decision-grade classifiers dispatched ONLY for admitted members — zero for excluded or readiness-dropped issues
- [ ] Risk-floor, deploy-pipeline and > 8-file issues (text-floor keyword, plan:v1 risk-floor path or file count — E.2 rules 1, 4, 5) admitted as `review=full` members, not excluded; hard exclusions limited to prod data mutation/ops, designed-sequence slices, decisions/epics/trackers, different base
- [ ] No batch below 2 members formed; a batch below `min_members` formed only after backfill ran dry, and says so
- [ ] DAG built per fleet-cycle Phase 2 rules (explicit authoritative, serialize-when-unsure); cycles surfaced and stopped the run
- [ ] Every admitted member has a classify record (reused or freshly dispatched) and a plan:v1 artifact (existing or light)
- [ ] Every batch satisfies all seven E.4 hard constraints; member order = dependency → ascending risk → issue number; batch-level edges derived from member edges only
- [ ] One `batch-epic` anchor per batch (label created idempotently) with task-list body of members — reused from a matching open anchor when Step 5's idempotency check found one, never duplicated
- [ ] Audit file written and gzipped under `~/.dossier/logs/batch-prep/<project>/` (retention 20), showing the anchor # per batch
- [ ] Manifest written per the schema, with `anchor` and `review` on every slot member of every batch (≤ 2 `review=full` per batch); `sched enqueue --from-manifest` invoked and verified via `sched status` (batch shows a non-null `anchor`) — or explicitly skipped under `dry_run`
- [ ] Every enqueued slot member was claimed at manifest time — `in-progress` label plus a pickup comment naming the batch id, never `--add-assignee "@me"`; issues handed to full-cycle NOT claimed; nothing claimed under `dry_run`; an `EnqueueError` released the claims it had just added
- [ ] Deferred (`deferred-external-dep`) issues were NOT claimed — they never reach Step 8's manifest, and the output/audit show them as deferred, not claimed

## Troubleshooting

| Symptom | Fix |
|---|---|
| `sched` subcommand unknown | CLI < 0.18.0 or a shadow copy — call the global binary by absolute path |
| `EnqueueError: already in the queue` | The issue became active between Step 1 and Step 8 — drop it from the manifest, report, re-run |
| `EnqueueError: dependency cycle` | The queue plus manifest contain a cycle the prep DAG check missed — fix the manifest and re-run |
| `plan post` rejects the file | All five sections are required (Problem, Acceptance Criteria, Predicted Files, Approach, Test Scope) |
| `runstate last` returns a classify record with missing keys | Stale or hand-written record — re-dispatch the classifier for that issue |
| No `sched` state for the project | Fresh project — treat `sched status` as an empty queue and proceed |
| Batch stuck with `anchor: null`, `claimAndSetup`/dispatch refuses it | The manifest's slot entries omitted `anchor` — Step 8 must emit it on every member (#536). Re-enqueue is not possible once a batch left `forming`; fix the manifest for future runs. |
| Issues carry `in-progress` but nothing is in the queue | A batch died between enqueue and dispatch — apply "Stale claims — recovery": confirm no active sched entry and a `classify` trail, then release the label with a recovery comment. Do not hand-add `in-progress` to a forming batch's members — that trips this dossier's own readiness rule. |
