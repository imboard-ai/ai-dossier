# Quick Start

Run your first dossier in **under 5 minutes**.

A dossier is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in. You don't have to teach your AI "what a dossier is"; modern agents already understand skills. You just point them at one.

> Need to install the CLI or MCP server, or configure a registry first? See [Installation & Configuration](installation.md).

---

## File conventions (10 seconds)

- **`.ds.md`** — dossier files (immutable instructions, checksummed)
- **`.dsw.md`** — working files (mutable execution state, not verified)
- **`---dossier`** — frontmatter delimiter holding JSON metadata (not YAML). See the [FAQ](../explanation/faq.md#what-do-the-dsmd-and-dswmd-file-extensions-mean).

---

## Three ways to run a dossier

### 1. MCP server — recommended for Claude Code

One command gives Claude Code native dossier support:

```bash
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server
```

Then just ask:

```
"List available dossiers"
"Run the scaffold-typescript-project dossier"
```

Claude Code discovers, verifies, and runs the dossier for you. ([MCP in 60 seconds →](../tutorials/mcp-quickstart.md))

### 2. Zero install — paste a URL into any LLM

Any LLM that can read a URL can run a dossier — no tooling required:

```
Run the dossier at:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/setup/scaffold-typescript-project.ds.md
```

Want to verify it first?

```bash
npx @ai-dossier/cli verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/setup/scaffold-typescript-project.ds.md
```

### 3. As a trigger skill — install it once, trigger by phrase

Install a published dossier as a Claude Code skill that fires on a phrase:

```bash
ai-dossier install-skill imboard-ai/skills/full-cycle-issue-skill
```

Restart Claude Code, then trigger it naturally ("full cycle issue 42"). The skill invokes the versioned, signed dossier behind it — verified before every run. ([How trigger skills work →](../guides/claude-code-integration.md#dossiers-as-claude-code-skills))

---

## What execution looks like

When an agent runs a dossier, it verifies integrity first, then works through the dossier's phases and checks its success criteria — adapting to your project as it goes:

```
Running: scaffold-typescript-project (verified ✓ checksum + signature)

  ✓ Detected package manager: pnpm
  ✓ Created tsconfig, src/, test/ layout
  ✓ Configured Biome + vitest
  ✓ Validation: `pnpm build` and `pnpm test` pass

Done.
```

The agent figures out the specifics (your package manager, your layout); the dossier supplies the goal, the constraints, and the success criteria.

---

## Next steps

- [Author your first dossier](../tutorials/your-first-dossier.md) — build one from scratch
- [Author and publish](../tutorials/author-and-publish.md) — turn a skill into a signed, distributable dossier
- [Browse examples](../../examples/) — real-world dossiers to copy
- [Isn't a dossier just a skill?](../explanation/faq.md#isnt-a-dossier-just-a-skill) and the rest of the [FAQ](../explanation/faq.md)
- [Authoring Guidelines](../guides/authoring-guidelines.md) — write dossiers agents follow well
