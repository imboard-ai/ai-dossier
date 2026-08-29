# Issue #465: dossier: issue-cycle-classifier — structured full/slot verdict

## Problem

RFC-0001 Batch Cycles (`rfcs/0001-batch-cycles.md`, currently on branch `docs/batch-cycles-rfc`, sections C.2/E) needs a shared classifier component that scores ONE issue for execution mode (`full` vs `slot`). It is consumed by `batch-issues-preparation` (#469, open) and later by triage — one classification, many consumers. The runstate vocabulary it emits was already shipped in #461 (CLI 0.15.0: `phase=classify` with `mode/risk/est_files/est_diff/areas/test_scope/deps/confidence`). This issue authors the dossier itself and publishes it to `imboard-ai/git/`. Dossier content is NOT committed to this repo; the repo-side PR artifact is the `examples/git/` snapshot refresh.

## Acceptance Criteria

- [ ] AC1 Dossier inspects: labels, title/body/comment keywords, plan:v1 artifact if present (predicted files), quick path probes; emits `phase=classify` runstate record (keys per #461) + applies `cycle:full`/`cycle:slot` label + posts a short rationale comment
- [ ] AC2 Full-cycle floor implemented exactly per RFC-0001 E.2 (risk-floor areas, migrations, new package, deploy changes, >8 predicted files, >400 predicted diff lines, hard rollback, visual review, unresolved external dependency, confidence < 0.6); uncertainty resolves to `full`
- [ ] AC3 Slot eligibility per RFC-0001 E.3; every verdict carries `confidence=` and `est_*` keys so misclassification is measurable later
- [ ] AC4 Dry-run: classify ≥5 real closed issues; predicted vs actual (files touched, diff size) recorded in the PR description
- [ ] AC5 `examples/git/` snapshot refreshed; labels `cycle:full`/`cycle:slot` created in target repos as part of the dossier's own steps (idempotent `gh label create --force`)

## Approach

1. Author `issue-cycle-classifier.ds.md` (outside the repo tree, in `/tmp`-staged authoring dir) modeled on the family shape of `gate-issue.ds.md`: frontmatter (`name`, `version 1.0.0`, `protocol_version 1.0`, `status Draft`, objective, category/tags, `risk_level low`, `risk_factors [network_access, modifies_files]`, inputs: required `issue_number`; optional `dry_run`) + terse imperative body.
2. Body structure: Objective → Prerequisites (gh, ai-dossier ≥0.15.0 for classify vocabulary) → Inputs → Actions: Step 1 fetch issue + all comments + labels; Step 2 read plan:v1 artifact if present (last `<!-- plan:v1 ... -->` comment, Predicted Files section); Step 3 inspect per RFC E.1 (labels, keywords, predicted files or model estimate + `git grep` path probes, path→area mapping reusing review-issue Stage 1 risk-floor list verbatim, linked/parent issues, `runstate stats` history); Step 4 apply E.2 full-cycle floor (any hit ⇒ full; uncertainty ⇒ full); Step 5 apply E.3 slot eligibility (all of: no floor hit, `test_scope=focused`, single area or few related files, bounded-change text); Step 6 emit: `ai-dossier runstate mint` + `runstate post --phase classify` with all 8 keys, idempotent `gh label create cycle:full/cycle:slot --force`, apply verdict label, short rationale comment (the runstate CLI contract keeps `rationale_comment` outside the milestone); Step 7 output block; Validation checklist; Troubleshooting. Explicit non-responsibility: batching (prep's job).
3. Local quality gates: `ai-dossier lint` clean, `validate` pass, `checksum --update` + `checksum --verify` pass (CI runs `scripts/test-examples.sh` = validate + checksum only — signature NOT required to pass CI).
4. Dry-run (AC4): classify ≥5 recent closed issues (#460, #448, #461, #458, #451, #432 — spread across full-floor hits and slot candidates) by executing the dossier's inspection/floor/eligibility logic; validate each verdict against the CLI grammar with `runstate post --dry-run` (no pollution of closed-issue trails); compare predicted `est_files`/`est_diff`/`mode` vs actual (files + diff lines from each merged PR); record the table in the PR description.
5. Publish per `imboard-ai/meta/publish-dossier` recipe: sign with `~/.dossier/imboard-ai.pem` → lint → verify → `publish --namespace imboard-ai/git` → refresh machines. **Known blocker on this machine (hcc2): no registry login (OAuth needs a human TTY/browser) and no `~/.dossier/imboard-ai.pem`; SSH to wls/hcc/occ is unavailable.** Mitigation: prepare everything, ship the PR with the checksummed snapshot (passes CI), and hand off the exact sign+publish commands at ship time per the publish recipe's own "hand the exact publish command to the human" path; the weekly `refresh-examples-snapshot` job (or a follow-up commit after publish) swaps the signed published content in.
6. Refresh `examples/git/issue-cycle-classifier.ds.md` snapshot (new file, `checksum --update` applied so `test-examples.sh` passes).

## Reachability Evidence

- State: `phase=classify` runstate records | Trigger: batch-prep (#469) or a human/agent running `imboard-ai/git/issue-cycle-classifier` on an issue | Prod check: N/A | Verdict: N/A — no data-reachable product state
- N/A justification: this repo's artifact is a registry component (a tool invoked like every other `imboard-ai/git/*` dossier), not an application state in a production data store. The `mongodb-prod` prod_data_access binding targets the imboard app, which does not apply to the ai-dossier repo. Demand is documented and sequenced: approved RFC-0001 (epic #474), consumer issue #469 open and depending on this component; the vocabulary it emits (#461) is already shipped and tested in `cli/src/runstate.ts` (`CLASSIFY_SPEC`), and `runstate verify` already handles classify trails (`classify record — full-cycle enters fresh`).

## Files to Modify

- `examples/git/issue-cycle-classifier.ds.md` — NEW: snapshot of the published dossier (repo's only committed artifact; convention per #431/#441)
- `/tmp/opencode/d465/issue-cycle-classifier.ds.md` — authoring copy (signed + published from a machine with credentials; NOT committed)

## Reusable Code

- `cli/src/runstate.ts` — the classify vocabulary contract: `CLASSIFY_SPEC` (8 required keys on done), `KEY_VALUE_RULES` (mode/risk/test_scope enums, est_files/est_diff non-negative ints, confidence 0–1 decimal, areas comma slugs, deps `none`|issue numbers). The dossier must emit exactly these.
- `ai-dossier runstate mint|post|--dry-run|last|stats` — emit machinery; `--dry-run` validates without posting.
- `ai-dossier lint|validate|checksum|sign|verify|publish|info|pull` — authoring pipeline; publish recipe in `imboard-ai/meta/publish-dossier`.
- `examples/git/gate-issue.ds.md` — family template for frontmatter shape + terse body style.
- RFC-0001 C.2/E.1/E.2/E.3 (branch `docs/batch-cycles-rfc`) — the spec to implement verbatim.
- review-issue Stage 1 risk-floor area list (auth, payments/billing, migrations, `.github/**`, security/crypto/secrets, infra/terraform) — reused verbatim per E.1/E.2.

## Risk Areas

- **Publish blocker (hcc2 has no login + no signing key; no SSH to sibling machines)** — the issue's publish step cannot complete from this box. Plan: prepare authored+linted+checksummed file, PR carries the checksummed-unsigned snapshot (CI passes: validate + checksum only), ship-phase hand-off posts the exact sign/lint/verify/publish commands for a machine with credentials (wls). `MERGE_COMMIT`/publish completion then rides the hand-off, mirroring the #460 precedent (`publish-e404-new-scope-package`).
- Lint traps (per publish recipe): external URLs must be declared in `external_references` + `content_scope: references-external` + `network_access` risk factor; `risk_factors` is a strict enum; unquoted heredocs where shell expansion is needed. Keep the URL set to `cli.github.com` like siblings.
- Dry-run honesty: predictions must be derived ONLY from information available pre-implementation (issue text, labels, plan artifacts) — never peek at the merged diff before predicting, or the calibration evidence is worthless.
- Dry-run posting discipline: use `runstate post --dry-run` — real classify posts on closed issues with completed full-cycle trails would pollute the historical record.
- E.2 floor completeness: all ten floor conditions from the issue AC + "uncertainty ⇒ full" must appear; missing one silently sends risky issues to batches.
- Non-goal guard: the dossier scores ONE issue; no batching logic (prep's job), no triage integration.

## Test Strategy

- Dossier quality: `ai-dossier lint` (no issues), `validate` (pass), `checksum --verify` (pass) on the authored file; after snapshot copy, `scripts/test-examples.sh` green (CI parity).
- Dry-run evidence (AC4): ≥5 closed issues classified; each verdict validated against CLI grammar (`runstate post --dry-run` exit 0); predicted-vs-actual table (est_files vs files changed, est_diff vs additions+deletions, predicted mode vs floor-rule outcome) in the PR description.
- Repo regression: `make test` (baseline was green at setup; no package src changes in this PR, so no version bumps needed).

## Open Questions

(none — the publish blocker is an environment constraint with a defined hand-off path, not a design ambiguity)

## Visual Review

- [x] Not required (backend/registry component only)

## Base Branch

`main` — PRs for this issue target this branch.
