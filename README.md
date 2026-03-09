# Dossier — Automation Instructions for AI Agents

**Stop writing brittle scripts. Start writing instructions that AI executes intelligently.**

✅ Portable workflows that adapt to your project
✅ Built-in verification (checksums, signatures, success criteria)
✅ Works with Claude, ChatGPT, Cursor—any LLM

[![CI](https://github.com/imboard-ai/ai-dossier/actions/workflows/ci.yml/badge.svg)](https://github.com/imboard-ai/ai-dossier/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Spec](https://img.shields.io/badge/Dossier%20Spec-v1.0-blue)](docs/reference/README.md)
[![MCP Ready](https://img.shields.io/badge/MCP-Ready-brightgreen)](mcp-server)
[![Verification](https://img.shields.io/badge/Verification-Checksums%20%26%20Signatures-yellow)](docs/explanation/security-model.md)
[![GitHub](https://img.shields.io/github/stars/imboard-ai/ai-dossier?style=social)](https://github.com/imboard-ai/ai-dossier)

> **Quick Concept**
> Dossier turns plain-text instructions into executable workflows with built-in verification.
> Like Dockerfiles for AI automation—structured, portable, verifiable.

**New here?** → [5-min Quick Start](docs/getting-started/installation.md) | **Want to try now?** → [Get started in 30 seconds](#get-started)

---

## At a Glance

📝 **What**: Structured instruction files (`.ds.md`) that AI agents execute intelligently
🎯 **Why**: Replace brittle scripts with adaptive, verifiable automation that handles edge cases naturally
⚡ **How**: Create dossier → Run with your AI → Get validated results with evidence
🔒 **Safety**: Built-in checksums, cryptographic signatures, and CLI verification tools
🔗 **Multi-registry**: Configure multiple registries for teams and organizations
🌐 **Works with**: Claude, ChatGPT, Cursor, any LLM—no vendor lock-in

**Status**: Protocol v1.0 (stable spec) | CLI v0.8.0 | 15+ example templates | Active development

> **File conventions**: Dossiers use `.ds.md` (immutable instructions) and `.dsw.md` (mutable working files). Frontmatter uses `---dossier` (JSON) instead of `---` (YAML) to avoid parser conflicts. [Learn more](docs/explanation/faq.md#what-do-the-dsmd-and-dswmd-file-extensions-mean)

---

## Get Started

### 1. Run a dossier — zero install

Pick any LLM you already have and paste this:

```
Analyze my project using the dossier at:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/guides/context-engineering-best-practices.ds.md
```

That's it. The LLM reads the dossier and follows its instructions — no tools needed.

Want to verify it first?

```bash
npx @ai-dossier/cli verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/guides/context-engineering-best-practices.ds.md
```

### 2. Add the MCP server to Claude Code

One command gives Claude Code native dossier support — discover, verify, and execute dossiers without copy-pasting URLs:

```bash
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server
```

Then ask Claude: *"List available dossiers"* or *"Run the scaffold-typescript-project dossier"*.

<details>
<summary>Alternative: Claude Code plugin (auto-updates)</summary>

```
/plugin marketplace add imboard-ai/ai-dossier
/plugin install dossier-mcp-server@ai-dossier
```
</details>

<details>
<summary>Alternative: Manual JSON config (Claude Desktop or other MCP clients)</summary>

Add to `claude_desktop_config.json` or your MCP client's config file:

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
</details>

### 3. Create your own dossier

Initialize dossier in your project (sets up `~/.dossier/`, hooks, and MCP config):

```bash
npx @ai-dossier/cli init
```

Then create a dossier:

```bash
npx @ai-dossier/cli create my-workflow
```

This scaffolds a `.ds.md` file you can edit. A dossier is just Markdown with a JSON frontmatter block:

```markdown
---dossier
{
  "title": "My Workflow",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "draft",
  "objective": "Describe what this automates",
  "risk_level": "low"
}
---

# My Workflow

## Actions
1. Step one — what to do
2. Step two — what to verify

## Validation
- Expected outcome was achieved
```

See the [Authoring Guide](docs/guides/authoring-guidelines.md) for the full spec, or browse the [Dossier Registry](https://registry.dossier.dev) for real-world examples.

---

## Why Use Dossier?

**"How is this different from AGENTS.md files?"** Many projects already use files like `AGENTS.md` or `.cursorrules` for AI context. Here's the key distinction:

|  | AGENTS.md | Dossier |
|--|-----------|---------|
| **Purpose** | Project context & conventions | Executable workflow automation |
| **Validation** | None | Built-in success criteria |
| **Security** | None | Checksums + cryptographic signatures |
| **Portability** | Project-specific | Cross-project, shareable |
| **Tooling** | None | CLI verification, MCP integration |
| **Versioning** | Informal | Semantic versioning (v1.0.0) |

**They're complementary**: Use AGENTS.md to explain *your project*, use dossiers to automate *workflows*.

---

## Examples

| Example | Use Case |
|---------|----------|
| [Scaffold TypeScript Project](./examples/setup/scaffold-typescript-project.ds.md) | Scaffold a production-ready TS project with CI, testing, linting |
| [Context Engineering Best Practices](./examples/guides/context-engineering-best-practices.ds.md) | Reference guide for writing effective AI agent context files |

Browse the **[Dossier Registry](https://registry.dossier.dev)** for the full collection — DevOps, databases, data science, security, and more.

```bash
# Search from the CLI
npx @ai-dossier/cli search deploy
```

---

## Security & Verification

- Use the CLI tool (`ai-dossier verify`) to verify checksums/signatures before execution
- Prefer MCP mode for sandboxed, permissioned operations
- **External reference declaration**: Dossiers that fetch or link to external URLs must declare them in `external_references` with trust levels. The linter flags undeclared URLs, and the MCP server's `read_dossier` tool returns `security_notices` for any undeclared external URLs found in the body. This mitigates transitive trust risks from unvetted external content.
- See [SECURITY_STATUS.md](./SECURITY_STATUS.md) for current guarantees and limitations

---

## Registry & Multi-Registry Support

The CLI supports multiple registries for discovering, publishing, and sharing dossiers across teams and organizations.

- **Multi-registry**: Configure multiple registries (public, internal, mirrors) queried in parallel
- **HTTPS enforcement**: All registry URLs must use HTTPS to protect credentials in transit
- **Per-registry credentials**: Each registry has isolated authentication — a compromised token cannot access other registries
- **Project-level config**: Add a `.dossierrc.json` to your project for team-shared registry settings

```bash
# Add a private registry
dossier config --add-registry internal --url https://dossier.company.com

# List configured registries
dossier config --list-registries
```

See the [CLI documentation](./cli/README.md#config-command) for full registry management options.

---

## Adopter Playbooks

- **Solo Dev**: paste a `.ds.md` into your LLM and run via MCP or CLI
- **OSS Maintainer**: add `/dossiers` + a CI check that runs the Reality Check on your README
- **Platform Team**: start with init → deploy → rollback dossiers; wire secrets & scanners

👉 Detailed playbooks in [docs/guides/adopter-playbooks.md](docs/guides/adopter-playbooks.md)

---

## Documentation

| | |
|---|---|
| **Getting Started** | [Quick Start](docs/getting-started/installation.md) · [Your First Dossier](docs/tutorials/your-first-dossier.md) · [FAQ](docs/explanation/faq.md) |
| **Reference** | [Protocol](docs/reference/protocol.md) · [Specification](docs/reference/specification.md) · [Schema](docs/reference/schema.md) · [JSON Schema](./dossier-schema.json) |
| **Guides** | [Authoring Guidelines](docs/guides/authoring-guidelines.md) · [Dossier Guide](docs/guides/dossier-guide.md) · [Adopter Playbooks](docs/guides/adopter-playbooks.md) · [Examples](./examples/) |
| **Packages** | [CLI](./cli/) · [MCP Server](./mcp-server/) · [Core Library](./packages/core/) · [Registry](./registry/) |
| **Project** | [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) |

---

## Philosophy

> "Agents need structure. Dossiers provide it."

Dossiers embody this philosophy - they give AI agents clear structure and guidance, enabling them to intelligently automate complex workflows that would be brittle to script.

**The dossier standard** enables:
- **Adaptability**: LLMs understand context and adjust behavior
- **Maintainability**: Markdown documentation instead of complex scripts
- **Collaboration**: Clear, readable instructions anyone can contribute to
- **Continuous improvement**: Self-improving through the protocol
- **Universal adoption**: Any project, any workflow, any implementation

---

**🎯 Dossier: Universal LLM Automation Standard**
*Structure your agents. Not your scripts.*

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). You are free to use, copy, modify, and distribute it, provided that any modified versions or network services using this software also make their source code available under the same license.

## References

See [REFERENCES.md](REFERENCES.md) for the full list of academic references and industry research supporting the dossier approach.
