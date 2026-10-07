---
name: 'create-dossier'
description: 'Guide an agent to create well-structured dossier markdown files that other agents will execute successfully'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Create New Dossier'
  dossier.version: '1.2.1'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Stable'
  dossier.last_updated: '2026-08-14'
  dossier.objective: 'Guide an agent to create well-structured dossier markdown files that other agents will execute successfully'
  dossier.category: '["documentation"]'
  dossier.tags: '["meta","authoring","dossier"]'
  dossier.risk_level: 'low'
  dossier.risk_factors: '["modifies_files"]'
  dossier.requires_approval: 'false'
  dossier.content_scope: 'self-contained'
  dossier.authors: '[{"name":"Yuval Dimnik <yuval.dimnik@gmail.com>"}]'
  dossier.checksum: '{"algorithm":"sha256","hash":"0c1c5cef81cf23d01e14daae38784f005f735f1800ae0b05e7ced953b2566003"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"YhMd0PvAdycc2Zot+uJuiL/QxREqNiVnPlXml4/c3NB5vEEgVa7ZytiPYDywoUXylbpL1IrKGTqwobelodx5CA==","signed_at":"2026-10-07T12:03:36.041Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
---

# Create New Dossier

You are a dossier author. Your job is to create clear, specific instructions that another agent will execute successfully. The quality of your dossier directly determines the quality of that agent's output.

## Your Task

1. Understand what the user wants the dossier to accomplish
2. Write a well-structured dossier markdown file (`.md`)
3. Save the file and provide CLI next steps to the user

## Before Writing

You MUST understand:

1. **The task** - What should the executing agent accomplish?
2. **The output** - What artifact or report should it produce?

Optional but helpful:

3. **Reference dossiers** - Examples to follow

Do not ask more than 2-3 questions. If requirements are unclear, make reasonable assumptions and state them explicitly in the dossier.

## Writing the "Your Task" Section

This is the executing agent's north star - the first thing it reads. Make it:

- **Specific**: Not "analyze the code" but "identify functions over 50 lines that should be refactored"
- **Outcome-focused**: What should exist after the agent is done?
- **Scoped**: One clear task, not a list of tasks

**Bad:**
```markdown
## Your Task
Review the codebase and provide feedback.
```

**Good:**
```markdown
## Your Task
Identify the top 5 performance bottlenecks in the codebase and provide specific optimization recommendations for each, with estimated impact.
```

## Writing the Scope Section

Directly after "Your Task", state the boundary. An executing agent given a clear task and no boundary will widen it — investigating adjacent code, fixing what it was asked to report on, or continuing well past the point of usefulness.

Three lines:

```markdown
## Scope

**In scope:** [what to examine]
**Out of scope:** [the adjacent thing it will be tempted to pull in]
**Stop when:** [the completion condition]

Report findings only — do not modify code.
```

That last line matters for every analysis or review dossier. Without it, an agent that finds a fixable problem will fix it. Drop the line for dossiers that are meant to act.

## Writing the Main Sections

The main sections depend on what type of dossier you're creating:

### For Analysis/Review Dossiers

Use "Areas to Investigate" or "Patterns to Check". Break into numbered subsections with specific questions:

```markdown
## Areas to Investigate

### 1. Error Handling
- How are errors caught? (try/catch, Result types, error boundaries?)
- Are error messages user-friendly or technical stack traces?
- Is there consistent error logging?

### 2. Input Validation
- Where is user input validated? (frontend, backend, both?)
- Are there SQL injection or XSS vulnerabilities?
- What happens with malformed input?
```

### For Action/Setup Dossiers

Use "Steps to Perform" with numbered steps and validation checkpoints:

```markdown
## Steps to Perform

1. **Verify prerequisites**
   - Check Node.js version >= 18
   - Confirm database is accessible

2. **Install dependencies**
   - Run `npm install`
   - Verify no peer dependency warnings

3. **Validate installation**
   - [ ] All packages installed without errors
   - [ ] No security vulnerabilities in `npm audit`
```

## Writing the Output Format Section

**This is the most critical section.** Write it FIRST, then work backwards to the investigation sections.

Judge it by **specificity, not length**. The Output Format earns its space by removing ambiguity — exact headers, a consistent item structure, placeholders, one worked example. Once the executing agent cannot misread the structure, stop. Prose past that point makes the deliverable longer without making it clearer.

Then size the **deliverable**. An agent handed a structure and no sizes will fill every section generously:

