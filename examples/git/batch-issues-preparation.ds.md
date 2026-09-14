---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "batch-issues-preparation",
  "title": "Batch Issues Preparation — classify, DAG, compose batches, enqueue",
  "version": "2.4.1",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-12",
  "objective": "Turn a raw issue list/range into classified, dependency-ordered, batched queue entries for the scheduler (RFC-0001 C.3): resolve the set, build the dependency DAG, classify every issue, ensure a plan:v1 artifact on each, compose batches per E.4, create batch-epic anchor issues, write the audit file, claim every enqueued member at manifest time, and enqueue via sched enqueue --from-manifest",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "batch-cycles",
    "classification",
    "scheduling",
    "runstate"
  ],
  "risk_level": "medium",
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates batch-epic anchor issues and applies labels in the target repo",
    "Posts classify records, rationale comments, and plan:v1 artifacts on prepared issues",
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
        "description": "Produce everything (classify records, plan artifacts, anchor issues, audit file, manifest) but do NOT invoke sched enqueue — the shadow-mode deliverable (RFC-0001 G Step 2): backlogs get classified and planned while execution stays untouched.",
        "type": "boolean",
        "default": false
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
    "hash": "096ffa268f8fc3995d8708c4d0c5e442a87d35e92564a54d0c1990b8d9e9e7a2"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "o0DQfrx8JUtD75g3WvUkFGxRAt/rssBwPJaSRvZ7GNhJ59/89Xl+E/jGusaEOfa5w5zX4zFyT8cM0BIMEDtfBw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-12T02:15:04.035Z",
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

