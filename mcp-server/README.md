# @ai-dossier/mcp-server

[![npm version](https://img.shields.io/npm/v/@ai-dossier/mcp-server)](https://www.npmjs.com/package/@ai-dossier/mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/mcp-server)](https://www.npmjs.com/package/@ai-dossier/mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

MCP server for the dossier automation standard. Enables LLMs to discover, verify, and execute dossiers through the [Model Context Protocol](https://modelcontextprotocol.io/).

## Installation

### Claude Code Plugin (Recommended)

```
/plugin marketplace add imboard-ai/ai-dossier
/plugin install dossier-mcp-server@ai-dossier
```

One-time setup — auto-updates included.

### Claude Code (Manual)

```bash
# Global (available across all projects)
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server

# Project-only
claude mcp add dossier -- npx @ai-dossier/mcp-server
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Verify

```bash
claude mcp list
```

Then try:
```
"List available dossiers in this project"
"Execute the project-init dossier"
```

---

## Tools

### Discovery & Reading

| Tool | Description |
|------|-------------|
| `list_dossiers` | Discover available dossiers in a directory. Scans for `*.ds.md` files and returns metadata. |
| `read_dossier` | Read and parse a dossier file. Returns metadata and content. Should be called after `verify_dossier` passes. |
| `search_dossiers` | Search the dossier registry for available dossiers by keyword and optional category filter. |

### Security Verification

| Tool | Description |
|------|-------------|
| `verify_dossier` | Verify integrity (checksum) and authenticity (signature) of a single dossier. Returns pass/fail with stage details. |
| `verify_graph` | Batch verify all dossiers in a resolved dependency graph. Returns aggregate security report with per-dossier breakdown. |

### Orchestration (Multi-Dossier Journeys)

| Tool | Description |
|------|-------------|
| `resolve_graph` | Resolve a dossier dependency graph into an execution plan. Produces a DAG with ordered phases, parallel groups, and conflict detection. |
| `start_journey` | Start a journey session from a resolved and verified graph. Returns the first step's dossier content with injected context. |
| `step_complete` | Mark the current journey step as complete or failed. Advances to the next step with context from previous outputs. |
| `get_journey_status` | Get the current state of a journey: completed steps, current step, remaining steps, and collected outputs. |
| `cancel_journey` | Cancel an active journey session. Returns a summary of what completed before cancellation. |

---

## Resources

| URI | Description |
|-----|-------------|
| `dossier://concept` | Introduction to dossiers — what they are and why to use them |
| `dossier://protocol` | How to execute dossiers safely and effectively |
| `dossier://security` | Security model, signing, verification, and trust management |
| `dossier://orchestration` | Complete reference for multi-dossier journey tools |

---

## Prompts

| Prompt | Description |
|--------|-------------|
| `execute-dossier` | Run a dossier with verification and protocol. Automatically chooses single or multi-dossier flow based on relationships. |
| `execute-journey` | Guide through a multi-step dossier journey: resolve, verify, present plan, execute steps, collect outputs. |
| `create-dossier` | Author a new dossier using the official meta-dossier template. |

---

## Security

Every dossier execution is verified before running:

```
User: "Execute the deploy-to-aws dossier"

LLM:  *Calls verify_dossier*

      Security Verification:
      - Integrity: Checksum verified (content not tampered with)
      - Authenticity: Signed by imboard-ai-2024 (trusted)
      - Risk Level: HIGH

      This dossier will modify AWS infrastructure.
      Proceed? (y/N)
```

### Verification results

- **ALLOW** — Verified signature from trusted source + low risk. Execute confidently.
- **WARN** — Unsigned/unknown signer or high risk. Request user approval.
- **BLOCK** — Checksum failed or signature invalid. Do not execute.

### Features

- **Integrity**: SHA256 checksums ensure dossiers haven't been modified
- **Signatures**: Optional minisign cryptographic signatures
- **Risk assessment**: Declared risk level and specific risk factors per dossier
- **Trust model**: Decentralized — users choose which signing keys to trust via `~/.dossier/trusted-keys.txt`

---

## Development

```bash
git clone https://github.com/imboard-ai/ai-dossier.git
cd ai-dossier/mcp-server
npm install
npm run build
npm test
npm start
```

### Project structure

```
mcp-server/
  src/
    index.ts                 # Server entry point
    tools/                   # Tool implementations
    resources/               # Resource providers
    orchestration/           # Graph resolution, sessions, output mapping
    utils/                   # Logger, CLI wrapper, response helpers
```

---

## Technical Details

- **Protocol**: MCP (Model Context Protocol)
- **Language**: TypeScript
- **Runtime**: Node.js 20+
- **Transport**: stdio
- **Dependencies**: `@modelcontextprotocol/sdk`, `@ai-dossier/core`
- **License**: AGPL-3.0

---

## For AI Agents

```bash
npm run build -w mcp-server    # build (requires core built first)
npm run test -w mcp-server     # test
make build-mcp                 # build core + mcp-server together
```

- `src/index.ts` — server entry: registers all tools, resources, and prompts
- `src/tools/` — one file per MCP tool (e.g. `verifyDossier.ts`)
- `src/resources/` — static MCP resources (concept, protocol, security, orchestration)
- `src/orchestration/` — graph resolution and journey session management
- `src/utils/` — logger, CLI wrapper, response helpers

**Adding a tool:** create `src/tools/myTool.ts`, export handler + input type, register in `src/index.ts` (add to ListTools + CallTool switch).

**Adding a resource:** create `src/resources/myResource.ts`, register in `src/index.ts` (add to ListResources + ReadResource switch).

**For dossier users (not contributors):** install via `claude mcp add dossier -- npx @ai-dossier/mcp-server` to get `dossier://` resources and tools at runtime. MCP Registry name: `ai.imboard/dossier`.

---

## Links

- [Specification](./SPECIFICATION.md)
- [Changelog](./CHANGELOG.md)
- [Dossier Standard](../README.md)
- [Examples](../examples/)
