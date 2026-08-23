---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Review Issue — Parallel Code Review",
  "version": "1.4.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2026-08-23",
  "objective": "Run 7 parallel review agents (DRY, Security, Supportability, Maintainability, Documentation, Convention/Contract, Conformance) on uncommitted changes, fix findings in-place, and produce a review summary",
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
    "hash": "d782a0099aec77e5a53e8fb2ac206223cc4811e9356daf5267d984f4d9431d18"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "odlTEvB1swo5DSOouU3FNcvhz6QnDY1saLuwwCSr7E8mYR4sfh6ieHvtxlzId9iDcMoKsQwJQu4H8DmDQPH0DA==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T14:03:50.939Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Review Issue — Parallel Code Review

## Objective

Run 7 focused review agents in parallel on uncommitted changes. Each agent reviews from a different quality dimension, fixes what it can, and escalates only what requires human judgment. After all agents complete, consolidate fixes and produce a review summary.

## Prerequisites

- You are in the correct worktree/directory for this issue
- There are uncommitted changes to review (`git diff --name-only` returns files)
- The codebase builds and tests pass before this phase begins

## Actions to Perform

### Step 1: Confirm Working Directory

Run `pwd` to confirm you are in the worktree. If not, `cd` back into it.

### Step 2: Get Changed Files

```bash
git diff --name-only
```

This lists unstaged changes — we have not committed yet. If the list is empty, there is nothing to review. Stop and report "No uncommitted changes to review."

### Step 2b: Fetch Acceptance Criteria (for Agent 7)

```bash
gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->") and (contains("phase=plan")))] | last // empty'
```

