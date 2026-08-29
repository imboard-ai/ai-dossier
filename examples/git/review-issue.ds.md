---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Review Issue — Parallel Code Review",
  "version": "1.11.1",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2026-08-26",
  "objective": "Run a tiered set of report-only review agents (DRY, Security, Supportability, Maintainability, Documentation, Convention/Contract, Conformance) on the branch diff, then dedupe their findings and apply the fixes serially",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "review",
    "security",
    "code-quality"
  ],
  "risk_level": "medium",
  "requires_approval": false,
  "risk_factors": [
    "modifies_files"
  ],
  "inputs": {
    "required": [],
    "optional": [
      {
        "name": "issue_number",
        "description": "GitHub issue number the review belongs to; required to post the runstate milestone",
        "type": "number"
      },
      {
        "name": "run_id",
        "description": "Runstate run id minted by gate-issue; pass through unchanged",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "review-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "0763a1550f1e8cdb83d3b9b80b74433264ba61aba374aba6ebbd4dccbbfc7d27"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "qWUlKTdjwPXP1kUyUDBkXA/7bUb4A0O6iqd4M/AuKuoHb/3fAwYXUAoJ9uzWc3KICiLRZ8d5HqWV53tIVV1YBg==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-26T10:41:18.651Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Review Issue — Parallel Code Review

## Objective

Run a tier-appropriate set of focused review agents in parallel on the branch diff. Each agent reviews from a different quality dimension and **reports** findings — it does not edit. After all agents complete, this phase dedupes their findings and applies the fixes itself, serially, then re-runs tests and lint once.

## Prerequisites

- You are in the correct worktree/directory for this issue
- The branch has changes to review (`git diff <base_branch>...HEAD --name-only`, plus any uncommitted `git diff --name-only`)
- The codebase builds and tests pass before this phase begins

## Actions to Perform

### Step 1: Confirm Working Directory

Run `pwd` to confirm you are in the worktree. If not, `cd` back into it.

### Step 2: Get Changed Files

```bash
git diff --name-only
```

Review the FULL branch diff: `git diff <base_branch>...HEAD --name-only` plus any uncommitted `git diff --name-only` (by protocol implement already synced to origin, so the tree is typically clean — an empty uncommitted diff alone means nothing). Only if BOTH are empty: stop and report "No changes to review."

### Step 2b: Fetch Acceptance Criteria (for Agent 7)

```bash
gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->") and (contains("phase=plan")))] | last // empty'
```

Parse the `ac<n>=` lines from that milestone (written verbatim, spaces included — see plan-issue's runstate milestone; match case-insensitively, since milestones from runs before CLI 0.10.0 wrote `AC<n>=`). This is the Acceptance Criteria list Agent 7 verifies against. If no such milestone exists or it has zero `ac<n>=` lines (e.g. a refactor/infra issue where plan-issue judged AC not applicable), skip Agent 7 entirely and report `ac_total=0`.

### Step 2c: Select the Review Agents (risk floor, then relevance)

Not every diff earns seven agents — and not every dimension applies to every diff. Two stages, from `git diff <base_branch>... --stat` plus Step 2's changed-file list:

**Stage 1 — risk floor.** Any changed path touching a sensitive area (auth, payment/billing, migrations, `.github/**`, security, crypto, secrets, infra/terraform) → tier `full`, **all 7 agents**, regardless of size. Stop here.

**Stage 2 — relevance selection.** Otherwise, Conformance ALWAYS runs (it is the trust anchor; it drops out only when Step 2b found no AC list), and each other agent runs only if its trigger fires:

| Agent | Runs only if the diff… |
|---|---|
| Documentation | touches `*.md`/`docs/`, a README'd surface, or changes public/user-visible behavior |
| Security | touches input handling, subprocess/shell execution, network calls, auth, secrets, deps/lockfiles |
| DRY | adds > 30 lines of code |
| Maintainability | changes > 30 lines or > 2 files of code |
| Supportability | touches error paths, logging, retries, or adds an operation someone will run/debug |
| Convention/Contract | changes a public API, schema, CLI flag, or cross-package contract |

Name the tier by the resulting set: **micro** (Conformance only — typical for a ≤20-line single-file tweak with no triggers), **docs** (Conformance + Documentation), **small** (2–3 agents), **full** (all 7). A trigger you are unsure about fires — uncertainty selects the agent, it never deselects it.

State the selection and why in one line before launching, e.g. `Tier: micro (1 file, 9 lines, shell — security trigger fired? no: no input/exec change) — running conformance only`. `agents_done`/`agents_pending` list only the selected agents; the milestone carries `tier=micro|docs|small|full`.

### Step 2d: Duration Sanity Floor

A review that finishes implausibly fast was not performed: full tier < 5 minutes, small tier < 2 minutes (docs and micro tiers have no floor). If the floor is violated, the review is INVALID regardless of its findings — redo the review once at the strongest available tier; record `review_redone=true` in the milestone. (imboard#3692)

### Step 3: Run the Tier's Review Agents in Parallel

Launch the tier's agents simultaneously using the Agent tool, each receiving the changed-files list and operating independently. Agents outside the tier do not run at all — do not launch them "just in case". **All review agents are report-only**: they return findings and never touch the working tree; Step 4 applies the fixes.

**Do NOT pass a `name:` parameter to any of these Agent calls.** Naming an agent puts it on the named-teammate/mailbox delivery path — the agent still runs and finishes normally, but its final report is delivered to a mailbox instead of returned as this call's tool_result, and a review-phase runner (itself usually a dispatched subagent) has no inbox-read tool to retrieve it. The observed failure mode is a run that waits 30+ minutes for review agents that already finished minutes ago, with nothing to show for it. Issue all of this step's Agent calls unnamed, in a single batch (one assistant turn, multiple tool calls) — each then runs concurrently and returns its findings directly as a normal tool_result, which is what Step 4 consumes. Confirmed via RCA on two independent full-cycle-issue runs (imboard-monorepo issues #3723, #3762 — 2026-08-25/26): all 7 named teammates completed in 2–7 minutes each time, but zero results ever reached the spawning run.

---

#### Classification Criteria (applies to ALL review agents)

Every review agent must classify each finding as follows:

- **Fix now** (default): the finding this phase will apply in Step 4. Bugs, wrong text, missing
  validation, bad names, missing error handling, code duplication, doc inaccuracies, type
  improvements, refactoring — all of them. If you can write the fix, it is "Fix now"; write it
  into the finding as the proposed fix rather than editing the file. No exceptions for severity
  or scope — minor and major findings alike get applied.
- **Escalate**: ONLY for findings where ALL three of these are true:
  (a) The fix would change user-facing behavior or public API semantics
  (b) You cannot fully verify the fix with existing tests
  (c) It requires a product/business decision (e.g., "should we deprecate this?",
      "is this a breaking change we accept?")
  If any of (a), (b), (c) is false, it is "Fix now", not "Escalate".

**Never escalate**: code quality, documentation gaps, refactoring suggestions, type
improvements, minor bugs, "consider doing X" opinions. Report them as "Fix now" or skip them.

> Most PRs should have zero escalated issues. If you are escalating more than 2 total across all agents, re-evaluate each finding against the three-part test.

> **What escalating costs**: an escalated finding does not spin off a side issue — it stops the entire full-cycle run and hands the original issue back to a human as `decision-pending` (see full-cycle-issue's Guiding Principle). That cost is why the three-part test is strict.

#### Reporting contract (appended to EVERY agent prompt below)

> **Report only — do NOT edit any file.** Return a findings list; one entry per finding:
> `file:line`, what is wrong, the proposed fix (concrete enough to apply), and the
> Fix-now/Escalate classification per the Classification Criteria above.
> If none found, report "No <DRY violations | security issues | supportability issues | maintainability issues | documentation issues | documented conventions to enforce> found." (Agent 7 returns the per-AC verdict list instead.)

---

#### Agent 1: DRY Review

> Review the branch changes for DRY (Don't Repeat Yourself) violations — AI agents frequently rewrite code that already exists in the codebase. For each changed file:
> 1. Read the file fully
> 2. Search the **entire codebase** for existing functions, utilities, or patterns that do the same thing
> 3. Flag duplicated logic (>5 similar lines), reimplemented helpers, or missed utility reuse
> 4. Check if anything was reimplemented that is available in project dependencies
>
> [+ Reporting contract]

#### Agent 2: Security Review

> Review the uncommitted changes for security vulnerabilities. Check every changed file for:
> - Injection (SQL, command, template, path traversal)
> - XSS (unescaped user input in HTML/JSX/templates)
> - Auth/authz gaps
> - Hardcoded secrets, API keys, tokens
> - Insecure patterns, unsafe deserialization
> - Missing input validation at system boundaries
> - OWASP Top 10
>
> [+ Reporting contract]

#### Agent 3: Supportability Review

> Review the uncommitted changes for supportability — can someone debug and operate this code in production? Check every changed file for:
> - Error messages: Are they actionable? Do they include context (what failed, what was expected)?
> - Logging: Are key operations logged? Can you trace a request through the system?
> - Error handling: Are errors caught with useful context, or do they bubble as cryptic stack traces?
> - Failure modes: What happens when external calls fail? Is there graceful degradation?
>
> [+ Reporting contract]

#### Agent 4: Maintainability Review

> Review the uncommitted changes for maintainability — will the next developer understand and safely modify this code? Check every changed file for:
> - Unclear or misleading names
> - Functions >50 lines or deeply nested (>3 levels)
> - Magic numbers/strings without named constants
> - Tight coupling that blocks testing or reuse
> - Missing TypeScript types (any, implicit any)
> - Dead code, unused imports, unreachable branches
> - Leftover console.log / debugger statements
> - TODO/FIXME/HACK without issue references
>
> [+ Reporting contract]

#### Agent 5: Documentation Review

> Review the uncommitted changes for documentation gaps and inaccuracies. Check:
> 1. **README**: Does it still accurately describe the project? Are new features/commands/options documented?
> 2. **Doc files** (docs/, *.md): Are any now outdated or incorrect because of the code changes?
> 3. **Code comments**: Are existing comments still accurate? Are complex new sections missing explanations?
> 4. **API surface**: If public APIs changed, are type definitions / JSDoc / OpenAPI specs updated?
> 5. **Examples**: Do code examples in docs still work?
>
> [+ Reporting contract]

#### Agent 6: Convention / Contract Enforcement

> Review the uncommitted changes for violations of the project's cross-cutting contracts and conventions — the rules that are easy to break from memory and that a generic linter will not catch. Enforce them on the touched code.
>
> 1. Read the project's convention sources: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and anything under `docs/architecture/` or `docs/conventions/`.
> 2. For each changed file, check it against those documented contracts. Common classes: API request/response envelopes consumed through the shared helper (not ad-hoc destructuring of response bodies); data-access conventions (where indexes are declared, reference-field shape); shared error/response wrappers; module-boundary and naming rules the project documents.
> 3. Flag any touched code that bypasses a documented contract, citing the convention source (file + rule).
> 4. **New backend route without an integration test.** If the diff added or modified a route under `packages/backend/src/api/v1/registry/routes/`, run the route-coverage mapper (`pnpm --filter imboard_be test:route-coverage`) and check whether any route in the diff is reported as uncovered. A new uncovered route is a contract violation — this is an agents-driven repo, so an agent-authored route MUST land with its integration test, not a human-authored follow-up. Flag it as a finding. (If this project has no such routes/mapper, skip this check.)
>
> A contract violation is verifiable and is not a product decision — classify it "Fix now" per the Classification Criteria (for an uncovered route, the proposed fix is the integration test under `tests/integration/`). If the project documents no such conventions, report "No documented conventions to enforce."
>
> [+ Reporting contract]

#### Agent 7: Conformance (blind)

Run this agent on the strongest available model — it is the run's trust anchor.

> You are verifying that the change does what the issue asked. You did NOT write this code. Your ONLY inputs are: (1) the issue body and comments — `gh issue view <N> --json title,body,comments`; (2) the diff — `git diff <base_branch>...HEAD` plus `git diff` for uncommitted changes; (3) this Acceptance Criteria list: <paste the `ac<n>=` lines fetched in Step 2b>. Do NOT read the planning document or any other agent's output.
>
> For each AC report exactly one of: `met <file:line>`, `not-met <why>`, `unverifiable <what test would prove it>`. `met` without a file:line citation is invalid — report it as `unverifiable`.
>
> **Report only — do NOT edit any file.** Return the per-AC verdict list; Step 4 acts on it.

### Step 4: After All Agents Complete — Dedupe, Then Apply Serially

The agents reported; you apply. **You are the only writer in this worktree** — parallel writers produce duplicate helpers that ship uncalled (ai-dossier#447).

1. **Collect** every finding from the tier's agents into one list.
2. **Dedupe** before touching anything:
   - Same `file:line`, or the same root cause reported from two angles → ONE finding.
   - Two agents proposing different fixes for one problem → pick the better fix, apply only that one, and note in the summary which was chosen and why.
   - A finding whose proposed fix is already implied by another finding's fix → drop it.
3. **Apply all "Fix now" findings yourself, serially** — one at a time, with the Edit tool, in the deduped list's order; these can be non-trivial (refactors, error handling, historic lint issues in touched files). Do not re-dispatch an agent to apply its own finding.
4. **Route Agent 7's conformance results**:
   - Any `not-met` → return to implement for ONE bounded fix loop scoped to that AC, then re-run Agent 7 ONLY (not the other 6). A second `not-met` on the same AC after that fix loop → escalate (counts toward `review_escalated`, reason "spec not met after one fix loop").
   - `unverifiable` → add the test Agent 7 named, then mark the AC met.
5. **Re-run tests ONCE**, after all fixes are applied — not per fix. If a fix breaks tests, revert that specific fix and reclassify as Escalate, then re-run.
6. **Run the lint auto-fixer ONCE**, after the tests pass — biome: `npx biome check --write .`; eslint: `npx eslint --fix .`; ruff: `ruff check --fix .`; or the project's own `lint:fix` script (check package.json / Makefile).
7. **Sync to origin** (WIP sync rule — see full-cycle-issue's Runstate Milestones): if there are changes (`git status --porcelain` non-empty), `git add -A && git commit -m "wip(review): apply review fixes [skip ci]" && git push`. Do this whether the phase is about to post `status=done` or `status=partial` — push before posting the milestone either way.

   Keep the `[skip ci]` here — it is what stops each in-run push from firing a full CI suite. But be aware this is the LAST wip commit before the PR opens, so it is the one that most often ends up as the PR head, and a skip marker on a PR head suppresses the `pull_request` event entirely (zero CI runs, silently). Clearing it is ship-issue's job, not this phase's: **do not** drop `[skip ci]` from this commit, and **do** make sure ship-issue Step 2.5 (CI-trigger gate) runs — it is the blocking check that has to print `CI-TRIGGER-OK` before `gh pr create`.

### Step 5: Output

Report the review results:

```
Review complete.
Tier: <docs|small|full> — <one-line reason>
Fixed: <count> deduped findings from <agent_count> agents
Escalated: <count> findings (see details below)
Clean: <list of agents with no findings>

Acceptance Criteria: <ac_met>/<ac_total> met
- AC1 <criterion> — met <file:line> | not-met <why> | unverifiable <what test would prove it>
- AC2 <criterion> — met <file:line> | not-met <why> | unverifiable <what test would prove it>

[If escalated items exist:]
Escalated findings:
- [Agent]: <description> — Reason: <why all three escalation criteria apply>
```

### Step 6: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — if review aborts, post `--status blocked --kv reason=<short-slug>` instead and stop. Use `--status partial` when any of the tier's agents did not finish. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
ai-dossier runstate post --issue <issue_number> --phase review --status done --run <run_id> \
  --kv head=<short sha of HEAD> \
  --kv fixed=<n> \
  --kv escalated=<n> \
  --kv tier=docs|small|full \
  --kv agents_done=<comma list of the tier's agents that finished> \
  --kv agents_pending=<comma list or none> \
  --kv ac_met=<n> \
  --kv ac_total=<n> \
  --kv review_redone=<true|false>
```

Let the CLI stamp `at=` and compute `next=ship` — do not pass either; never hand-write the comment. `agents_done`/`agents_pending` cover only the tier's agent set (Step 2c), not all 7. `head=` is the pushed sha from Step 4 item 7 (`git rev-parse --short HEAD` after the push, or current `HEAD` if there was nothing to commit). `review_redone=` is optional — pass it only when Step 2d's duration floor triggered a redo.

## Output

- `review_tier`: `docs` | `small` | `full` — which agent set ran, and why (Step 2c)
- `review_fixed`: number of deduped findings applied
- `review_escalated`: number of findings escalated to the user (ideally 0)
- `review_clean`: list of agent names that found no issues
- `ac_met` / `ac_total`: acceptance criteria met vs. total (0/0 when Agent 7 was skipped — no AC list found)
- `ac_results`: the per-AC checklist (criterion, verdict, file:line or reason) from Agent 7 — pass through to ship-issue for the PR body's Acceptance Criteria section
- Posts runstate milestone to the issue (`phase=review`, including `tier` and `ac_met`/`ac_total`)

## Validation

- [ ] Working directory confirmed; changed files obtained via `git diff --name-only`
- [ ] Acceptance Criteria fetched from the last `phase=plan` milestone (Step 2b) before launching Agent 7
- [ ] Tier computed and stated in one line before launching (Step 2c); any sensitive path forced `full`
- [ ] Duration sanity floor checked (Step 2d): full ≥5 min, small ≥2 min, docs no floor; a violation triggered one redo at the strongest tier with `review_redone=true`
- [ ] Agent 7 (Conformance) ran on the strongest available model
- [ ] Exactly the tier's agents were launched in parallel (Agent 7 skipped only when no AC list was found)
- [ ] Every agent was report-only — no agent edited a file — and classified findings using the Classification Criteria
- [ ] Findings deduped (same file:line / same root cause collapsed; competing fixes resolved to one), then all "Fix now" findings applied serially by this phase via the Edit tool
- [ ] A new/changed backend registry route in the diff was checked against the route-coverage mapper; any uncovered route was flagged (and its integration test added)
- [ ] Every `not-met` AC went through one bounded fix loop + a re-run of Agent 7 alone; a second `not-met` on the same AC was escalated
- [ ] Every `unverifiable` AC got the named test added, then was marked met
- [ ] `met` citations without a `file:line` were treated as `unverifiable`, not accepted
- [ ] Tests re-run once after all fixes (no regressions); lint auto-fixer run once, after the tests passed
- [ ] Escalated findings (if any) each satisfy all three escalation criteria, and no more than 2 were escalated total (re-evaluated if exceeded)
- [ ] Final output includes the tier and counts for fixed, escalated, clean, and `ac_met`/`ac_total`
- [ ] Any changes were committed and pushed to origin (`wip(review): ...`) before the milestone — on `done` and `partial` alike — and milestone `head=` is the pushed sha
- [ ] Runstate milestone was posted via `ai-dossier runstate post`, including `tier=`

## Troubleshooting

| Symptom | Fix |
|---|---|
| No uncommitted changes | Verify you are in the correct directory and that implementation completed before running review. |
| Two agents "fixed" the same thing and the codebase now has two helpers | The failure report-only prevents (ai-dossier#447). Agents must not edit; if one did, revert its edits and re-apply from the deduped list yourself. |
| Agent finds issues in files not in the diff | Out of scope — skip unless directly impacted by the changes (e.g. a caller of a changed function). |
| Fix breaks tests | Revert that fix (`git checkout -- <file>`, re-apply the others) and reclassify it as Escalate, explaining the test failure. |
| Too many escalated findings | If more than 2, re-read each against the three-part test. Most findings that feel like escalations are "Fix now" — code quality, naming, missing validation and documentation gaps are always fixed directly. |
| Lint auto-fixer introduces changes | Expected. Skim the auto-fix diff to ensure nothing was mangled, then proceed. |
| Review agents "running" for 30+ minutes with no findings | You (or a prior run) passed `name:` to the Agent tool in Step 3 — that routes to the mailbox path, not a returned tool_result. Do not wait it out. If you still have context on this run, redispatch the pending agents WITHOUT `name:`, in one batch. If you cannot re-dispatch (e.g. you are a fresh resumed run with no handle on the stuck agents), perform the review yourself across the pending tier's dimensions and record `review_substituted=dispatch-nonresponsive` in the milestone rather than blocking further. |
