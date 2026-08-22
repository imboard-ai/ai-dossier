---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Review Issue — Parallel Code Review",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Run 5 parallel review agents (DRY, Security, Supportability, Maintainability, Documentation) on uncommitted changes, fix findings in-place, and produce a review summary",
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
  "risk_factors": [
    "modifies_files"
  ],
  "inputs": {
    "required": [],
    "optional": []
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "review-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "2d764730b650caf6aabf1068ba59da22a3f9633807b9d3d61ec1f139a5e18f49"
  }
}
---

# Review Issue — Parallel Code Review

## Objective

Run 5 focused review agents in parallel on uncommitted changes. Each agent reviews from a different quality dimension, fixes what it can, and escalates only what requires human judgment. After all agents complete, consolidate fixes and produce a review summary.

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

### Step 3: Run 5 Review Agents in Parallel

Launch all 5 agents simultaneously using the Agent tool. Each agent receives the changed files list and operates independently.

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

### Step 4: After All Agents Complete

1. **Collect** all findings from the 5 agents
2. **Fix ALL "Fix now" findings** — use the Edit tool directly. These can be non-trivial: refactors, adding error handling, fixing historic lint issues in touched files, etc.
3. **Re-run tests** after fixes to ensure nothing broke. If a fix breaks tests, revert that specific fix and reclassify as Escalate.
4. **Run lint auto-fixer** to clean up formatting:
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

[If escalated items exist:]
Escalated findings:
- [Agent]: <description> — Reason: <why all three escalation criteria apply>
```

## Output

- `review_fixed`: number of findings fixed in-place
- `review_escalated`: number of findings escalated to the user (ideally 0)
- `review_clean`: list of agent names that found no issues

## Validation

- [ ] Working directory was confirmed before starting
- [ ] Changed files list was obtained via `git diff --name-only`
- [ ] All 5 review agents were launched in parallel
- [ ] Each agent classified findings using the Classification Criteria
- [ ] All "Fix now" findings were applied via Edit tool
- [ ] Tests were re-run after fixes — no regressions introduced
- [ ] Lint auto-fixer was run after all fixes
- [ ] Escalated findings (if any) each satisfy all three escalation criteria
- [ ] No more than 2 findings were escalated total (re-evaluated if exceeded)
- [ ] Final output includes counts for fixed, escalated, and clean

## Troubleshooting

**No uncommitted changes**: `git diff --name-only` returns nothing. Verify you are in the correct directory and that implementation was completed before running review.

**Agent finds issues in files not in the diff**: Agents should focus on changed files only. Findings in unchanged files are out of scope — skip them unless they are directly impacted by the changes (e.g., a caller of a changed function).

**Fix breaks tests**: Revert the specific fix (`git checkout -- <file>` and re-apply other fixes), reclassify that finding as Escalate with an explanation of the test failure.

**Too many escalated findings**: If more than 2 findings are escalated, re-read each one against the three-part test (user-facing behavior change AND cannot verify with tests AND requires product decision). Most findings that feel like escalations are actually "Fix now" — code quality, naming, missing validation, and documentation gaps should always be fixed directly.

**Lint auto-fixer introduces changes**: This is expected. Review the auto-fix diff briefly to ensure nothing was mangled, then proceed.