Parse the `AC<n>=` lines from that milestone (written verbatim, spaces included — see plan-issue's runstate milestone). This is the Acceptance Criteria list Agent 7 verifies against. If no such milestone exists or it has zero `AC<n>=` lines (e.g. a refactor/infra issue where plan-issue judged AC not applicable), skip Agent 7 entirely and report `ac_total=0`.

### Step 3: Run 7 Review Agents in Parallel

Launch all 7 agents simultaneously using the Agent tool. Each agent receives the changed files list and operates independently.

---

#### Classification Criteria (applies to ALL review agents)

Every review agent must classify each finding as follows:

- **Fix now** (default): Fix it yourself. Bugs, wrong text, missing validation, bad names,
  missing error handling, code duplication, doc inaccuracies, type improvements, refactoring
  — fix them all. If you can write the code, it is "Fix now". No exceptions for severity or
  scope — minor and major findings alike get fixed in-place.
- **Escalate**: ONLY for findings where ALL three of these are true:
  (a) The fix would change user-facing behavior or public API semantics
  (b) You cannot fully verify the fix with existing tests
  (c) It requires a product/business decision (e.g., "should we deprecate this?",
      "is this a breaking change we accept?")
  If any of (a), (b), (c) is false, it is "Fix now", not "Escalate".

**Never escalate**: code quality, documentation gaps, refactoring suggestions, type
improvements, minor bugs, "consider doing X" opinions. Fix them or skip them.

> Most PRs should have zero escalated issues. If you are escalating more than 2 total across all agents, re-evaluate each finding against the three-part test.

> **What escalating costs**: an escalated finding does not spin off a side issue — it
> stops the entire full-cycle run and hands the original issue back to a human as
> `decision-pending` (see full-cycle-issue's Guiding Principle). Weigh that cost before
> escalating; it is exactly why the three-part test is strict.

---

#### Agent 1: DRY Review

> You are reviewing uncommitted changes for DRY (Don't Repeat Yourself) violations.
> AI agents frequently rewrite code that already exists in the codebase — your job is to catch this.
>
> For each changed file:
> 1. Read the file fully
> 2. Search the **entire codebase** for existing functions, utilities, or patterns that do the same thing
> 3. Flag duplicated logic (>5 similar lines), reimplemented helpers, or missed utility reuse
> 4. Check if anything was reimplemented that is available in project dependencies
>
> Classify findings per the Classification Criteria above.
> If none found, report "No DRY violations found."

#### Agent 2: Security Review

> You are reviewing uncommitted changes for security vulnerabilities.
>
> Check every changed file for:
> - Injection (SQL, command, template, path traversal)
> - XSS (unescaped user input in HTML/JSX/templates)
> - Auth/authz gaps
> - Hardcoded secrets, API keys, tokens
> - Insecure patterns, unsafe deserialization
> - Missing input validation at system boundaries
> - OWASP Top 10
>
> Classify findings per the Classification Criteria above.
> If none found, report "No security issues found."

#### Agent 3: Supportability Review

> You are reviewing uncommitted changes for supportability — can someone debug and operate this code in production?
>
> Check every changed file for:
> - Error messages: Are they actionable? Do they include context (what failed, what was expected)?
> - Logging: Are key operations logged? Can you trace a request through the system?
> - Error handling: Are errors caught with useful context, or do they bubble as cryptic stack traces?
> - Failure modes: What happens when external calls fail? Is there graceful degradation?
>
> Classify findings per the Classification Criteria above.
> If none found, report "No supportability issues found."

#### Agent 4: Maintainability Review

> You are reviewing uncommitted changes for maintainability — will the next developer understand and safely modify this code?
>
> Check every changed file for:
> - Unclear or misleading names
> - Functions >50 lines or deeply nested (>3 levels)
> - Magic numbers/strings without named constants
> - Tight coupling that blocks testing or reuse
> - Missing TypeScript types (any, implicit any)
> - Dead code, unused imports, unreachable branches
> - Leftover console.log / debugger statements
> - TODO/FIXME/HACK without issue references
>
> Classify findings per the Classification Criteria above.
> If none found, report "No maintainability issues found."

#### Agent 5: Documentation Review

> You are reviewing uncommitted changes for documentation gaps and inaccuracies.
>
> Check:
> 1. **README**: Does it still accurately describe the project? Are new features/commands/options documented?
> 2. **Doc files** (docs/, *.md): Are any now outdated or incorrect because of the code changes?
> 3. **Code comments**: Are existing comments still accurate? Are complex new sections missing explanations?
> 4. **API surface**: If public APIs changed, are type definitions / JSDoc / OpenAPI specs updated?
> 5. **Examples**: Do code examples in docs still work?
>
> Classify findings per the Classification Criteria above.
> If none found, report "No documentation issues found."

#### Agent 6: Convention / Contract Enforcement

> You are reviewing uncommitted changes for violations of the project's cross-cutting contracts and conventions — the rules that are easy to break from memory and that a generic linter will not catch. Knowing a convention is not the same as enforcing it; your job is to enforce it on the touched code.
>
> 1. Read the project's convention sources: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and anything under `docs/architecture/` or `docs/conventions/`.
> 2. For each changed file, check it against those documented contracts. Common classes: API request/response envelopes consumed through the shared helper (not ad-hoc destructuring of response bodies); data-access conventions (where indexes are declared, reference-field shape); shared error/response wrappers; module-boundary and naming rules the project documents.
> 3. Flag any touched code that bypasses a documented contract, citing the convention source (file + rule).
> 4. **New backend route without an integration test.** If the diff added or modified a route under `packages/backend/src/api/v1/registry/routes/`, run the route-coverage mapper (`pnpm --filter imboard_be test:route-coverage`) and check whether any route in the diff is reported as uncovered. A new uncovered route is a contract violation — this is an agents-driven repo, so an agent-authored route MUST land with its integration test, not a human-authored follow-up. Flag it as a finding. (If this project has no such routes/mapper, skip this check.)
>
> A contract violation is verifiable and is not a product decision — classify it "Fix now" per the Classification Criteria, and fix it in-place (for an uncovered route, add the integration test under `tests/integration/`). If the project documents no such conventions, report "No documented conventions to enforce."

#### Agent 7: Conformance (blind)

> You are verifying that the change does what the issue asked. You did NOT write this code. Your ONLY inputs are: (1) the issue body and comments — `gh issue view <N> --json title,body,comments`; (2) the diff — `git diff <base_branch>...HEAD` plus `git diff` for uncommitted changes; (3) this Acceptance Criteria list: <paste the `AC<n>=` lines fetched in Step 2b>. Do NOT read the planning document or any other agent's output.
>
> For each AC report exactly one of: `met <file:line>`, `not-met <why>`, `unverifiable <what test would prove it>`. `met` without a file:line citation is invalid — report it as `unverifiable`.

### Step 4: After All Agents Complete

1. **Collect** all findings from the 7 agents
2. **Fix ALL "Fix now" findings** — use the Edit tool directly. These can be non-trivial: refactors, adding error handling, fixing historic lint issues in touched files, etc.
3. **Route Agent 7's conformance results**:
   - Any `not-met` → return to implement for ONE bounded fix loop scoped to that AC, then re-run Agent 7 ONLY (not the other 6). A second `not-met` on the same AC after that fix loop → escalate (counts toward `review_escalated`, reason "spec not met after one fix loop").
   - `unverifiable` → add the test Agent 7 named, then mark the AC met.
4. **Re-run tests** after fixes to ensure nothing broke. If a fix breaks tests, revert that specific fix and reclassify as Escalate.
5. **Run lint auto-fixer** to clean up formatting:
   - Node.js with biome: `npx biome check --write .`
   - Node.js with eslint: `npx eslint --fix .`
   - Python with ruff: `ruff check --fix .`
   - Or whatever the project's `lint:fix` script is (check package.json / Makefile)

### Step 5: Output

Report the review results:

```
Review complete.
Fixed: <count> findings across <agent_count> agents
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

Post the phase milestone to the issue. This is the last step of the phase — if review aborts, post `status=blocked` with `reason=<short-slug>` instead and stop. Use `status=partial` when any agent did not finish. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
gh issue comment <issue_number> --body "$(cat <<EOF
<!-- runstate:v1 -->
phase=review status=done run=<run_id> at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
head=<short sha of HEAD>
fixed=<n>
escalated=<n>
agents_done=<comma list of agent names, including conformance>
agents_pending=<comma list or none>
ac_met=<n>
ac_total=<n>
next=ship
EOF
)"
```

`at` is filled in by the template (the heredoc is unquoted so `$(date …)` expands); put no other `$` in values. Values contain no spaces (use `-` or `,`); paths are absolute.

## Output

- `review_fixed`: number of findings fixed in-place
- `review_escalated`: number of findings escalated to the user (ideally 0)
- `review_clean`: list of agent names that found no issues
- `ac_met` / `ac_total`: acceptance criteria met vs. total (0/0 when Agent 7 was skipped — no AC list found)
- `ac_results`: the per-AC checklist (criterion, verdict, file:line or reason) from Agent 7 — pass through to ship-issue for the PR body's Acceptance Criteria section
- Posts runstate milestone to the issue (`phase=review`, including `ac_met`/`ac_total`)

## Validation

- [ ] Working directory was confirmed before starting
- [ ] Changed files list was obtained via `git diff --name-only`
- [ ] Acceptance Criteria were fetched from the last `phase=plan` runstate milestone (Step 2b) before launching Agent 7
- [ ] All 7 review agents were launched in parallel (Agent 7 skipped only when no AC list was found)
- [ ] Each agent classified findings using the Classification Criteria
- [ ] All "Fix now" findings were applied via Edit tool
- [ ] A new/changed backend registry route in the diff was checked against the route-coverage mapper; any uncovered route was flagged (and its integration test added)
- [ ] Every `not-met` AC went through one bounded fix loop + a re-run of Agent 7 alone; a second `not-met` on the same AC was escalated
- [ ] Every `unverifiable` AC got the named test added, then was marked met
- [ ] `met` citations without a `file:line` were treated as `unverifiable`, not accepted
- [ ] Tests were re-run after fixes — no regressions introduced
- [ ] Lint auto-fixer was run after all fixes
- [ ] Escalated findings (if any) each satisfy all three escalation criteria
- [ ] No more than 2 findings were escalated total (re-evaluated if exceeded)
- [ ] Final output includes counts for fixed, escalated, clean, and `ac_met`/`ac_total`
- [ ] Runstate milestone comment was posted to the issue

## Troubleshooting

**No uncommitted changes**: `git diff --name-only` returns nothing. Verify you are in the correct directory and that implementation was completed before running review.

**Agent finds issues in files not in the diff**: Agents should focus on changed files only. Findings in unchanged files are out of scope — skip them unless they are directly impacted by the changes (e.g., a caller of a changed function).

**Fix breaks tests**: Revert the specific fix (`git checkout -- <file>` and re-apply other fixes), reclassify that finding as Escalate with an explanation of the test failure.

**Too many escalated findings**: If more than 2 findings are escalated, re-read each one against the three-part test (user-facing behavior change AND cannot verify with tests AND requires product decision). Most findings that feel like escalations are actually "Fix now" — code quality, naming, missing validation, and documentation gaps should always be fixed directly.

**Lint auto-fixer introduces changes**: This is expected. Review the auto-fix diff briefly to ensure nothing was mangled, then proceed.
