---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "issue-cycle-classifier",
  "title": "Issue Cycle Classifier — Structured Full/Slot Verdict",
  "version": "1.1.1",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-01",
  "objective": "Score one issue for execution mode: a deterministic pre-screen rejects obvious full cases before any model call (#538), the remaining candidates run a bounded mechanical-tier pass (issue text + pre-screen facts, no repo exploration) applying the RFC-0001 E.2 full-cycle floor and E.3 slot eligibility, escalating to one mid-tier repo-probing pass only when genuinely uncertain, and emitting a phase=classify runstate verdict with cycle label and rationale comment",
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
    "hash": "372e1c267cc2a173857baf1c625568da3f334dcc21f4637728cf1459e489bd95"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "KMgM2lrP1Fns6nzTLaZWspSjh1N+MT2UOWGun/BPVnmyhX+T+4j4jmCwG/OvN010JI7vjwyUOjm8Ze6idPGyDw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-01T23:10:56.802Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Issue Cycle Classifier — Structured Full/Slot Verdict

## Objective

Score ONE issue for execution mode (`full` vs `slot`). A deterministic pre-screen (#538) rejects obvious full cases before any model call; the rest run a bounded, no-repo-exploration inspection of issue metadata, escalating to one repo-probing pass only when genuinely uncertain. Apply the RFC-0001 Batch Cycles full-cycle floor (E.2) and slot eligibility (E.3), and emit a structured `phase=classify` runstate verdict plus a `cycle:*` label and a short rationale comment. One classification, many consumers: batch-issues-preparation now, triage later.

**Non-responsibilities:** batching (batch-issues-preparation's job — this scores exactly one issue, never composes batches) and execution (dispatching a cycle is the consumer's job).

## Prerequisites

- GitHub CLI (gh) installed and authenticated
- `ai-dossier` CLI >= 0.26.0 (`ai-dossier classify prescreen`, #538; also carries the `--phase classify` runstate vocabulary, ai-dossier#461)
- Run from the repository that owns the issue — only Step 4b's escalated pass touches it (`git grep`, path probes); Step 3's pre-screen and Step 4's bounded inspect never do
- `ai-dossier whoami` works (not needed for `dry_run`)
- **Dispatch tier**: run the WHOLE dossier — Steps 1–3, 4, and 5–8 — at **mechanical tier**. Step 4b's escalated pass is the sole exception and the only part that should ever run at mid tier. Running the whole dossier at mid tier by default is the exact cost this version exists to cut (#538 / `docs/reports/batch-pilot-2-execution.md` §4.1: ~64k tokens/dispatch measured at mid tier before this change, over the same §2.2 15-issue set).

## Actions to Perform

### Step 1: Fetch Issue Context

```bash
gh issue view <issue_number> --json state,title,labels,body,comments
```

Read the body AND all comments — clarifications and late requirements change the verdict. If the issue is CLOSED, state that in the rationale and proceed (classification of closed issues is the shadow-mode calibration path — pass `dry_run=true`).

### Step 2: Read the plan:v1 Artifact (if present)

Scan comments for the LAST one opening with `<!-- plan:v1` and extract its `Predicted Files` and `Test Scope` sections. No artifact → note it; predicted files fall back to the Step 4 estimation. Readers take the last plan:v1 comment (append-only, like runstate).

### Step 3: Deterministic Pre-Screen (#538 — no tokens spent)

Before any model-driven inspection, run the pre-screen — a plain CLI call, no model involved.
Pass `--submitted-set` when the dispatch context supplies one (batch-issues-preparation's Step
3 does, per its dispatch-context bullet) — it exempts open in-set dependencies from rule 9,
same as the classifier's own floor evaluation always intended:

```bash
ai-dossier classify prescreen --issue <issue_number> [--submitted-set <selection>]
```

It returns `{issue, state, verdict, reasons, plan_artifact, degraded, warnings, checked_at}`.
`verdict` is computed from: labels (hard-block only), a title/body/label keyword scan, rule-9
open-dependency resolution (already filtered by `--submitted-set`), and — when a plan:v1
artifact already exists (Step 2) — the path-based risk floor and the >8-files rule. Coverage is
deliberately partial: it catches the OBVIOUS floor hits, not all ten E.2 rules — rule 8
(visual/browser), most of rule 2 (schema/migration beyond the `migration` keyword), rule 7
(hard rollback), rules 5/6 without a plan artifact, and rule 10 always need Step 4 or 4b.

- **`verdict: "full"`** → an obvious floor hit was found. Skip straight to Step 7 and post
  `mode=full` using `reasons` as the rationale — no repo exploration, no further inspection.
  This is what makes the obvious cases cheap. Step 7 item 3's milestone still needs all eight
  keys even though Steps 4–6 never ran — use this deterministic fast-path mapping: `est_files=0
  est_diff=0 areas=unknown test_scope=unknown confidence=1`; `deps=none` unless `reasons`
  contains `open-dependency` entries, in which case list those issue numbers; `risk=high` when
  any reason is `hard-block-label` or `text-floor` (rule1-risk-floor-area), else `risk=med`.
- **`verdict: "candidate"`** → continue to Step 4. `reasons` is empty by construction on this
  path (any hit would have made it `full`) — there is nothing to "carry forward" from it. What
  IS worth carrying forward: when `degraded: false`, every deterministic check ran clean, so
  Step 4 does not need to re-derive the hard-block-label, text-floor, path-floor, file-count, or
  rule-9 checks — spend the bounded budget on what pre-screen cannot see (rules 2/5–8/10). When
  `degraded: true`, read `warnings` — it names exactly which check could not complete (e.g. an
  unresolved dependency lookup, an unreadable plan:v1 comment history) and Step 4 MUST verify
  that specific gap itself (e.g. re-run `gh issue view <N> --json state` for a dependency named
  in a warning) rather than trusting the candidate verdict blindly.
- A total pre-screen failure (`state: null`, `degraded: true`, the `gh` error in `warnings`)
  also comes back `verdict: "candidate"` — a pre-screen that cannot run must never block
  classification, only skip its own cost saving for this one issue. Proceed to Step 4 as if no
  pre-screen ran at all.

### Step 4: Bounded Inspect (RFC-0001 E.1 — issue text + pre-screen facts only)

Mechanical tier, no repo exploration. Gather, in order of authority:

1. **Labels** — existing risk/type labels carry triage's judgment (Step 3 already applied the hard-block subset deterministically; this is about the rest — severity/area labels that inform `risk`/`areas` but never had a `full`/`candidate` verdict of their own).
2. **Title/body/comment keywords not already covered by Step 3** — rule 2 (migration/schema, beyond the bare `migration` keyword Step 3's `TEXT_FLOOR_PATTERNS` already checks), rule 7 (hard rollback: data mutation, published API contract), rule 8 (visual/browser review). Step 3's `reasons` covers rule 1/3/4/9 deterministically on a `candidate` verdict with `degraded: false` — don't re-scan for those.
3. **Predicted files** — from the plan:v1 artifact when present; otherwise estimate from the issue text ALONE. Do not probe (no `git grep`, no `ls`) at this pass — an estimate that cannot be grounded from text alone lowers `confidence` rather than triggering a repo probe.
4. **Path→area mapping** — map predicted paths to areas; the risk-floor areas (Step 5 rule 1) reuse the review-issue Stage 1 list verbatim.
5. **Linked/parent issues** — `Depends on #N` in body/comments. When Step 3 ran with `degraded: false`, rule 9 is already resolved (empty `reasons` means no open out-of-set dependency) — do not re-query. When Step 3's `warnings` named an unresolved dependency, or Step 3 didn't run at all, resolve it yourself: `gh issue view <N> --json state` — unresolved (still) ones feed Step 5 rule 9.
6. **History calibration (optional)** — `ai-dossier runstate stats --issue <n>` on similar past issues (same author, area, label) to sanity-check `est_diff`.

Produce the verdict fields:

- `est_files` — predicted number of files (non-negative integer)
- `est_diff` — predicted total diff lines (non-negative integer)
- `areas` — comma-separated lowercase slugs (`cli,docs`)
- `test_scope` — `focused` (predictable, named test files) | `broad` (cross-cutting, needs full suite) | `unknown`
- `deps` — `none` or comma-separated issue numbers
- `risk` — `low` | `med` | `high` (judgment: area sensitivity + blast radius)
- `confidence` — decimal 0–1 in your honest assessment; the E.2 floor (Step 5 rule 10) compares it to 0.6

### Step 4b: Escalate on Confidence Uncertainty (#538 AC2 — the ONLY path to repo exploration)

This is a DIFFERENT uncertainty than Step 5's floor rules (below), and resolves differently.
If `confidence < 0.6` **because the bounded pass above genuinely could not ground its
estimate** (a predicted path could not be confirmed from issue text, `est_files`/`est_diff`
is a guess, `test_scope` cannot be determined) — do not immediately fall back to `mode=full`
the way an unresolvable Step 5 floor rule does. Instead:

1. Escalate this ONE dispatch to **mid tier**.
2. Re-run Step 4's inspection with repo access this time: `git grep -l "<named module>"`,
   `ls <path>`, reading the actual predicted files. This is the only point in the whole
   dossier where repo exploration happens.
3. Recompute `est_files`/`est_diff`/`areas`/`test_scope`/`confidence` grounded in what you
   found. Continue to Step 5 with these values.

If confidence is STILL `< 0.6` after this one escalated pass, that is now a genuine Step 5
rule 10 floor hit (below) — proceed to `mode=full`, don't escalate a second time.

### Step 5: Full-Cycle Floor (RFC-0001 E.2 — ANY hit ⇒ `cycle:full`)

Evaluate all ten rules explicitly, using Step 4 (or Step 4b's grounded re-pass, when it ran).
**Uncertainty on one of THESE rules ⇒ full** — a floor rule you cannot evaluate counts as a
hit; this is unrelated to Step 4b's confidence escalation, which exists precisely so that
"I can't tell without looking" is answered by one bounded look, not an automatic `full`.

1. **Risk-floor area**: any predicted path touches auth, payment/billing, migrations, `.github/**`, security, crypto, secrets, or infra/terraform (review-issue Stage 1 list, verbatim)
2. **Schema or data migration** anywhere in the predicted change
3. **New package/workspace** created
4. **Deploy-pipeline change** (CI/CD, deploy scripts, release flow)
5. **Predicted files > 8**
6. **Predicted diff > 400 lines**
7. **Hard rollback** — data mutation or published API contract (revert is not clean)
8. **Needs visual/browser review** (UI rendering changes)
9. **Unresolved dependency outside the submitted set** (a `Depends on #N` still open, not batched with this issue)
10. **Classifier confidence < 0.6** (post-Step 4b, if it ran)

Record the hit/miss outcome of every rule — the rationale comment lists them.

### Step 6: Slot Eligibility (RFC-0001 E.3 — ALL must hold)

`mode=slot` only when every condition holds; otherwise `mode=full`:

- No floor hit (Step 5)
- `test_scope=focused`
- Single area, or a few related files
- Issue text implies a bounded change (bug fix, copy, config, small feature, test addition, docs, refactor-in-place)

### Step 7: Emit the Verdict

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

5. **Post a short rationale comment** — verdict up front, then:
   - **Pre-screen-full path** (Step 3 said `full`): just the pre-screen's `reasons` list —
     no floor-rule table, no est_* derivation, because none of that ran. State plainly that
     this was a deterministic pre-screen reject, zero model exploration spent.
   - **Evaluated path** (Step 3 said `candidate`, Steps 4–6 ran): the inspection evidence
     (labels/keywords/plan artifact/deps, and whether Step 4b's escalated pass ran), the ten
     floor rules each with hit/miss, the E.3 conditions, and the est_* numbers with one line
     on how they were derived.
   Short means scannable — a list, not prose.

On an unreadable issue (missing, no access), post `--phase classify --status blocked --run "$RUN_ID" --kv reason=unreadable-issue` instead and stop.

### Step 8: Output

```
Classified #<issue_number>: mode=<full|slot> risk=<r> est_files=<n> est_diff=<n>
areas=<slugs> test_scope=<t> deps=<d> confidence=<c>
Floor hits: <rule numbers, or none>  Label: cycle:<mode> applied (or dry-run)
```

On the pre-screen-full fast path (Step 3), "Floor hits" has no numbered rule to report — print
the pre-screen's `reasons[].check` values instead (e.g. `Floor hits: hard-block-label,
text-floor`).

## Output

- `mode`: `full` | `slot`
- `risk`: `low` | `med` | `high`
- `est_files` / `est_diff`: predicted counts (non-negative integers)
- `areas`: comma-separated slugs; `test_scope`: `focused` | `broad` | `unknown`
- `deps`: `none` or issue numbers; `confidence`: 0–1 decimal
- Posted: `phase=classify` runstate milestone, `cycle:<mode>` label, rationale comment (all skipped under `dry_run`)

## Validation

- [ ] Step 3's pre-screen ran before any model-driven inspection — no Step 4/4b reasoning, and no repo exploration, happened ahead of it
- [ ] `verdict: "full"` from Step 3 skipped straight to Step 7 — no repo exploration, no Step 4/5/6 evaluation, rationale is the pre-screen's `reasons`
- [ ] `verdict: "candidate"` ran Step 4 with NO repo access (`git grep`/`ls`) — only Step 4b's one escalated pass, if triggered, may touch the repo
- [ ] Issue body AND comments read; plan:v1 artifact consumed when present (candidate path only)
- [ ] All ten E.2 floor rules explicitly evaluated, each listed hit/miss in the rationale (candidate path only)
- [ ] A floor rule (Step 5) that cannot be evaluated resolved to `full`; a confidence shortfall (Step 4b) escalated to ONE mid-tier repo-probing pass before resolving to `full`, never immediately
- [ ] Milestone carries exactly the eight classify keys and passed CLI validation
- [ ] `cycle:<mode>` label created (idempotent) and applied — or `dry_run` skipped both
- [ ] Rationale comment posted (or `dry_run` skipped it)
- [ ] No batching logic ran — one issue in, one verdict out

## Troubleshooting

| Symptom | Fix |
|---|---|
| `classify prescreen` — unknown command | CLI older than 0.26.0 — upgrade (`npm i -g @ai-dossier/cli`); use the global binary by absolute path if a repo-local `node_modules/.bin` shadow exists. Do NOT skip Step 3 and go straight to Step 4 — that silently reverts to the pre-#538 unbounded-exploration cost on every issue. |
| `runstate post` rejects `--phase classify` | CLI older than 0.14.0 — upgrade (`npm i -g @ai-dossier/cli`) |
| `est_diff`/`est_files` rejected | Must be non-negative integers — no ranges, no "about", no `+`/`k` suffixes |
| `confidence` rejected | Decimal between 0 and 1 (`0.85`), not a percentage |
| No plan:v1 artifact | Expected — Step 4 estimates predicted files from issue text alone (no probing); if `confidence` ends up `< 0.6` because of it, Step 4b's ONE escalated pass is where `git grep`/`ls` grounding happens, not Step 4 itself |
| Closed issue | Use `dry_run=true` — posting classify records onto completed trails pollutes the resume history |