```markdown
### Summary
[One paragraph, 3-5 sentences]

### Findings
[One entry per issue found — no cap. Report everything meeting the bar below.]

### Recommendations
[3-5 items, highest impact first]
```

Sections with a natural ceiling get a number. Sections that should be exhaustive say so **explicitly** — given no instruction, an executing agent infers a limit that you never set and silently drops findings.

### Bad Output Format (vague):

```markdown
## Output Format
Provide a summary of findings with recommendations.
```

The executing agent has no idea what structure to follow. It will produce inconsistent, hard-to-use output.

### Good Output Format (specific):

```markdown
## Output Format

### Summary
**Overall Assessment: [Good/Needs Work/Critical Issues]**

[One paragraph: key findings and overall health]

### Findings

#### Critical Issues
1. **[Issue name]**
   - Location: `file.ts:line`
   - Problem: [what's wrong]
   - Impact: [why it matters]
   - Fix: [how to resolve]

#### Warnings
[Same structure as Critical Issues]

### Recommendations

**Immediate (do now):**
1. [Most urgent fix]

**Short-term (this sprint):**
1. [Important improvement]

**Long-term (backlog):**
1. [Nice to have]
```

### Output Format Patterns

1. **Start with a score or assessment** - `[High/Medium/Low]`, `[Good/Needs Work/Critical]` gives immediate summary
2. **Use consistent item structure** - Every finding has: Location, Problem, Impact, Fix
3. **Show placeholders** - `[description]`, `file:line`, `[score]` tell the agent what to fill in
4. **Group by priority or severity** - Critical/Warning/Info or High/Medium/Low
5. **Include one complete example entry** - Remove all ambiguity about the expected format

## Writing the Instructions Section

End every dossier with `---` followed by `**Instructions:**`. This is final guidance on HOW to execute, not WHAT to do:

```markdown
---

**Instructions:**
- Prioritize [X] over [Y]
- Skip [things to ignore]
- If [edge case], then [how to handle]
- Include `file:line` references for all findings
- If everything looks good, say so - not every codebase has problems
```

The Instructions section should be actionable bullets, not a restatement of the task.

## Common Mistakes to Avoid

1. **Vague output format** - "Provide a summary" gives no structure. Always show the exact format.

2. **Too many tasks** - A dossier should do ONE thing well. If you're combining "security review" and "performance analysis", make two dossiers.

3. **Missing placeholders** - Without `[High/Medium/Low]` style markers, agents don't know what's variable vs literal.

4. **No example entries** - Show one fully completed item in your Output Format to remove ambiguity.

5. **Instructions that repeat the task** - The Instructions section is for HOW (prioritization, edge cases, tone), not WHAT (already covered in Your Task).

6. **Abstract section headers** - "Main Content" or "Analysis" are meaningless. Use specific headers like "Security Vulnerabilities to Check" or "Refactoring Candidates".

7. **No scope boundary** - A dossier that says what to do but never what to leave alone invites the agent to widen the task. State what's out of scope and when to stop.

8. **Unsized output sections** - A structure with no sizes gets filled generously everywhere. Give each section a length, an item count, or an explicit "no cap".

## Complete Example

Here's a complete dossier. Notice how the Output Format section is detailed and specific:

