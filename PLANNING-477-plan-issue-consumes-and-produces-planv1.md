# Issue #477: dossier: plan-issue consumes and produces plan:v1 artifacts (validate-and-refine)

## Problem
Full-cycle's plan phase always replans from scratch, even when a plan already exists — triple-planning redundancy (triage → batch-prep → plan-issue). With the plan:v1 artifact CLI merged (#462, PR #480, `9a2cecf`), plan-issue should CONSUME an existing plan artifact when one exists (validate then refine, never recreate — RFC-0001 C.6) and also PRODUCE one after planning, so later runs and batch-prep reuse the rich plan instead of replanning.

## Acceptance Criteria
- [ ] AC1 plan-issue Step 0 (new): `ai-dossier plan get --issue N`; if a plan:v1 artifact exists, run `ai-dossier plan validate` (deterministic) + one model sanity pass against the issue and current HEAD
- [ ] AC2 Valid artifact → refine incrementally into the PLANNING file (carry ACs, predicted files, approach; add only what full-cycle needs: reachability evidence, test strategy, risk areas) — no from-scratch replan
- [ ] AC3 Invalid or absent artifact → today's full planning path, unchanged; the outcome (`plan_reused=true|false|refined`) recorded in the plan milestone
- [ ] AC4 plan-issue also POSTS/updates the plan:v1 artifact after planning (full-cycle becomes a producer too, so later runs and batch-prep can reuse)
- [ ] AC5 ac<n> milestone contract unchanged; published with version bump; `examples/git/` snapshot refreshed

## Approach
1. Edit the registry dossier `imboard-ai/git/plan-issue` 1.6.0 → 1.7.0 via `ai-dossier pull` + local edit (never committed to the repo). New **Step 0: Consume an existing plan artifact** — run `plan get`; absent (exit 1, "No plan:v1 artifact") → `plan_reused=false`, today's path unchanged. Present → `plan validate` + one model sanity pass (ACs still match the issue? Predicted Files plausible against current HEAD? Approach still coherent?). Valid + sane → refine path; any error reason or sanity failure → fresh path with the reason noted.
2. Refine path in Step 5: carry **Problem, Acceptance Criteria, Predicted Files, Approach, Test Scope** verbatim from the artifact; add only the full-cycle-only sections fresh (Reachability Evidence re-verified at current HEAD, Reusable Code, Risk Areas, Open Questions, Visual Review, Base Branch). Never rewrite carried sections — refine means add, not recreate.
3. Align the PLANNING template's section names with the artifact's five canonical sections ("Files to Modify" → "Predicted Files", "Test Strategy" → "Test Scope") so the planning file itself is a postable artifact body — `plan post` checks presence of the five sections, not exclusivity; extra sections ride along (the "rich" artifact per C.6). No other dossier references the old names (verified by grep across `examples/git/*.ds.md` — only the PLANNING file *path* is referenced elsewhere).
4. Extend Step 5b: after commit+push, `ai-dossier plan post --issue N --file <PLANNING file>` (head= stamps the just-pushed wip(plan) sha). On post failure (old CLI shadow copy, gh error): continue the run, record it — the committed planning file remains the phase's durable output; the producer is a nicety, not a gate.
5. Step 7 milestone: existing keys (`planning`, `head`, `open_questions`, `visual_review`, `ac_count`, `ac<n>`) unchanged; add `--kv plan_reused=true|false|refined` — `false` = absent/invalid → fresh path; `true` = carried essentially verbatim (only full-cycle sections added); `refined` = carried content meaningfully amended (ACs adjusted per comments, files corrected against HEAD). CLI accepts the new key (extra keys not in KEY_VALUE_RULES pass through — verified in `cli/src/runstate.ts:368`).
6. Frontmatter: version 1.7.0, `last_updated` 2026-08-29, delete `checksum`/`signature` (signing regenerates). Sign → lint → verify → publish per `imboard-ai/meta/publish-dossier` (namespace `imboard-ai/git`), then refresh `examples/git/plan-issue.ds.md` from the published version and PR.

