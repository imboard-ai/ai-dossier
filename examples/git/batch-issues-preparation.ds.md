---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "batch-issues-preparation",
  "title": "Batch Issues Preparation — classify, DAG, compose batches, enqueue",
  "version": "1.2.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-01",
  "objective": "Turn a raw issue list/range into classified, dependency-ordered, batched queue entries for the scheduler (RFC-0001 C.3): resolve the set, build the dependency DAG, classify every issue, ensure a plan:v1 artifact on each, compose batches per E.4, create batch-epic anchor issues, write the audit file, and enqueue via sched enqueue --from-manifest",
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
    "hash": "d4dfc4bc7209d40e5cff37cf893752e13a69e487bba69e4eba5254eb4a71ead2"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "e5Zt6frvuUBTYrasOY3JKQe/WCdVdJF4jdmxAC/z5TU9HCyb+0MKUWpJAXRjZL9+Sq+tNOvABdPHMi0xTd3gDA==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-01T22:48:38.791Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Batch Issues Preparation — classify, DAG, compose batches, enqueue

## Objective

The judgment-heavy front door of Batch Cycles (RFC-0001 C.3): turn a raw issue list/range — potentially hundreds — into classified, dependency-ordered, batched queue entries for the deterministic scheduler (`ai-dossier sched`, #460). Everything after the queue is the scheduler's; everything deeper than a light plan is slot-cycle's or full-cycle's.

**Non-responsibilities (RFC-0001 C.3):** execution and supervision (the scheduler's), deep per-issue planning (slot/full cycle's). This dossier never dispatches a cycle, never creates worktrees, branches, or PRs, and never posts batch milestones on anchors — the scheduler owns the batch lifecycle from `batch-setup` onward.

## Prerequisites

- `ai-dossier` CLI >= 0.18.0 (`sched enqueue --from-manifest`, `plan post|get`, `runstate mint|post|last`, the classify vocabulary #461). Beware shadow copies: a repo-local `node_modules/.bin/ai-dossier` can shadow the global install — when a documented command reports `unknown command`, call the newer binary by absolute path.
- GitHub CLI (`gh`) installed and authenticated
- `imboard-ai/git/issue-cycle-classifier` (#465) available in the registry
- Run from the repository that owns the issues — dependency resolution, path grounding, and `sched enqueue`'s project detection run against it

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

### Step 3: Classify Every Issue (parallel mechanical-tier dispatches)

1. **Reuse**: if an issue's LATEST runstate milestone is `phase=classify status=done`, take the verdict from that record — do not re-classify (re-posting would bury the trail).
2. Otherwise dispatch **one mechanical-tier agent per issue** (bounded: at most 8 concurrent — the `mechanical` `ModelTier`, `packages/sched/src/types.ts`, the same value Step 8's manifest `tier` field carries; `--tier` itself is a `sched enqueue` flag and has no meaning on this ad-hoc `ai-dossier run` dispatch, so choose the mechanical-tier agent/model directly at dispatch time — not the vague "cheap-tier" this line used to say before #538, which in practice ran at mid tier, see `docs/reports/batch-pilot-2-execution.md` §4.1), each running exactly `ai-dossier run imboard-ai/git/issue-cycle-classifier` for that one issue, **passing the submitted set in the dispatch context** (e.g. `submitted set: 1,2,5..8`) — the classifier's Step 3 pre-screen translates that into `ai-dossier classify prescreen --submitted-set <selection>` so an open in-set dep (floor rule 9, "outside the submitted set") is exempted rather than forcing `full`. The classifier's own deterministic pre-screen (#538) rejects obvious `full` cases before spending a single mechanical-tier token, and escalates to mid tier only for the rare issue whose classification confidence genuinely needs a repo probe — mechanical tier is now safe as the default dispatch, not just an aspiration. Classification is cheap and safe to parallelize; the classifier posts its own records, labels, and rationale (#465). DAG analysis stays with the orchestrator at the strongest tier (fleet 1b routing: judgment here, mechanical elsewhere).
3. Collect each verdict from `ai-dossier runstate last --issue <n> --json`: `mode`, `risk`, `est_files`, `est_diff`, `areas`, `test_scope`, `deps`, `confidence`.
4. A classifier `blocked` record (e.g. `unreadable-issue`) drops the issue — reported as skipped. One failed dispatch is retried once; a persistent failure skips that issue, never the whole run.

### Step 4: Ensure a plan:v1 Artifact on Every Issue (#462)

1. `ai-dossier plan get --issue <n>` per remaining issue; exit 0 → an artifact exists, keep it (validate-and-refine belongs to plan-issue / slot-cycle, not here).
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

**Hard constraints — ALL must hold for every batch:**

1. Same `base_branch`
2. Every member's external deps satisfied: merged, a full-mode entry in this run, or a member of an **earlier** batch (never a later one)
3. ≤ 4 members (initial cap; raise only with measured eviction rate < 10%)
4. Σ `est_diff` ≤ 1,200 predicted lines
5. ≤ 1 eviction group: members with overlapping predicted paths MAY share a batch deliberately (they see each other's changes in the shared worktree — this eliminates cross-PR merge conflicts) but form an **eviction group**; a batch may contain at most one overlapping cluster
6. No two members with `risk=med`+ touching the same area

**Packing (deterministic first-fit):** walk slot issues in topological order. For each, first-fit into the earliest existing batch with the same `base_branch` that still satisfies all six constraints with the candidate added — prefer file-disjoint placement; an overlapping candidate may join only if it creates no second overlap cluster and all its slot-mode deps are members of this batch or of earlier batches (a candidate must never land in a batch earlier than a batch holding its dependency — that would create a backward batch edge). No batch fits → open a new batch. Intra-batch deps stay intra-batch: member order encodes them.

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
   - slot members: `{issue, mode: "slot", batch: <batch_id>, anchor: <anchor_issue_number>, deps, tier, base_branch}` — deps list only OPEN deps **outside this member's own batch** (same-batch deps are encoded in member order); `anchor` is the batch's anchor issue number from Step 6, emitted on **every** member of the batch (not just the first) — the final skip-check in item 1 below can drop any individual member, and only emitting `anchor` on one entry risks losing the binding if that entry is the one dropped
   - tier: docs/test/chore-only areas + `risk=low` → `mechanical`; `risk=high` → `strong`; otherwise `mid`

   Zero entries after skips/deferrals → do NOT invoke `sched enqueue` (it rejects an empty manifest); report the run as a no-op with the audit file.

3. Enqueue, from the target repo:
   ```bash
   ai-dossier sched enqueue --from-manifest <manifest-path>
   ```

   On `EnqueueError` STOP and surface the error plus the manifest path — enqueue is atomic (nothing was saved); fix the cause (e.g. duplicate active issue) and re-run. Never silently retry with a trimmed manifest.
4. Verify: `ai-dossier sched status` shows the new entries and batches; note the result in the output.
5. `dry_run=true` → items 1-2 run (the manifest is written and reported), items 3-4 (enqueue and verify) are skipped. Everything before Step 8 — classify records, plan artifacts, anchors, audit — is REAL under dry_run; that is the shadow-mode deliverable (RFC-0001 G Step 2).

### Step 9: Output

```
Batch preparation complete: <n> issues in → <b> batches (<m> slot members) + <f> full-mode entries
Skipped:   <issue: reason, ...>
Deferred:  <issue: open external dep #X, ...>
Batches:   <per batch: id, members in order, eviction group, deps, anchor #>
Full-mode: <issue → tier, ...>
Manifest:  <path> (enqueued | dry-run — NOT enqueued)
Audit:     ~/.dossier/logs/batch-prep/<project>/BATCH-PLAN-<ts>.md.gz
```

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

Example:

```json
{
  "project": "imboard-ai-ai-dossier",
  "entries": [
    { "issue": 101, "mode": "full", "deps": [], "tier": "mid", "base_branch": "main" },
    { "issue": 102, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "deps": [101], "tier": "mechanical", "base_branch": "main" },
    { "issue": 103, "mode": "slot", "batch": "b-20260829-01", "anchor": 100, "deps": [], "tier": "mechanical", "base_branch": "main" }
  ]
}
```

## Pitfalls and Decision Points

| Situation | Decision / why |
|---|---|
| Uncertain whether two issues collide | Add the dependency edge (serialize). False serial < false parallel. |
| Dependency cycle detected | Surface it and STOP the run. |
| Issue in-flight (label or runstate trail) | Skip it — a classify record on an active trail breaks the run's resume. |
| Open dep outside the submitted set | Classify and plan it, but defer enqueue — out-of-graph deps stay permanently unsatisfied in the queue. |
| One overlap cluster would become two | Refuse the candidate — ≤ 1 eviction group per batch, hard. |
| Slot issue depends on a full-mode entry | Allowed — the member entry carries the dep; the scheduler gates on that entry's completion. |
| No slot-eligible issues | Valid outcome — manifest carries full-mode entries only, zero batches. |
| Everything skipped/deferred/full | Report honestly; an empty batch plan is not an error — and skip the enqueue call (it rejects a zero-entry manifest). |
| Classifier floor rule hits after reuse of an old classify record | Trust the record — re-classification buries trails; the slot-cycle tripwires catch stale verdicts at execution time. |

## Validation

- [ ] Issue set resolved from list/range; closed/missing/in-flight/not-implementable/already-queued issues reported as skipped
- [ ] DAG built per fleet-cycle Phase 2 rules (explicit authoritative, serialize-when-unsure); cycles surfaced and stopped the run
- [ ] Every retained issue has a classify record (reused or freshly dispatched) and a plan:v1 artifact (existing or light)
- [ ] Every batch satisfies all six E.4 hard constraints; member order = dependency → ascending risk → issue number; batch-level edges derived from member edges only
- [ ] One `batch-epic` anchor per batch (label created idempotently) with task-list body of members — reused from a matching open anchor when Step 5's idempotency check found one, never duplicated
- [ ] Audit file written and gzipped under `~/.dossier/logs/batch-prep/<project>/` (retention 20), showing the anchor # per batch
- [ ] Manifest written per the schema, with `anchor` on every slot member of every batch; `sched enqueue --from-manifest` invoked and verified via `sched status` (batch shows a non-null `anchor`) — or explicitly skipped under `dry_run`

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
