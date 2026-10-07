---
name: 'context-engineering-best-practices'
description: 'Provide a reference guide for writing effective context files (AGENTS.md, CLAUDE.md, system prompts) that improve AI coding agent performance without over-constraining agent behavior'
license: 'AGPL-3.0'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Context Engineering Best Practices for AI Coding Agents'
  dossier.version: '1.0.0'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Draft'
  dossier.last_updated: '2026-03-09'
  dossier.objective: 'Provide a reference guide for writing effective context files (AGENTS.md, CLAUDE.md, system prompts) that improve AI coding agent performance without over-constraining agent behavior'
  dossier.category: '["documentation","development"]'
  dossier.tags: '["context-engineering","agents-md","claude-md","system-prompts","best-practices","llm","coding-agents"]'
  dossier.tools_required: '[]'
  dossier.risk_level: 'low'
  dossier.risk_factors: '[]'
  dossier.requires_approval: 'false'
  dossier.destructive_operations: '[]'
  dossier.content_scope: 'references-external'
  dossier.external_references: '[{"description":"ETH Zurich paper evaluating the impact of AGENTS.md files on coding agent performance","required":false,"trust_level":"trusted","type":"documentation","url":"https://arxiv.org/abs/2602.11988"}]'
  dossier.authors: '[{"email":"yuval.dimnik@gmail.com","name":"Yuval Dimnik"}]'
  dossier.checksum: '{"algorithm":"sha256","hash":"9e93b02744e0833b86e8d05de232742703efb98cb4aaa3ee709f76ad1b18eb7e"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"4Py1u3GKGeeQGX8ftRMurO7evbWtaYcA9+h93jR1YBaOkwz1Uak6awE+/SMEdzBHmBSk264mBgRBxf9h8A/VAg==","signed_at":"2026-10-07T12:15:17.511Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
---
# Context Engineering Best Practices for AI Coding Agents

A reference guide for writing context files -- AGENTS.md, CLAUDE.md, system prompts, and dossiers -- that genuinely improve AI coding agent performance.

**Audience**: Developers who write instructions for AI coding agents (Claude Code, Copilot, Cursor, Cline, etc.)

**Core thesis**: The most effective context tells agents *what* to achieve and *why* it matters. It does not tell them *how* to do it step-by-step.

---

## Why Context Engineering Matters

AI coding agents operate on the information available in their context window. The quality of that context directly determines whether the agent succeeds or fails, and how much it costs to get there.

But more context is not better context. Research from ETH Zurich (Fourrier et al., 2026) found that auto-generated AGENTS.md files *reduced* task success by 3% while *increasing* cost by 20%. The problem was not the presence of context -- it was the wrong kind of context: verbose, procedural, and full of information the agent could discover on its own.

The goal of context engineering is to give agents the information they genuinely cannot infer, in a format that empowers rather than constrains them.

---

## Principle 1: Declarative What/Why Over Procedural How

Agents are competent at figuring out *how* to accomplish tasks. They can read codebases, discover project structure, choose appropriate tools, and adapt to edge cases. What they need from context files is the information they **cannot infer on their own**.

### What belongs in a context file

- **Goals and success criteria**: What does "done" look like?
- **Constraints the agent cannot infer**: Architectural decisions, required conventions, specific tool requirements
- **Known pitfalls that would waste significant time**: Counterintuitive behaviors, misleading error messages, environment-specific traps
- **Domain knowledge not in the code**: Business rationale, historical decisions, team conventions
- **Non-obvious relationships**: Which systems depend on which, what breaks if you change X

### What does NOT belong in a context file

- **Step-by-step bash commands for standard operations**: The agent knows how to run `npm install` or `git commit`
- **Information the agent can discover from the codebase**: Directory trees, file listings, language/framework detection
- **Detailed instructions for common tasks**: The agent can figure out how to create a React component or write a unit test
- **Exhaustive prerequisite checks**: The agent discovers missing tools when commands fail

### Example: Over-specified vs. Declarative

Over-specified (hurts performance):
```markdown
## How to add a new API endpoint
1. Create a new file in src/routes/
2. Import express Router: `import { Router } from 'express'`
3. Create the router: `const router = Router()`
4. Add your route handler: `router.get('/path', handler)`
5. Export the router: `export default router`
6. Register it in src/app.ts: `app.use('/api', router)`
7. Add types to packages/shared-types/src/...
8. Run `npm run build` in shared-types
9. Run `npm test` to verify
```

