---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "feature-to-issues",
  "title": "Feature to Issues — Multi-Agent Feature Development Pipeline",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-04-06",
  "objective": "Take a problem signal and orchestrate PM, UX/FE, and DB/BE agents through discovery, PRD creation, spec generation, and GH issue decomposition — producing a complete feature folder with dependency-linked issues ready for implementation",
  "category": [
    "development",
    "workflow"
  ],
  "tags": [
    "feature",
    "prd",
    "issues",
    "workflow",
    "multi-agent",
    "planning",
    "discovery",
    "pm"
  ],
  "tools_required": [
    {
      "name": "gh",
      "version": ">=2.0.0",
      "check_command": "gh --version"
    },
    {
      "name": "git",
      "version": ">=2.30.0",
      "check_command": "git --version"
    }
  ],
  "risk_level": "medium",
  "requires_approval": true,
  "risk_factors": [
    "modifies_files",
    "network_access"
  ],
  "destructive_operations": [
    "Creates files in ./features/<slug>/ directory",
    "Creates GitHub issues on the repository"
  ],
  "estimated_duration": {
    "min_minutes": 30,
    "max_minutes": 120
  },
  "inputs": {
    "required": [
      {
        "name": "problem_signal",
        "description": "The problem to solve — a user complaint, feature request, or observed pain point",
        "type": "string",
        "example": "Users can't see their company profile after onboarding"
      }
    ],
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Project-specific worktree warmup dossier for implementation phase",
        "type": "string",
        "default": ""
      },
      {
        "name": "skip_implementation",
        "description": "Stop after GH issues are created (no implementation)",
        "type": "boolean",
        "default": false
      },
      {
        "name": "implementation_mode",
        "description": "Which issue workflow to use: guided or full-cycle",
        "type": "string",
        "default": "guided"
      },
      {
        "name": "feature_dir",
        "description": "Custom path for the feature folder (default: ./features/<slug>/)",
        "type": "string",
        "default": ""
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "features/<slug>/STATUS.md",
        "description": "State machine for resumability"
      },
      {
        "path": "features/<slug>/prd.md",
        "description": "Approved PRD"
      },
      {
        "path": "features/<slug>/fe-spec.md",
        "description": "FE component specification"
      },
      {
        "path": "features/<slug>/issues.md",
        "description": "Issue decomposition with dependency chain"
      },
      {
        "path": "features/<slug>/process-log.md",
        "description": "Decision log with timestamps"
      }
    ],
    "state_changes": [
      {
        "description": "Creates GitHub issues on the repository",
        "affects": "GitHub issue tracker",
        "reversible": true
      }
    ]
  },
  "relationships": {
    "followed_by": [
      {
        "dossier": "guided-cycle-issue",
        "condition": "suggested",
        "purpose": "Implement created issues with human review"
      },
      {
        "dossier": "full-cycle-issue",
        "condition": "suggested",
        "purpose": "Implement created issues autonomously"
      }
    ]
  },
  "checksum": {
    "algorithm": "sha256",
    "hash": "2b53b7894391c928b93d266dbe1d71d48f938c6c42c9af5df9ce8b009db3b077"
  }
}
---

# Feature to Issues — Multi-Agent Feature Development Pipeline

## Objective

Take a problem signal and produce a complete feature folder with PRD, FE spec, wireframes, data model assessment, and dependency-linked GitHub issues — ready for implementation via existing issue cycle workflows.

This is a **project-agnostic** dossier. It works on any codebase with a GitHub remote.

## Three Agent Personas

### PM Agent (Orchestrator)

The PM Agent is the primary agent. It talks to the human, interviews them, pushes back, evaluates, and drives the problem→solution forward. It is NOT a passive transcriber — it is a skilled product manager.

**Behavioral principles:**
- Interview style, not checklist style. Ask one question at a time.
- For each solution idea, evaluate: Who benefits? How much? What's the cost? What's the risk? Is this the right time given product stage?
- Push back on scope creep: "That's a great idea for V2 — for this PRD, let's focus on X because Y."
- Help the human scope aggressively. An effective, impactful, implementable PRD beats a dream. Visions are great but must be broken into multiple PRDs.
- Continuously evaluate value-to-user and value-to-business relative to product stage and goals.
- When presenting options, include pros/cons/risk/reward to help informed decisions.
- If the human highlights deviation from goals — stop, evaluate why, course-correct. Don't defend.
- Conversations are NOT limited to fixed cycles. Continue as long as there's progress and constructive forward momentum.
- Track all decisions and reasoning in `process-log.md` as you go.

