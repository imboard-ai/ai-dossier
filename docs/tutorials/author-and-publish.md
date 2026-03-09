# Author and Publish

Create a dossier, validate it, add a checksum, and publish it to the registry.

## Prerequisites

- Node.js 20+ installed
- The CLI installed: `npm install -g @ai-dossier/cli`
- A project directory to work in

## Step 1: Scaffold a Dossier

```bash
ai-dossier create setup-dev-environment
```

This creates `setup-dev-environment.ds.md` with the standard template. Open it in your editor.

## Step 2: Write the Dossier

Replace the template content with your own. Here is a minimal example:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Setup Dev Environment",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "stable",
  "objective": "Configure a local development environment with all dependencies and tooling",
  "category": ["development"],
  "tags": ["setup", "environment"],
  "risk_level": "low",
  "risk_factors": ["creates_files", "modifies_files"],
  "destructive_operations": []
}
---

# Setup Dev Environment

## Objective

Configure the local development environment so that the project builds, tests pass, and the dev server starts.

## Constraints

- Use the package manager already configured in the project (check for lock files)
- Do not modify existing source code
- Environment variables should go in `.env.local` (gitignored), not `.env`

## Known Pitfalls

- If the project uses a `.nvmrc` or `.node-version` file, switch to the specified Node version before installing dependencies. Mismatched versions cause native module build failures that are hard to debug.

## Validation

- [ ] `npm test` (or equivalent) passes with zero failures
- [ ] Dev server starts without errors
- [ ] No uncommitted changes to tracked files (only new gitignored files)
```

Key authoring principles:
- State **what** to achieve, not **how** to do it step-by-step
- Include **constraints** the agent cannot infer from the codebase
- Document **known pitfalls** that would waste time
- Write **validation** criteria that are concrete and verifiable

See the [Authoring Guidelines](../guides/authoring-guidelines.md) for detailed guidance.

## Step 3: Validate

Check that the dossier format is correct:

```bash
ai-dossier validate setup-dev-environment.ds.md
```

Fix any errors the validator reports (missing required fields, invalid values, etc.).

## Step 4: Add a Checksum

Checksums let consumers verify the dossier content has not been tampered with:

```bash
ai-dossier checksum setup-dev-environment.ds.md --update
```

This writes a `checksum` field into the frontmatter. Verify it:

```bash
ai-dossier checksum setup-dev-environment.ds.md --verify
```

## Step 5: Test with an AI

Before publishing, run the dossier with your AI assistant to verify it works.

**With the MCP server (Claude Code):**

```
Execute the dossier at setup-dev-environment.ds.md
```

**Without MCP (any LLM):**

Copy the file content and paste it with:

```
This is a dossier. Please execute it step-by-step and validate the success criteria.
```

Iterate on the dossier content until the AI produces the expected result.

## Step 6: Publish

Authenticate with the registry:

```bash
ai-dossier login
```

Publish:

```bash
ai-dossier publish setup-dev-environment.ds.md
```

Your dossier is now discoverable via `ai-dossier search` and the [Dossier Registry](https://registry.dossier.dev).

## Lifecycle Summary

```
create  -->  write  -->  validate  -->  checksum  -->  test  -->  publish
                ^                                        |
                |                                        |
                +----------  iterate  <------------------+
```

## Next Steps

- Browse the [Dossier Registry](https://registry.dossier.dev) to see published dossiers
- Read the [Dossier Guide](../guides/dossier-guide.md) for the full schema reference
- Learn about [signatures and security](../explanation/security-model.md) for signing dossiers