```markdown
# Dependency Health Check

You are analyzing the project's dependencies for security, maintenance, and upgrade risks.

## Your Task

Audit all dependencies and produce a prioritized report of security vulnerabilities, unmaintained packages, and recommended upgrades.

## Scope

**In scope:** Direct and transitive dependencies declared in the project's manifest and lockfile.
**Out of scope:** The project's own source code, CI configuration, and container base images.
**Stop when:** Every declared dependency has been classified, or the audit tooling fails and you have reported why.

Report findings only — do not upgrade packages or edit the manifest.

## Areas to Investigate

### 1. Security Vulnerabilities
- Run `npm audit` or equivalent
- Check for known CVEs
- Note severity levels (critical, high, medium, low)

### 2. Maintenance Status
- Last update date for each dependency
- Is the repository archived or abandoned?
- Open issues/PRs with no maintainer response?

### 3. Version Currency
- Major version upgrades available?
- Breaking changes involved?
- Risk level of each upgrade

### 4. Dependency Weight
- Heavy dependencies for simple tasks?
- Candidates for removal or replacement?

## Output Format

### Health Score
**Overall: [Healthy/Needs Attention/At Risk]**

[One paragraph, 3-5 sentences: dependency health and key concerns]

### Security Vulnerabilities

[One row per vulnerability — no cap. List every CVE found, at any severity.]

| Package | Severity | CVE | Description | Fix |
|---------|----------|-----|-------------|-----|
| lodash | High | CVE-2021-23337 | Prototype pollution | Upgrade to 4.17.21 |

*If no vulnerabilities: "No known security vulnerabilities found."*

### Unmaintained Packages

[One entry per package meeting the bar in Instructions — no cap.]

1. **[package-name]** - Last updated: [date]
   - Used for: [purpose in this project]
   - Risk: [what could go wrong]
   - Alternative: [suggested replacement or "none needed"]

*If none: "All dependencies are actively maintained."*

### Recommended Upgrades

**High Priority (security or critical fixes):**
- `package@current` → `package@latest` - [reason]

**Medium Priority (new features, bug fixes):**
- `package@current` → `package@latest` - [what's improved]

**Low Priority (minor updates):**
- [list packages, can be brief]

### Summary Recommendations

1. **Immediate:** [what to do today]
2. **This sprint:** [what to plan for]
3. **Later:** [what to track]

---

**Instructions:**
- Prioritize security vulnerabilities over version currency
- Only flag unmaintained packages if there's actual risk (archived repo, security issues)
- Don't recommend upgrades just for being current - there should be a reason
- If dependencies are healthy, say so clearly
- Include `package.json:line` references where relevant
```

## After You Write the File

Save the dossier as a `.md` file (not `.ds.md`). Then:

1. **Discover namespace info** - Run these commands to determine the best namespace:
   - `dossier list` - See existing dossiers and their namespace patterns
   - `dossier whoami` - Get the user's available org(s)

2. **Suggest namespace** - Based on the list output, recommend a namespace that:
   - Uses an org from `whoami` (the user can only publish to their orgs)
   - Follows existing category patterns (e.g., `development/testing/`, `development/security/`)
   - Groups related dossiers together

3. **Provide CLI commands** with the discovered values filled in:

**Signing convention (current, as of 2026-08-14): local ed25519, not KMS.** AWS KMS signing (`--method kms`, the CLI's default when `--key` is omitted) is deprecated for this org — do not sign new dossiers with it. Use a local ed25519 key instead: check `~/.dossier/*.pem` for an existing personal key first (do not generate a new one if one is already present, on this machine or a synced one — see the imboard-monorepo root `CLAUDE.md` sync note — each new key adds an entry to `trusted-keys.txt` that has to propagate everywhere dossiers get verified). If none exists, create one with `dossier keys generate --name <your-name>`, then register it with `dossier keys add <printed-public-key> "<your-name>"`. Sign with `dossier from-file --sign --key ~/.dossier/<your-name>.pem ...` (or `dossier sign <file> --method ed25519 --key <path>` for an already-created dossier). `dossier verify` resolves the matching public key from `trusted-keys.txt` automatically.

```
File saved to: [path]

Next steps to publish this dossier:

1. Create (adds metadata + signature, ed25519 not KMS):
   dossier from-file [your-file.md] \
     --name "[dossier-slug]" \
     --title "[Dossier Title]" \
     --objective "[What it accomplishes]" \
     --author "[Name from whoami] <[email]>" \
     --sign --key [path to your ~/.dossier/*.pem] --signed-by "[Name] <[email]>" \
     -o [output.ds.md]

2. Verify:
   dossier verify [output.ds.md]

3. Publish — always pass --namespace explicitly. Omitting it can land the
   dossier under a different top-level name instead of updating the
   existing one (observed: publishing without --namespace created a stray
   `imboard-ai/<name>` entry instead of updating `imboard-ai/skills/<name>`).
   Check `dossier info <existing-namespace>/<name>` first to confirm where
   the current version actually lives:
   dossier publish [output.ds.md] \
     --namespace "[suggested-namespace]" \
     --changelog "[Version description]"
```

---

**Instructions:**
- Write the Output Format section FIRST, then work backwards to create investigation sections that support it
- Give every Output Format section a size - a length, an item count, or an explicit "no cap"
- Always include a Scope section with an out-of-scope line and a stop condition
- If the user provides reference dossiers, match their structure and level of detail
- Keep each dossier focused on ONE task - suggest multiple dossiers if the user wants too much
- State assumptions explicitly if requirements were unclear
- Always end by saving the `.md` file and showing the CLI next steps