**Skills used:** `pm-business-context` (optional), `pmf-problem-statement`, `pmf-proto-persona`, `pmf-prd-development`, `pmd-prd-critic`, `pmf-epic-breakdown-advisor`, `pmf-user-story`

### UX/FE Agent

Translates the approved PRD into frontend-actionable specs. Does NOT make product decisions — only design and implementation decisions.

**Skills used:** `ux-advisor` (web design knowledge), `visual-design-review` (aesthetic scoring), `pmf-storyboard`, `pmf-customer-journey-map`

### DB/BE Architect Agent

Evaluates data model impact. Only activated when schema changes are structural (new tables/collections, relationship changes, breaking migrations). Additive changes (new fields, new indexes) are documented by the PM Agent inline.

**Skills used:** Inline instructions (see Stage 6).

---

## Prerequisites

Before starting, verify:
```bash
gh auth status    # GitHub CLI authenticated
git status        # In a git repo
```

## Resumability

**On start, ALWAYS check for existing work first:**
```bash
ls features/*/STATUS.md 2>/dev/null
```

If a `STATUS.md` exists matching this problem signal:
1. Read `STATUS.md` to see what was accomplished
2. Read all existing artifacts to rebuild context
3. Present to the human with options:
   - **Option 1**: Resume from where we left off
   - **Option 2**: Restart the current (incomplete) stage
   - **Option 3**: Start over from scratch

If feature folder exists but `STATUS.md` is missing, corrupted, or unreadable:
1. List all artifact files in the feature folder
2. Ask the human:
   - **Option A**: Continue by scanning all artifacts and inferring stage (describe what was found)
   - **Option B**: Start the current feature over from Stage 1
   - **Option C**: Delete the feature folder and start fresh

If no match found, proceed to Stage 1.

---

## Artifact Header Format

Every artifact file produced by this dossier includes a YAML header for resumability:

```markdown
---
feature: <feature-slug>
stage: <stage number and name>
status: draft | approved
produced_by: PM Agent | UX/FE Agent | DB/BE Architect Agent
created: <ISO timestamp>
updated: <ISO timestamp>
context: <1-2 sentence summary of key decisions that led to this artifact>
---
```

This header ensures each file is self-contained — a new session can read the header and understand the artifact's context without needing conversation history.

---

## Stage 1: Init

**Agent:** PM Agent
**Input:** `problem_signal` (string from user)
**Output:** `problem-signal.md`, feature folder, `STATUS.md`, `process-log.md`

### Actions

1. **Slugify** the problem signal: lowercase, hyphens, remove special chars, max 50 chars.

2. **Create the feature folder:**
   ```bash
   FEATURE_DIR="${feature_dir:-./features/<slug>}"
   mkdir -p "$FEATURE_DIR"
   ```

3. **Detect project context** (project-agnostic — auto-detect):
   - Tech stack: scan for `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, etc.
   - Framework: scan for `next.config.*`, `nuxt.config.*`, `angular.json`, `svelte.config.*`, Django `settings.py`, Rails `config/`, etc.
   - Repo name: `gh repo view --json name --jq '.name'`

4. **Attempt to load business context** (optional):
   - If `pm-business-context` skill is available AND a business brief exists: load it for ICP, positioning, stage, constraints.
   - If not available: log a note and continue. This dossier works without business context.

5. **Write `problem-signal.md`** with artifact header and problem statement.

6. **Initialize `STATUS.md`** with stage tracking table.

7. **Initialize `process-log.md`** with first entry: `## <timestamp> — Stage 1: Init` + bullet points.

8. **Update `STATUS.md`**: Mark Stage 1 as ✅ Done with timestamp.

---

## Stage 2: Discovery

**Agent:** PM Agent
**Input:** `problem-signal.md`, codebase access
**Output:** `discovery.md`

### Actions

1. **Codebase research** — scan for Routes/Pages, Data Models, Services/Controllers, UI Components, Tests, Config. Document findings with file paths.

2. **Problem framing** — invoke `/pmf-problem-statement` using problem signal + codebase findings + business context.
   **Fallback**: Generate inline template: Who/What/Why/Evidence/Current State sections.