Declarative (empowers the agent):
```markdown
## API conventions
- Routes live in src/routes/ and are auto-registered by src/app.ts
- Shared request/response types go in packages/shared-types
- Every endpoint needs integration tests (see existing tests for patterns)
- shared-types must be rebuilt after type changes: `npm run build -w packages/shared-types`
```

The declarative version gives the agent the non-obvious facts (auto-registration, shared-types rebuild requirement) while trusting it to handle the standard work.

---

## Principle 2: Avoid the Tool Name-Dropping Trap

The ETH Zurich research found that **mentioning a tool by name makes agents use it 2.5x more frequently** -- even when the tool is not the best choice for the task.

This is one of the most counterintuitive findings in context engineering. Developers naturally write things like "use ripgrep to search" or "format with prettier" because they are documenting their own workflow. But to an agent, a tool name in a context file reads as a directive.

### When tool names ARE appropriate

Name a tool when it is a **genuine project constraint** the agent cannot infer:

```markdown
## Project conventions
- Linter: Biome (not ESLint) -- the project uses Biome exclusively
- Container runtime: Podman (Docker is not available on CI runners)
- Package manager: pnpm (npm and yarn are not supported by the monorepo setup)
```

These are facts the agent needs because choosing the wrong tool would cause real failures.

### When tool names are NOT appropriate

Do not name tools when they are preferences or when the agent can choose the right tool:

```markdown
# BAD: Name-drops tools as implicit directives
Use `ripgrep` to search for TODO comments.
Parse the config file with `jq`.
Format the output with `prettier`.

# GOOD: States the goal, lets agent choose
Find all TODO comments in the codebase and compile them
into a prioritized report alongside the project configuration.
```

---

## Principle 3: Know When Context Helps vs. When It Hurts

Context files are not universally helpful. Their value depends on what kind of information they contain.

### Context that reliably HELPS

| Information type | Why it helps | Example |
|---|---|---|
| Non-obvious constraints | Agent would choose wrong default | "ESM only -- no CommonJS imports" |
| Build order dependencies | Agent cannot infer from file structure alone | "Rebuild shared-types before running backend tests" |
| Environment-specific traps | Agent would waste cycles debugging | "Node 20.6+ required for --env-file flag" |
| Credential/secret locations | Agent cannot discover without being told | "Database admin URL is in DATABASE_ADMIN_URL env var" |
| Counterintuitive architecture | Agent would make wrong assumptions | "Routes are auto-registered -- do not manually add to app.ts" |
| Team conventions not in linter rules | Agent would use its own defaults | "Error responses use RFC 7807 Problem Details format" |

### Context that reliably HURTS

| Information type | Why it hurts | Example |
|---|---|---|
| Verbose directory trees | Wastes tokens; agent can run `ls` | A 50-line tree of every file in the project |
| Step-by-step for standard tasks | Constrains exploration; increases cost | "Step 1: run npm install. Step 2: ..." |
| Tool name-drops as preferences | 2.5x bias toward named tool | "Use ripgrep to search for X" |
| Restating what the code says | Stale within days; agent reads code | "The User model has fields: name, email, ..." |
| Obvious prerequisites | Agent discovers on failure | "Make sure Node.js is installed" |
| Exhaustive troubleshooting for common errors | Agent can read error messages | "If you see MODULE_NOT_FOUND, run npm install" |

### The staleness problem

Procedural context rots. When file paths change, APIs evolve, or tools update, procedural instructions become wrong -- and wrong instructions are worse than no instructions. Declarative context ("routes auto-register") stays true far longer than procedural context ("add your route to line 47 of app.ts").

---

## Principle 4: Structure Context for Scannability

Agents process context files in their entirety. Dense prose wastes tokens and buries important information. Structured formats with clear headings, tables, and short entries let agents extract what they need efficiently.

### Effective patterns

**Flat key-value conventions** -- easy to scan, hard to misinterpret:
```markdown
## Build & test
- Build: `make build-all` (builds core, then cli and mcp-server)
- Test: `make test` (all workspaces)
- Lint: `npx biome check --write .`
- Build order: core first, then cli and mcp-server (both depend on core)
```

**Tables for decision matrices** -- agents parse these well:
```markdown
| Situation | Action |
|---|---|
| New shared type | Add to packages/shared-types, rebuild, then use in frontend/backend |
| New API route | Add to src/routes/ (auto-registered), add types to shared-types |
| New env var | Add to .env.example with comment, document in AGENTS.md |
```

