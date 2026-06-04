# Using Dossier with Claude Code

**Last Updated**: 2025-11-28
**Status**: Active

---

## Overview

The Dossier MCP Server integrates directly with Claude Code, enabling you to execute and create dossiers through natural conversation.

## Quick Start

### 1. Build the MCP Server (for local development)

```bash
cd /path/to/dossier/mcp-server
npm install
npm run build
```

### 2. Install the MCP Server

Use the Claude Code CLI to add the MCP server:

**Option A: Global Installation** (available across all projects)

```bash
# For local development (replace path with your actual path)
claude mcp add dossier --scope user -- node /path/to/dossier/mcp-server/dist/index.js

# After NPM package is published
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server
```

**Option B: Project-Only Installation** (for a specific project)

Create a `.mcp.json` file in your project root:

```json
{
  "mcpServers": {
    "dossier": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dossier/mcp-server/dist/index.js"]
    }
  }
}
```

### 3. Verify Installation

Check that the server is configured:

```bash
claude mcp list
```

Then ask Claude:
```
What dossier tools are available?
```

Claude should list the available tools, resources, and prompts.

---

## Available Prompts

The MCP server provides two prompts accessible via Claude Code's prompt picker:

### `execute-dossier`

Run a dossier with full verification and protocol compliance.

**Arguments:**
- `dossier_path` (required): Path or URL to the dossier file

**What Claude Does:**
1. Verifies integrity (checksum) and signature
2. Reads the dossier content
3. Follows the instructions step by step
4. Reports results

### `create-dossier`

Author a new dossier using the official template.

**Arguments:**
- `title` (required): Title for the new dossier
- `category` (optional): Category (e.g., devops, authoring)
- `risk_level` (optional): Risk level: low, medium, high, critical

**What Claude Does:**
1. Executes the official meta-dossier template
2. Guides you through proper frontmatter structure
3. Helps calculate checksum after completion
4. Optionally assists with signing

---

## Executing a Dossier

### Method 1: Natural Language

Simply ask Claude to execute a dossier:

```
Run the dossier at examples/devops/deploy-to-aws.ds.md
```

```
Execute https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/authoring/create-dossier.ds.md
```

### Method 2: Using the Prompt

Use the `execute-dossier` prompt directly with the path argument.

### Execution Protocol

Claude will follow the Dossier Execution Protocol:

1. **VERIFY** - Check integrity and signature
   - If verification fails: STOP and report the issue
   - If signature is from untrusted source: Ask whether to proceed

2. **READ** - Get the dossier content and metadata

3. **EXECUTE** - Follow the instructions
   - Respect risk_level warnings
   - Ask for confirmation before destructive operations
   - Report progress on each step

4. **REPORT** - Summarize what was accomplished

---

## Creating a Dossier

### Method 1: Natural Language

Ask Claude to create a new dossier:

```
Create a dossier for setting up our CI/CD pipeline
```

```
Help me create a high-risk dossier for database migration
```

### Method 2: Using the Prompt

Use the `create-dossier` prompt with:
- `title`: "CI/CD Pipeline Setup"
- `category`: "devops"
- `risk_level`: "medium"

### What Happens

Claude will:
1. Reference the official meta-dossier at `examples/authoring/create-dossier.ds.md`
2. Guide you through creating proper frontmatter
3. Help structure the instructions
4. Calculate the checksum when done
5. Optionally assist with signing

---

## Available Tools

The MCP server also provides these tools that Claude can use:

| Tool | Description |
|------|-------------|
| `verify_dossier` | Check integrity (checksum) and authenticity (signature) |
| `read_dossier` | Get dossier content and metadata |
| `list_dossiers` | List dossiers in a directory |

---

## Available Resources

Claude can access these resources for context:

| Resource | Description |
|----------|-------------|
| `dossier://concept` | What are dossiers? |
| `dossier://protocol` | How to execute dossiers safely |
| `dossier://security` | Security architecture and trust model |

---

## Dossiers as Claude Code Skills