- `ai-dossier` CLI >= 0.18.0 (`sched enqueue --from-manifest`, `plan post|get`, `runstate mint|post|last`, the classify vocabulary #461). Beware shadow copies: a repo-local `node_modules/.bin/ai-dossier` can shadow the global install — when a documented command reports `unknown command`, call the newer binary by absolute path.
- GitHub CLI (`gh`) installed and authenticated
- `imboard-ai/git/issue-cycle-classifier` (#465) available in the registry
- Run from the repository that owns the issues — dependency resolution, path grounding, and `sched enqueue`'s project detection run against it

If `dispatch_profile` is supplied, first read `ai-dossier sched status --json` and
verify that it is an exact key in `dispatch.profiles`. Do not infer or silently
fall back to another profile. The value is a batch-level fact, not a per-issue
classification choice.

## Actions to Perform

### Step 1: Resolve the Issue Set (fleet-cycle Phase 1 semantics)

1. Parse `issues` into a concrete list of integers — explicit list `1,2,3` → `[1,2,3]`; range `1..9` → `[1..9]`; mixed `1,2,5..8` → `[1,2,5,6,7,8]`. De-duplicate and sort ascending.
2. For each issue, fetch state, title, body, labels, and comments (`gh issue view <n> --json ...`).
3. Drop issues that cannot be prepared — and REPORT every one with its reason (never silently omit):
   - **closed** or **non-existent** (fleet Phase 1 rule)
   - label `epic`, `batch-epic`, `decomposed`, or `needs-clarification` — not implementable as a unit
   - **in-flight or parked**: label `in-progress` or `decision-pending`, OR its latest runstate milestone (`ai-dossier runstate last --issue <n> --json`) is any phase other than `classify`. A classify record landing on an active run's trail breaks its resume — gate-issue reads the LAST milestone and would treat the run as fresh.
   - already an **active entry** in the scheduler queue (`ai-dossier sched status --json`; entries in terminal states may be re-prepared; a missing sched state is an empty queue)

The skipped table goes in the output AND the audit file: issue, reason.

### Step 2: Build the Dependency DAG (fleet-cycle Phase 2 rules; one deliberate divergence — see the file-overlap bullet)

For every pair of remaining issues, determine whether one must merge **before** the other. **When uncertain, prefer adding a dependency edge (serialize) over assuming independence** — a false parallel is far more expensive than a false serial.

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

### Step 3: Classify Every Issue (parallel dispatches, on a DECISION-grade model)

1. **Reuse**: if an issue's LATEST runstate milestone is `phase=classify status=done`, take the verdict from that record — do not re-classify (re-posting would bury the trail).
2. Otherwise dispatch **one agent per issue on a decision-grade model** (bounded: at most 8
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
3. Collect each verdict from `ai-dossier runstate last --issue <n> --json`: `mode`, `risk`, `est_files`, `est_diff`, `areas`, `test_scope`, `deps`, `confidence`.
4. A classifier `blocked` record (e.g. `unreadable-issue`) drops the issue — reported as skipped. One failed dispatch is retried once; a persistent failure skips that issue, never the whole run.

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

Split the classified set:

- `mode=full` issues are **never batched** — they become full-mode queue entries.
- Issues with an **open dependency outside the submitted set** (classifier floor rule 9 has already forced them full) are **deferred**: classified and planned, but NOT enqueued — an out-of-graph dep stays permanently unsatisfied in the queue (enqueue semantics), so enqueueing them would strand them blocked forever. Report as `deferred-external-dep`; re-run prep once the dep merges. **Deferral is transitive**: an issue whose open in-set dependency is deferred is itself deferred (reported as `deferred-external-dep` with the chain) — enqueueing it would strand it on a dep that never enters the queue.
- The remaining `mode=slot` issues are packed into batches.

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
2. Every member's external deps satisfied: merged, a full-mode entry in this run, or a member of an **earlier** batch (never a later one)
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

**Packing (deterministic first-fit):** walk slot issues in topological order. For each, first-fit into the earliest existing batch with the same `base_branch` that still satisfies all six constraints with the candidate added — prefer file-disjoint placement; an overlapping candidate may join only if it creates no second overlap cluster and all its slot-mode deps are members of this batch or of earlier batches (a candidate must never land in a batch earlier than a batch holding its dependency — that would create a backward batch edge). No batch fits → open a new batch. Intra-batch deps stay intra-batch: member order encodes them.

**Prefer MIXED cohorts.** A batch's value is a function of the union of its members' affected scopes, not of member count. A cohort whose members all avoid the repo's expensive verification stage amortizes almost nothing — one measured batch of six frontend/docs members resolved to 3 of 9 workspaces and never triggered the expensive stage at all. Once ONE member triggers it, every further member rides along at nearly no additional gate cost. Compose so at least one member touches the expensive surface.

**Member order within a batch:** dependency order → ascending risk (safest first — evicting a late risky member never invalidates early safe ones) → issue number.

**Batch ids — idempotent reuse:** before minting a new id, check open `batch-epic` anchors (`gh issue list --label batch-epic --state open --json number,title,body`) for one whose body's ordered member task list (`- [ ] #N ...`) exactly matches this batch's computed members, with the same `base_branch`. A match means this run recomputed a batch an earlier (partial or crashed) prep run already anchored — reuse that anchor's `batch_id` (parsed from its title, `Batch <batch_id>: ...`) and issue number; Step 6 creates nothing for this batch. No match → mint fresh: `b-<YYYYMMDD>-<NN>` — bump NN until the id appears neither in `sched status --json` nor among open `batch-epic` anchors.

**Batch-level DAG:** an edge B1 → B2 (B1 merges first) whenever any member edge crosses the two batches — derived from member edges, never invented. A member dep on a full-mode entry gates through that entry's queue dep (kept in the member's manifest `deps`).

### Step 6: Create the Anchor Issues

For batches Step 5 matched to an existing anchor, skip creation entirely — record that anchor's issue number for the output and the audit file and move on. For every other batch:

1. Idempotently create the label:

   ```bash
   gh label create "batch-epic" --color "5319E7" --description "Batch anchor — members share one lifecycle (RFC-0001)" --force
   ```

2. One anchor per batch — title `Batch <batch_id>: #a, #b, #c`, label `batch-epic`, body:
   - task list of members **in execution order**: `- [ ] #N <title> — risk=<r> est_files=<n> est_diff=<n>`
   - `base_branch: <base_branch>` — read back by Step 5's idempotent-reuse match on future runs
   - the eviction group (or "none")
   - batch-level dependencies (or "none")
   - the audit-file path
   - under `dry_run`: a line stating members are NOT enqueued
3. Record anchor numbers for the output and the audit file.

### Step 7: Write the Audit File (fleet-cycle convention)

- Project slug: `gh repo view --json owner,name -q '.owner.login + "-" + .name'`; on failure, basename of `git rev-parse --show-toplevel`.
- `mkdir -p ~/.dossier/logs/batch-prep/<project>`; write `BATCH-PLAN-<UTC YYYYMMDD-HHMMSS>.md` capturing: the resolved set; every skipped issue with its reason; the dependency edges with justification (explicit vs inferred); the classify verdict table; each batch (id, base, members in order, per-member risk/est, eviction group, batch deps, anchor #); the full-mode entries with tiers; the deferred issues; anchor links; the manifest path.
- `gzip -f` it in place (artifact on disk: `BATCH-PLAN-<ts>.md.gz`). Retention: keep the 20 most recent `BATCH-PLAN-*.md.gz` in that directory, delete older.

### Step 8: Emit the Manifest and Enqueue

1. Final skip-check against `ai-dossier sched status --json` — drop issues that became active queue entries since Step 1 (report).
2. Write the manifest (schema below) to `~/.dossier/logs/batch-prep/<project>/manifest-<ts>.json` (plain JSON — machine-consumed):
   - full-mode entries: `{issue, mode: "full", deps, tier, base_branch}` — deps list only OPEN set-internal deps (edges to merged issues were dropped in Step 2)
   - slot members: `{issue, mode: "slot", batch: <batch_id>, anchor: <anchor_issue_number>, deps, tier, base_branch, dispatch?}` — deps list only OPEN deps **outside this member's own batch** (same-batch deps are encoded in member order); `anchor` is the batch's anchor issue number from Step 6, emitted on **every** member of the batch (not just the first) — the final skip-check in item 1 below can drop any individual member, and only emitting `anchor` on one entry risks losing the binding if that entry is the one dropped
   - when `dispatch_profile` is supplied, add `dispatch: <dispatch_profile>` to **every slot member** and pass `--dispatch <dispatch_profile>` to the enqueue command. Full-mode entries omit it because dispatch profiles are batch-scoped.
   - tier: docs/test/chore-only areas + `risk=low` → `mechanical`; `risk=high` → `strong`; otherwise `mid`.
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
   - **Full-mode entries are NOT claimed here** — a pickup comment naming a batch id is meaningless without a batch, and full-cycle claims a full-mode issue itself at pickup (its Phase 1 Step 2). The claim here covers slot members only.
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
Batch preparation complete: <n> issues in → <b> batches (<m> slot members) + <f> full-mode entries
Skipped:   <issue: reason, ...>
Deferred:  <issue: open external dep #X, ...>
Batches:   <per batch: id, members in order, eviction group, deps, anchor #>
Full-mode: <issue → tier, ...>
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
| `dispatch` | configured profile name | optional; batch-scoped, emit on every slot member when `dispatch_profile` was selected |

Example:

```json
{
  "project": "imboard-ai-ai-dossier",
  "entries": [
    { "issue": 101, "mode": "full", "deps": [], "tier": "mid", "base_branch": "main" },
    { "issue": 102, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "deps": [101], "tier": "mechanical", "base_branch": "main", "dispatch": "zai" },
    { "issue": 103, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "deps": [], "tier": "mechanical", "base_branch": "main", "dispatch": "zai" }
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
| Slot issue depends on a full-mode entry | Allowed — the member entry carries the dep; the scheduler gates on that entry's completion. |
| No slot-eligible issues | Valid outcome — manifest carries full-mode entries only, zero batches. |
| Everything skipped/deferred/full | Report honestly; an empty batch plan is not an error — and skip the enqueue call (it rejects a zero-entry manifest). |
| Classifier floor rule hits after reuse of an old classify record | Trust the record — re-classification buries trails; the member-cycle tripwires catch stale verdicts at execution time. |

## Validation

- [ ] Issue set resolved from list/range; closed/missing/in-flight/not-implementable/already-queued issues reported as skipped
- [ ] DAG built per fleet-cycle Phase 2 rules (explicit authoritative, serialize-when-unsure); cycles surfaced and stopped the run
- [ ] Every retained issue has a classify record (reused or freshly dispatched) and a plan:v1 artifact (existing or light)
- [ ] Every batch satisfies all six E.4 hard constraints; member order = dependency → ascending risk → issue number; batch-level edges derived from member edges only
- [ ] One `batch-epic` anchor per batch (label created idempotently) with task-list body of members — reused from a matching open anchor when Step 5's idempotency check found one, never duplicated
- [ ] Audit file written and gzipped under `~/.dossier/logs/batch-prep/<project>/` (retention 20), showing the anchor # per batch
- [ ] Manifest written per the schema, with `anchor` on every slot member of every batch; `sched enqueue --from-manifest` invoked and verified via `sched status` (batch shows a non-null `anchor`) — or explicitly skipped under `dry_run`
- [ ] Every enqueued slot member was claimed at manifest time — `in-progress` label plus a pickup comment naming the batch id, never `--add-assignee "@me"`; full-mode entries NOT claimed; nothing claimed under `dry_run`; an `EnqueueError` released the claims it had just added
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