3. **Proto-persona** — invoke `/pmf-proto-persona` for hypothesis-driven persona.
   **Fallback**: Generate inline with Role/Goals/Pain points/Frequency/Constraints sections.

4. **Write `discovery.md`** with all three sections and artifact header.

5. **Present findings to the human** for discussion.

6. **Flush progress**: Update `STATUS.md`, append to `process-log.md` in format: `## <ISO timestamp> — Stage 2: Discovery` with bullet points.

---

## Stage 3: Creative Loop

**Agent:** PM Agent
**Input:** `discovery.md`
**Output:** `scope-lock.md`

### Success Criteria

By Stage 3 completion, the human must have made 2+ major decisions. If not after 4+ exchanges, escalate: "We're cycling without convergence — let's reset."

### PM Agent Approach

1. **Propose 2-3 solution directions** with description, complexity, tradeoff, benefits, risk/reward.

2. **Evaluate each direction** against: value-to-user, value-to-business, feasibility, product stage alignment.

3. **Facilitate conversation** — drill into scope, explore ideas, push back on scope creep, recommend splitting large scope.

4. **Periodically flush progress** (after every decision or every 2 exchanges):
   - Write draft `scope-lock.md` (marked `status: draft`)
   - Append to `process-log.md`: `## <ISO timestamp> — Stage 3: Creative Loop, Decision: <what>, Reasoning: <why>, Impact: <change>`

5. **Scope lock trigger**: Human explicitly approves scope. PM Agent writes final `scope-lock.md` with status: approved, including Chosen Direction, In Scope, Out of Scope, Key Decisions, Complexity Assessment.

6. **Update `STATUS.md`**: Mark Stage 3 as ✅ Done.

### Failure Handling

- If stuck after multiple direction rejections: pause and suggest `/pmf-discovery-process` for deeper exploration.
- If human says "we've deviated": stop, ask human to restate goal, re-evaluate.

---

## Stage 4: PRD

**Agent:** PM Agent
**Input:** `discovery.md`, `scope-lock.md`
**Output:** `prd.md`

### Actions

1. **Generate PRD** — invoke `/pmf-prd-development`. Pre-fill phases 1-4 from discovery/scope-lock, draft phases 5-8 from scope decisions.
   **Fallback**: Generate inline with 8 sections: Executive Summary, Problem Statement, Target Users, Strategic Context, Solution Overview, Success Metrics, User Stories, Out of Scope.

2. **Quality gate** — invoke `/pmd-prd-critic`. If score <60%, auto-revise and re-run.
   **Fallback**: Manual checklist: specific problem, named users, measurable metrics, acceptance criteria, out-of-scope section explicit. Revise any fails.

3. **Present PRD to human**. If scope too large, recommend splitting into multiple PRDs.

4. **Iterate** until human approves.

5. **Write approved `prd.md`** with `status: approved` header.

6. **Scope Check**: Before finalizing, evaluate: "Can this be implemented in 5-12 issues?" If not, recommend splitting.

7. **Update `STATUS.md`** and `process-log.md`.

---

## Stage 5: FE Spec + Wireframes

**Agent:** UX/FE Agent
**Input:** `prd.md`, codebase access
**Output:** `fe-spec.md`, `wireframes.md`, `storyboard.md`

**Skip this stage if:** PRD describes backend-only feature. Detection: scan PRD Solution Overview for keywords: "UI", "page", "screen", "component", "interface", "frontend", "form", "button", "modal", "dialog", "template", "layout", "view". If zero matches, skip to Stage 6 and note in `process-log.md`.

### Actions

1. **Codebase scan** — identify component library, layout patterns, state management, routing, design tokens.

2. **Generate `fe-spec.md`** using `ux-advisor` skill: Component Hierarchy, New Components, Reused Components, State Management, API Contract, Routing Changes, Responsive Behavior.

3. **Generate `wireframes.md`** — text-based wireframes for each screen with annotations.

4. **Generate `storyboard.md`** — invoke `/pmf-storyboard` for 6-frame user journey.

5. **Present all three artifacts** to human for review and iterate.

6. **Update `STATUS.md`** and `process-log.md`.

---

## Stage 6: Data Model Assessment

**Agent:** PM Agent (triage) → DB/BE Architect Agent (if structural)
**Input:** `prd.md`, `fe-spec.md` (if exists), codebase access
**Output:** `data-model.md` (only if structural changes needed)

### Actions