A dossier can be installed as a [Claude Code Skill](https://code.claude.com/docs/en/skills) so it's discovered and invoked automatically by natural language, no MCP prompt required:

```bash
ai-dossier install-skill imboard-ai/git/full-cycle-issue-skill
```

This writes the dossier to `~/.claude/skills/<name>/SKILL.md`. From then on, Claude routes to it whenever a request matches its `description`.

### The Trigger-Skill Pattern

A **trigger skill** is a thin `SKILL.md` that exists only for **discovery + routing**. When matched, it hands off to an **executable dossier** — the heavy, versioned procedure — loaded at runtime via `ai-dossier run`. The trigger stays tiny so Claude can hold many of them with minimal context cost.

```
┌─────────────────────────┐        ai-dossier run        ┌──────────────────────────┐
│  Trigger skill          │ ───────────────────────────▶ │  Executable dossier      │
│  ~/.claude/skills/…     │   (loaded only when matched)  │  imboard-ai/…@version    │
│  • name + description   │                               │  • full procedure        │
│  • flag parsing         │                               │  • all phases / steps    │
│  • one `run` call       │                               │  • versioned separately  │
└─────────────────────────┘                               └──────────────────────────┘
```

**Why split it — the motivation.** Claude Code loads skills by *progressive disclosure*, in three tiers ([docs](https://code.claude.com/docs/en/skills)):

1. **Discovery (always resident):** only each skill's `name` + `description` stay in context (the combined `description`/`when_to_use` is capped at ~1,536 characters). This is the cost you pay for *every* installed skill, all the time.
2. **Activation (on trigger):** when a request matches, the **entire** `SKILL.md` body loads as a single message and **stays for the rest of the session** — there is no partial loading of one `SKILL.md`.
3. **Execution (on demand):** content the body *references* (separate files, or — in our case — a registry dossier fetched with `ai-dossier run`) loads only when actually needed.

So a fat, self-contained skill spends its whole body on tier 2 the moment it fires. A **trigger skill pushes the weight down to tier 3**: the always-resident footprint is just the description, and the heavy procedure only enters context when the work actually starts — and can be versioned, signed, and reused independently of the trigger.

**When to use a trigger skill vs. a whole skill:**

| Use a **trigger skill → executable dossier** when… | Keep it a **whole skill** when… |
| --- | --- |
| The procedure is multi-stage or long (Anthropic recommends keeping `SKILL.md` **under ~500 lines**) | It's a short, self-contained procedure |
| The same procedure is reused by several entry points, or one entry point composes several dossiers | It runs top-to-bottom and a run uses most of the body |
| The procedure is versioned/shared via the registry and you want the trigger decoupled from its content | There's nothing to reuse or version separately |

A whole skill is *not* a context tax just by existing — its body only loads on trigger. So split for **multi-stage orchestration, reuse, or independent versioning**, not merely for size.

### Anatomy of a trigger skill

The trigger does three things: parse flags, call `ai-dossier run`, and tell Claude to follow the output. Everything substantive lives in the executable dossier. Example — `full-cycle-issue-skill` (≈56 lines) fronting the `imboard-ai/git/full-cycle-issue` dossier:

```markdown
# Full Cycle Issue

## Flags
- `--base <branch>`: Override the target branch

## Steps
1. Extract the issue number from the user's request
2. Run: `ai-dossier run imboard-ai/git/full-cycle-issue --pull`
3. If `--base` was provided, pass it as the base_branch parameter
4. Follow ALL phases in the workflow output. Do not skip any.
```

The 800+ lines of actual workflow live in the dossier, fetched only when the skill fires. Bump the dossier's version and every trigger pointing at it picks up the change on its next run — no skill reinstall needed.

## Troubleshooting

### "Signature verification failed"

The dossier may be from an untrusted source. Options:

1. **Add the signer's key** (if you trust them):
   ```bash
   dossier keys add "<public_key>" "<identifier>"
   ```

2. **Proceed anyway** (with caution):
   - Claude will ask if you want to proceed with an unsigned dossier
   - Review the dossier content before agreeing

### "Checksum mismatch"

The dossier content has been modified since it was signed.

**DO NOT EXECUTE** - the content may have been tampered with.

Ask the dossier author for an updated, properly signed version.

### "MCP server not responding"

1. Check the server is configured: `claude mcp list`
2. Verify the MCP server is built: `cd mcp-server && npm run build`
3. Remove and re-add: `claude mcp remove dossier && claude mcp add dossier --scope user -- node /path/to/dist/index.js`
4. Check logs for errors

### "Unknown tool/prompt"

Ensure you're using the latest version of the MCP server:
```bash
cd mcp-server
git pull
npm install
npm run build
```

---

## Examples

### Execute a Remote Dossier

```
Execute the dossier at https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/development/add-git-worktree-support.ds.md
```

### Create a DevOps Dossier

```
Create a dossier called "Deploy to Production" with risk level high and category devops
```

### List Available Dossiers

```
What dossiers are available in this project?
```

### Verify Before Executing

```
First verify, then execute the dossier at ./my-automation.ds.md
```

---

## Security Best Practices

1. **Always let Claude verify** - Don't skip verification for convenience
2. **Review high-risk dossiers** - Read the instructions before confirming execution
3. **Trust keys carefully** - Only add public keys from sources you trust
4. **Check signatures** - Prefer signed dossiers from trusted authors
5. **Understand risk levels** - High/critical dossiers deserve extra scrutiny

---

## Related Documentation

- [Claude Code Skills](https://code.claude.com/docs/en/skills) - Official skill authoring + progressive disclosure
- [Signing Dossiers](./signing-dossiers.md) - How to sign your own dossiers
- [MCP Server README](../../mcp-server/README.md) - Full MCP server documentation
- [Security Architecture](../../security/ARCHITECTURE.md) - Security model details
- [Dossier Protocol](../reference/protocol.md) - Complete execution protocol

---

## Changelog

### 2026-06-04
- Added "Dossiers as Claude Code Skills" section
- Documented the **Trigger-Skill Pattern** (thin trigger skill → executable dossier) and its motivation via progressive disclosure

### 2025-11-28
- Initial guide created
- Documented execute-dossier and create-dossier prompts
- Added troubleshooting section
- Updated installation to use `claude mcp add` CLI command

---

**Questions or Issues?**
- GitHub Discussions: https://github.com/imboard-ai/ai-dossier/discussions
- Security Issues: security@imboard.ai
