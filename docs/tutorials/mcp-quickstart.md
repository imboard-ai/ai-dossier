# MCP in 60 Seconds

Add dossier support to Claude Code and start using dossiers immediately.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js 20+ installed

## Step 1: Add the MCP Server

Run this single command:

```bash
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server
```

This registers the dossier MCP server globally so it is available in every project.

Verify it was added:

```bash
claude mcp list
```

You should see `dossier` in the output.

## Step 2: Use It

Open Claude Code in any project and try these prompts:

**List dossiers in the current project:**

```
List available dossiers
```

**Search the public registry:**

```
Search for dossiers about deployment
```

**Run a dossier from a URL:**

```
Run the dossier at https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/guides/context-engineering-best-practices.ds.md
```

**Run a local dossier:**

```
Execute the dossier at ./dossiers/setup-environment.ds.md
```

That's it. Claude Code now understands dossiers natively -- it can discover, verify, and execute them without copy-pasting URLs or reading documentation first.

## What Just Happened?

The MCP server gives Claude Code several capabilities:

- **`list_dossiers`** -- find `.ds.md` files in your project
- **`search_dossiers`** -- search the public registry by keyword
- **`read_dossier`** -- parse and return dossier content
- **`verify_dossier`** -- check integrity (checksums) and authenticity (signatures)
- **`resolve_graph`** / **`start_journey`** -- orchestrate multi-dossier workflows

See the [MCP Server README](../../mcp-server/README.md) for the full tool reference.

## Alternative: Claude Desktop

If you use Claude Desktop instead of Claude Code, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

## Next Steps

- [Author and Publish](./author-and-publish.md) -- create your own dossier and publish it to the registry
- [Your First Dossier](./your-first-dossier.md) -- deeper walkthrough of dossier structure and the CLI