1. **Scan codebase** for Prisma schemas, Mongoose models, SQL migrations, TypeORM entities, GraphQL schemas, type directories.

2. **Classify changes:**
   - **None**: Skip stage, note in process-log
   - **Additive**: New optional fields, indexes, enums → document in prd.md appendix, no checkpoint
   - **Structural**: New tables, foreign key changes, required fields, column type changes → hand off to DB/BE Architect

3. **If structural** — DB/BE Architect produces `data-model.md` with Current Schema, Proposed Changes, Migration Plan (Up/Down), Backward Compatibility, Rollback Strategy.

4. **If structural** — present schema proposal to human for approval.

5. **Update `STATUS.md`** and `process-log.md`.

---

## Stage 7: Issue Decomposition

**Agent:** PM Agent
**Input:** `prd.md`, `fe-spec.md` (if exists), `data-model.md` (if exists), `scope-lock.md`
**Output:** `issues.md`, then actual GH issues

### Actions

1. **Break down PRD** — invoke `/pmf-epic-breakdown-advisor` to identify splitting pattern.
   **Fallback**: Manually identify 5-12 stories by scanning PRD Solution Overview and user stories, group by feature area or workflow.

2. **Write user stories** — invoke `/pmf-user-story` for each story to generate Gherkin acceptance criteria.
   **Fallback**: Generate inline: "As a <role>, I want <action>, so that <benefit>" with Gherkin acceptance criteria bullets.

3. **Determine dependency order** using strict tier rules (no exceptions):
   - **Tier 1**: Data model / schema changes (nothing depends on this)
   - **Tier 2**: Backend API / service logic (depends on Tier 1)
   - **Tier 3**: Frontend components / pages (depends on Tier 2)
   - **Tier 4**: Integration / wiring (depends on Tier 3)
   - **Tier 5**: Polish / UX refinements (depends on Tier 4)
   
   **Assignment rule:** If issue spans multiple tiers, assign to **highest tier number**. Within a tier, issues are independent.
   **Circular dependency check:** Verify no cycles before proceeding. If found, escalate to human.