## Reachability Evidence
- State: "plan-issue refines a valid plan:v1 artifact" | Trigger: a `<!-- plan:v1 -->` comment exists on the issue | Prod check: `node cli/dist/cli.js plan get --issue 462 / 477 --repo imboard-ai/ai-dossier` → "No plan:v1 artifact" on both; **0 artifacts exist today** | Verdict: **reachable by construction** — this change is itself the rich producer (AC4, RFC-0001 C.6: "plan-issue (rich — also posts/updates the comment)"), so the trigger occurs the moment v1.7.0 ships; batch-prep (#469) is the next producer; the issue's own test strategy pre-seeds one artifact for the dry-run. This is a protocol artifact (like runstate milestones at CLI launch), not a user-data state — 0 occurrences today is the expected pre-launch baseline, not an unreachable state.
- State: "fresh-planning path on absent artifact" | Trigger: issue with no plan:v1 comment | Prod check: same queries show 2 of 2 issues artifact-free | Verdict: reachable (the default today).

## Predicted Files
- `examples/git/plan-issue.ds.md` — snapshot refreshed from the published plan-issue 1.7.0 (the repo PR artifact)

(The primary deliverable — the registry dossier `imboard-ai/git/plan-issue` 1.6.0 → 1.7.0 — is NOT a repo file: it is edited via `ai-dossier pull` on a local working copy and published to the registry; never cloned/committed. Working copy: `plan-issue.ds.md` in the worktree root, git-excluded.)

## Reusable Code
- `ai-dossier plan post/get/validate` (CLI 0.16.0, `cli/src/commands/plan.ts`, `cli/src/plan-artifact.ts`) — the entire artifact surface; the dossier only orchestrates it
- `imboard-ai/meta/publish-dossier` — the exact sign → lint → verify → publish → refresh-machines recipe and its known walls (shadow CLI copies, expired login, key location)
- `scripts/refresh-examples-snapshot.mjs` — pulls every published `examples/git/*` dossier over the local snapshot (or a direct copy of the published file for the single-dossier case)

## Risk Areas
- **Publishing blocked from this sandbox**: no `~/.dossier/imboard-ai.pem` on wls, `ai-dossier whoami` = "Not logged in" (login needs a human TTY OAuth flow), ssh to hcc/occ unreachable from here. The edit/lint/dry-runs are local; sign+publish requires hand-off (exact commands) or credentials before the run can complete. Main risk to autonomous completion — hand off per the Guiding Principle at that step.
- Shadow CLI copies: the global `ai-dossier` on wls is 0.14.0 (npm registry lags; latest published is 0.14.0, 0.15/0.16 stranded by the sched E404). All `plan` dry-runs must use the worktree build (`node cli/dist/cli.js`). The dossier itself gets a CLI-version note: if `plan` is missing, degrade to fresh planning, never block on tooling.
- `plan post` refuses bodies > 60000 chars — planning docs are well under; the artifact body includes the extra full-cycle sections (rich artifact per C.6) — presence-check semantics allow extras (verified in `plan-artifact.ts` + format spec).
- Section rename ripple: grep shows no other dossier references "Files to Modify"/"Test Strategy" section names — only the PLANNING file path is referenced (implement-issue, full-cycle-issue, ship-issue). Low risk.
- runstate `plan_reused` key: extra keys pass CLI validation (not in KEY_VALUE_RULES, no whitespace, not a path key) — verified in source.

## Test Scope
- `ai-dossier lint` (must print "no issues found") + `ai-dossier verify` (must print "Verification passed") on the signed file — per publish-dossier Step 3
- Dry-run 1 (with artifact): post #477's own planning doc as its plan:v1 artifact (`plan post` via the worktree CLI), then execute the edited dossier's Step 0 → `plan get` + `plan validate` + sanity → refine path exercised
- Dry-run 2 (without artifact): run Step 0 against an artifact-free issue → `plan get` exit-1 branch → fresh path
- Both dry-runs documented in the PR description (the issue's test strategy)
- `node scripts/refresh-examples-snapshot.mjs` (or direct copy) proves the snapshot matches the published 1.7.0

## Open Questions
- (none — the one operational unknown, publish credentials, is a documented hand-off, not a design question)

## Visual Review
- [x] Not required (dossier/registry/docs only)

## Base Branch
`main` — PRs for this issue target this branch.