**Concise gotcha lists** -- high signal per token:
```markdown
## Gotchas
- `shared-types/src/index.ts` is auto-generated but can be manually edited
- `__dirname` in esbuild CJS bundle points to dist/, not source -- use existsSync fallback
- ESM import hoisting: `process.env.X = 'val'` before imports does not work
```

### Anti-patterns

- Walls of prose explaining things the agent can discover
- Deeply nested bullet points (flatten them)
- Lengthy examples when a one-line rule suffices
- Duplicating information that exists in README.md, package.json, or tsconfig.json

---

## Principle 5: Write for the Agent's Actual Failure Modes

The highest-value context addresses situations where agents predictably fail without guidance. Studying where agents actually go wrong reveals what to include:

### Common agent failure modes and what to document

**Wrong build order in monorepos**: Agents often try to build packages in the wrong order or skip rebuilding dependencies. Document the dependency graph and rebuild requirements.

**Choosing deprecated or wrong conventions**: When a project has migrated away from a pattern (e.g., Jest to Vitest, ESLint to Biome), agents may default to the old convention. State the current standard explicitly.

**Missing non-obvious side effects**: When changing file A requires also updating file B, and that relationship is not expressed in imports or configs, document it. "After modifying the API schema, regenerate the client types with `npm run codegen`."

**Environment-specific configuration**: Differences between dev, CI, and production that affect how code runs. "CI runners use Podman, not Docker" saves an entire debugging cycle.

**Undocumented internal APIs or conventions**: Custom error formats, logging patterns, authentication flows, or naming conventions that are team knowledge not captured in code.

---

## Checklist for Context File Authors

Before shipping a context file (AGENTS.md, CLAUDE.md, or dossier), review each line:

- [ ] **Can the agent figure this out by reading the codebase?** If yes, remove it. The agent can read files, run commands, and explore the project structure.
- [ ] **Am I describing *what* to achieve or *how* to do it?** Prefer *what*. Only include *how* when the procedure is genuinely non-obvious or the order matters for subtle reasons.
- [ ] **Does this mention a tool by name?** If so, is the tool a genuine constraint (the project requires it) or just a preference (any equivalent tool would work)? Remove preferences.
- [ ] **Will this information still be correct in 3 months?** Declarative facts ("strict TypeScript, ESM only") outlast procedural facts ("edit line 47 of config.ts"). Prefer information with a long shelf life.
- [ ] **Would an experienced developer joining the team need this information?** If an experienced dev would figure it out in 5 minutes, the agent probably will too. Focus on what takes the experienced dev time to discover.
- [ ] **Does the Validation section have clear, verifiable success criteria?** If the context file is a dossier, this is the most important section. Invest time here.
- [ ] **Is this the right length?** A context file that fits in one screen is more likely to be fully processed. Aim for the minimum effective dose of information.

---

## Applying These Principles to Different Context File Types

### AGENTS.md / CLAUDE.md

These are project-level context files read automatically by coding agents. They should be:

- **Short**: One screen is ideal. Two screens is acceptable. Beyond that, the signal-to-noise ratio drops.
- **Focused on non-obvious facts**: Build commands, conventions that differ from defaults, known gotchas.
- **Updated when the project changes**: Stale instructions are worse than no instructions. If you change your build system, update AGENTS.md in the same commit.

### System prompts

System prompts configure agent behavior at a higher level than project context files. They should:

- **Set behavioral boundaries, not task procedures**: "Never modify files outside the project directory" is a good system prompt instruction. "To create a component, first create the file, then add imports..." is not.
- **Establish output format expectations**: Response structure, code style preferences, communication tone.
- **Define safety constraints**: What the agent should never do, what requires approval.

### Dossiers

Dossiers are structured, verifiable context for specific tasks. They should follow the same declarative principles:

- **Objective**: Clear, measurable, unambiguous
- **Constraints**: What the agent cannot infer
- **Known Pitfalls**: Traps that would cost significant debugging time
- **Validation**: Concrete checks the agent can run to verify success

Avoid filling dossier bodies with step-by-step Actions sections that replicate what the agent would do naturally. The more prescriptive the dossier, the less room the agent has to adapt to the actual state of the project.

---

## Further Reading

- [Authoring Guidelines](../../docs/guides/authoring-guidelines.md) -- Detailed guidelines for dossier authors
- [Fourrier et al., 2026](https://arxiv.org/abs/2602.11988) -- "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?"
- [REFERENCES.md](../../REFERENCES.md) -- Full list of academic references
