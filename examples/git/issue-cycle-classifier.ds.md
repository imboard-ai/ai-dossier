---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "issue-cycle-classifier",
  "title": "Issue Cycle Classifier — Structured Full/Slot Verdict",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-29",
  "objective": "Score one issue for execution mode by inspecting issue metadata and repo signals, applying the RFC-0001 E.2 full-cycle floor and E.3 slot eligibility, and emitting a phase=classify runstate verdict with cycle label and rationale comment",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "classification",
    "batch-cycles",
    "runstate"
  ],
  "risk_level": "low",
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number to classify",
        "type": "number"
      }
    ],
    "optional": [
      {
        "name": "dry_run",
        "description": "Compute and validate the verdict without posting the milestone, applying labels, or commenting (shadow-mode calibration, RFC-0001 E.2 Phase 2). Default false.",
        "type": "boolean"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "content_scope": "references-external",
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "6daa44f001ae094012f5d1286bc8697cb3c4e8a75f80bd0fcc51a30dadea98b6"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "gTCm+7Yak+u82uqMB7zxS33JJeyGViYx8TABeEPkcCiaoexDktgr8mq64BLlRgHSjfDLDvRgKoifZtUaf9GGBQ==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T17:01:01.555Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Issue Cycle Classifier — Structured Full/Slot Verdict

## Objective

Score ONE issue for execution mode (`full` vs `slot`). Inspect issue metadata and repo signals, apply the RFC-0001 Batch Cycles full-cycle floor (E.2) and slot eligibility (E.3), and emit a structured `phase=classify` runstate verdict plus a `cycle:*` label and a short rationale comment. One classification, many consumers: batch-issues-preparation now, triage later.

**Non-responsibilities:** batching (batch-issues-preparation's job — this scores exactly one issue, never composes batches) and execution (dispatching a cycle is the consumer's job).

## Prerequisites

- GitHub CLI (gh) installed and authenticated
- `ai-dossier` CLI >= 0.14.0 (`ai-dossier runstate post --phase classify` vocabulary, ai-dossier#461)
- Run from the repository that owns the issue — path probes and `git grep` run against it
- `ai-dossier whoami` works (not needed for `dry_run`)

## Actions to Perform

### Step 1: Fetch Issue Context

```bash
gh issue view <issue_number> --json state,title,labels,body,comments
```

Read the body AND all comments — clarifications and late requirements change the verdict. If the issue is CLOSED, state that in the rationale and proceed (classification of closed issues is the shadow-mode calibration path — pass `dry_run=true`).

### Step 2: Read the plan:v1 Artifact (if present)

Scan comments for the LAST one opening with `<!-- plan:v1` and extract its `Predicted Files` and `Test Scope` sections. No artifact → note it; predicted files fall back to the Step 3 estimation. Readers take the last plan:v1 comment (append-only, like runstate).

### Step 3: Inspect (RFC-0001 E.1)

Gather, in order of authority:

1. **Labels** — existing risk/type labels carry triage's judgment.
2. **Title/body/comment keywords** — migration, auth, payment, billing, package, workspace, deploy, rollback, visual, browser, depends on, security, crypto, secret, terraform, infra.
3. **Predicted files** — from the plan:v1 artifact when present; otherwise estimate from the issue text and ground each predicted path with a quick probe (`git grep -l "<named module>"`, `ls <path>`) — a predicted path that does not exist and cannot be probed lowers `confidence`.
4. **Path→area mapping** — map predicted paths to areas; the risk-floor areas (Step 4 rule 1) reuse the review-issue Stage 1 list verbatim.
5. **Linked/parent issues** — `Depends on #N` in body/comments; resolve each dependency's state (`gh issue view <N> --json state`) — unresolved ones feed Step 4 rule 9.
6. **History calibration (optional)** — `ai-dossier runstate stats --issue <n>` on similar past issues (same author, area, label) to sanity-check `est_diff`.

Produce the verdict fields:

- `est_files` — predicted number of files (non-negative integer)
- `est_diff` — predicted total diff lines (non-negative integer)
- `areas` — comma-separated lowercase slugs (`cli,docs`)
- `test_scope` — `focused` (predictable, named test files) | `broad` (cross-cutting, needs full suite) | `unknown`
- `deps` — `none` or comma-separated issue numbers
- `risk` — `low` | `med` | `high` (judgment: area sensitivity + blast radius)
- `confidence` — decimal 0–1 in your honest assessment; the E.2 floor compares it to 0.6

### Step 4: Full-Cycle Floor (RFC-0001 E.2 — ANY hit ⇒ `cycle:full`)

Evaluate all ten rules explicitly. **Uncertainty ⇒ full** — a rule you cannot evaluate counts as a hit.

1. **Risk-floor area**: any predicted path touches auth, payment/billing, migrations, `.github/**`, security, crypto, secrets, or infra/terraform (review-issue Stage 1 list, verbatim)
2. **Schema or data migration** anywhere in the predicted change
3. **New package/workspace** created
4. **Deploy-pipeline change** (CI/CD, deploy scripts, release flow)
5. **Predicted files > 8**
6. **Predicted diff > 400 lines**
7. **Hard rollback** — data mutation or published API contract (revert is not clean)
8. **Needs visual/browser review** (UI rendering changes)
9. **Unresolved dependency outside the submitted set** (a `Depends on #N` still open, not batched with this issue)
10. **Classifier confidence < 0.6**

Record the hit/miss outcome of every rule — the rationale comment lists them.

### Step 5: Slot Eligibility (RFC-0001 E.3 — ALL must hold)

`mode=slot` only when every condition holds; otherwise `mode=full`:

- No floor hit (Step 4)
- `test_scope=focused`
- Single area, or a few related files
- Issue text implies a bounded change (bug fix, copy, config, small feature, test addition, docs, refactor-in-place)

### Step 6: Emit the Verdict

`dry_run=true` → run item 3 with `--dry-run` (validates keys and prints the comment body), skip items 1, 4, 5, and stop. Otherwise:

1. **Ensure the labels exist (idempotent)** — run both regardless of verdict:

```bash
gh label create "cycle:full" --color "D93F0B" --description "Classified: full-cycle execution required" --force
gh label create "cycle:slot" --color "0E8A16" --description "Classified: slot-cycle eligible (batchable)" --force
```

2. **Mint a run id** (classify is a standalone pre-cycle record — the cycle it dispatches mints its own):

```bash
RUN_ID=$(ai-dossier runstate mint --issue <issue_number>)
```

3. **Post the milestone** — exactly these keys (the CLI validates every value grammar; `rationale_comment` lives outside the milestone contract):

```bash
ai-dossier runstate post --issue <issue_number> --phase classify --status done --run "$RUN_ID" \
  --kv mode=<full|slot> \
  --kv risk=<low|med|high> \
  --kv est_files=<non-negative integer> \
  --kv est_diff=<non-negative integer> \
  --kv areas=<comma,slugs> \
  --kv test_scope=<focused|broad|unknown> \
  --kv deps=<none|123,456> \
  --kv confidence=<0-1 decimal>
```

4. **Apply the verdict label** — remove the opposite mode's label first (no-op when absent) so a reclassified issue never carries both:

```bash
gh issue edit <issue_number> --remove-label "cycle:<other-mode>" 2>/dev/null || true
gh issue edit <issue_number> --add-label "cycle:<mode>"
```

5. **Post a short rationale comment** — verdict up front, then: the inspection evidence (labels/keywords/plan artifact/path probes/deps), the ten floor rules each with hit/miss, the E.3 conditions, and the est_* numbers with one line on how they were derived. Short means scannable — a list, not prose.

On an unreadable issue (missing, no access), post `--phase classify --status blocked --run "$RUN_ID" --kv reason=unreadable-issue` instead and stop.

### Step 7: Output

```
Classified #<issue_number>: mode=<full|slot> risk=<r> est_files=<n> est_diff=<n>
areas=<slugs> test_scope=<t> deps=<d> confidence=<c>
Floor hits: <rule numbers, or none>  Label: cycle:<mode> applied (or dry-run)
```

## Output

- `mode`: `full` | `slot`
- `risk`: `low` | `med` | `high`
- `est_files` / `est_diff`: predicted counts (non-negative integers)
- `areas`: comma-separated slugs; `test_scope`: `focused` | `broad` | `unknown`
- `deps`: `none` or issue numbers; `confidence`: 0–1 decimal
- Posted: `phase=classify` runstate milestone, `cycle:<mode>` label, rationale comment (all skipped under `dry_run`)

## Validation

- [ ] Issue body AND comments read; plan:v1 artifact consumed when present
- [ ] All ten E.2 floor rules explicitly evaluated, each listed hit/miss in the rationale
- [ ] Uncertainty resolved to `full`
- [ ] Milestone carries exactly the eight classify keys and passed CLI validation
- [ ] `cycle:<mode>` label created (idempotent) and applied — or `dry_run` skipped both
- [ ] Rationale comment posted (or `dry_run` skipped it)
- [ ] No batching logic ran — one issue in, one verdict out

## Troubleshooting

| Symptom | Fix |
|---|---|
| `runstate post` rejects `--phase classify` | CLI older than 0.14.0 — upgrade (`npm i -g @ai-dossier/cli`); use the global binary by absolute path if a repo-local `node_modules/.bin` shadow exists |
| `est_diff`/`est_files` rejected | Must be non-negative integers — no ranges, no "about", no `+`/`k` suffixes |
| `confidence` rejected | Decimal between 0 and 1 (`0.85`), not a percentage |
| No plan:v1 artifact | Expected — estimate predicted files from issue text and probe with `git grep`/`ls`; lower `confidence` when paths cannot be grounded |
| Closed issue | Use `dry_run=true` — posting classify records onto completed trails pollutes the resume history |