4. **Write `issues.md`** — Issue Plan table (# / Title / Tier / Size / Depends On / PRD Section), Dependency Graph (text DAG), Suggested Implementation Order.

5. **Present issue plan to human.** Ask for one of these decisions:
   - **Decision 1**: Create all issues as planned
   - **Decision 2**: Modify the plan (add/remove/reorder)
   - **Decision 3**: Create issues but stop here (no implementation)

6. **Create GH issues** via `gh issue create`. Each issue body includes: User Story, Acceptance Criteria, PRD Reference, Dependencies, Implementation Notes, Feature folder ref.
   Labels: `feature/<slug>`, `size/<S|M|L>`, `from-prd`

7. **Update `issues.md`** with actual GH issue numbers.

8. **Update `STATUS.md`** and append to `process-log.md`:
   ```markdown
   ## <ISO timestamp> — Stage 7: Issue Decomposition
   - Issues created: #<N>, #<N>, #<N>, ...
   - Total: <count>
   - Highest tier: <N>
   - Dependency chains: <summary>
   - Decision: <Decision 1/2/3>
   ```

### Failure Handling

- If `gh` rate limit hit: wait and retry (3 attempts with exponential backoff).
- If creation partially fails: note created issues in `issues.md`, report failures, let human retry.

---

## Stage 8: Package + Hand-off

**Agent:** PM Agent
**Input:** All artifacts from previous stages
**Output:** `README.md`, updated `process-log.md`

### Actions

1. **Generate `README.md`** as feature folder index with Problem, Status, Issues, Artifacts table, Decision Log link.

2. **Finalize `process-log.md`** with summary section.

3. **Implementation hand-off.** Ask for one decision:
   - **Decision 1**: Start implementation with `guided-cycle-issue` (one at a time, human review)
   - **Decision 2**: Start implementation with `full-cycle-issue` (autonomous, dependency order)
   - **Decision 3**: Don't start implementation — manual
   - **Decision 4**: Start for selected issues only (human picks)
   
   If `skip_implementation` input is `true`, default to Decision 3 without asking.

4. **Update `STATUS.md`**.

---

## Stage 9: Implementation (Delegated)

**Agent:** Delegated to existing issue cycle workflows
**Input:** GH issue numbers from `issues.md`, selected workflow
**Output:** Merged PRs for each issue

**Skip if:** Human chose Decision 3 at Stage 8.

### Actions

1. Read `issues.md` for ordered issue list and dependencies.

2. For each issue (in dependency order):
   - **Wait for blocking issues**: Check `gh issue view <N> --json state` for each dependency.
   - **Invoke selected workflow**: `guided-cycle-issue` or `full-cycle-issue` skill with issue number + `warmup_dossier` if provided.
   - Log result in `process-log.md`: PR number, merge status, escalated issues.

3. **Base branch strategy**:
   - No dependencies: branch from `main`
   - Depends on another issue: use `--base <previous-branch>` if PR not merged, else `main`

4. When all complete (or human stops), proceed to Stage 10.

5. **Update `STATUS.md`** after each issue completes.

### Failure Handling

- If issue fails (tests, conflicts): mark in `process-log.md`, skip, continue non-blocked issues. Report failures at end.
- If indefinitely blocked: escalate to human.

---

## Stage 10: Review Loop

**Agent:** PM Agent
**Input:** `prd.md`, list of merged PRs, codebase access
**Output:** `review-report.md`, optionally new GH issues

**Skip if:** No implementation was done (Stage 9 skipped).

### Actions

1. **Read approved `prd.md`** section by section.

2. **For each PRD requirement**, check codebase:
   - Does feature exist? (search files, routes, components, endpoints)
   - Does it match acceptance criteria? (check Gherkin scenarios against test files)
   - Any regressions? (run test suite if available: `npm test`, `pytest`, etc.)

3. **Produce `review-report.md`** with PRD Compliance Matrix (Requirement / Issue / Status / Evidence / Notes) and Summary (Coverage %, Gaps, Regressions).

4. **If gaps exist**, present options:
   - **Decision A**: Create new GH issues for all gaps (automatic)
   - **Decision B**: Create issues for critical gaps only (human selects)
   - **Decision C**: Accept as-is — gaps acceptable for this release
   - **Decision D**: Re-run review loop after manual fixes

5. **If new issues created**: use same issue decomposition format (user story, acceptance criteria, PRD reference, dependency links).

6. **Loop termination**:
   - Human chooses Decision C → done
   - PRD compliance reaches 100% → done
   - Maximum 3 review loop iterations → force human decision

7. **Update `STATUS.md`** and `process-log.md` with final summary.

---

## State Machine Summary

```
Stage 1 (Init) → Stage 2 (Discovery) → Stage 3 (Creative Loop) → Stage 4 (PRD)
  → Stage 5 (FE Spec) [skip if backend-only]
  → Stage 6 (Data Model) [skip if no changes]
  → Stage 7 (Issue Decomposition) → Stage 8 (Package + Hand-off)
  → Stage 9 (Implementation) [skip if manual]
  → Stage 10 (Review Loop) [skip if no implementation]
  → Done
```

Between every stage transition:
1. Current stage artifact is written to disk with header
2. `STATUS.md` is updated with completion timestamp
3. `process-log.md` is appended: `## <ISO timestamp> — Stage <N>: <action>` with bullet-point details

Within long stages (Creative Loop, PRD): periodically flush draft artifacts and process-log entries after every major human decision.

---

## Validation

- [ ] Feature folder created with `STATUS.md`
- [ ] Each stage updates `STATUS.md` on completion with timestamp
- [ ] All artifacts have YAML headers: feature, stage, status, produced_by, created, updated, context
- [ ] PM Agent interviews (not checkpoints) in Stages 2-4
- [ ] PM Agent pushes back on scope creep, recommends splitting large PRDs
- [ ] Stage 3 success criteria enforced: 2+ decisions before proceeding
- [ ] FE Spec stage correctly skips backend-only features (keyword scan validated)
- [ ] Data Model stage correctly classifies additive vs structural changes
- [ ] GH issues created with dependency chain (`Depends on #N` in body)
- [ ] Tier assignment rule enforced: highest tier when spanning multiple tiers
- [ ] Circular dependency check performed and validated before issue creation
- [ ] Implementation delegates to existing issue cycle workflows
- [ ] Review loop compares codebase against PRD and identifies gaps
- [ ] `process-log.md` records all decisions with reasoning, timestamps, impact
- [ ] Resume works: new session reads `STATUS.md`, presents options, picks up from current stage
- [ ] All skill invocations have explicit fallback instructions
- [ ] Option formatting consistent: "Decision N", "Option X", or "Choice Y" — never mixing formats
