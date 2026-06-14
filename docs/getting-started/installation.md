# Installation & Configuration

How to install the Dossier tooling and configure registries and authentication.

> Just want to run a dossier? See the [Quick Start](quick-start.md) — you don't need to install anything for the zero-install path.

---

## Install the CLI

```bash
# Install globally (provides the `ai-dossier` command)
npm install -g @ai-dossier/cli

# Or run without installing
npx @ai-dossier/cli verify <dossier-file-or-url>
```

Requires Node.js 20+.

---

## Add the MCP server (Claude Code)

One command gives Claude Code native dossier support — discover, verify, and run dossiers in conversation:

```bash
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server
```

Alternatives (plugin with auto-updates, or manual JSON config for Claude Desktop / other MCP clients) are in the [MCP server README](../../mcp-server/README.md). For the trigger-skill route (install dossiers as Claude Code skills), see [Using Dossier with Claude Code](../guides/claude-code-integration.md).

---

## Authentication

Authentication is only needed to publish to, or pull private dossiers from, a registry.

```bash
# Interactive login (opens browser)
ai-dossier login

# Non-interactive (CI/CD, agents)
export DOSSIER_REGISTRY_TOKEN=<your-token>
```

### Authentication troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Session expired. Run 'ai-dossier login' to re-authenticate.` | Token expired or revoked | Re-run `ai-dossier login` or set a fresh `DOSSIER_REGISTRY_TOKEN` |
| `Not logged in to registry '<name>'.` | No credentials for this registry | Run `ai-dossier login --registry <name>` |
| Login hangs or browser doesn't open | Non-interactive environment (CI, Docker, SSH) | Use `DOSSIER_REGISTRY_TOKEN` instead |
| `Failed to save credentials` | `~/.dossier/` is read-only or missing | See [credential troubleshooting](#credential-troubleshooting) |
| `DOSSIER_REGISTRY_TOKEN` ignored | Token set after the CLI process started | Export the variable before running the command |

For CI/CD, always use the environment variable:

```bash
export DOSSIER_REGISTRY_TOKEN="${DOSSIER_TOKEN}"   # from your CI secrets
ai-dossier publish my-dossier.ds.md
```

---

## Registry configuration

By default the CLI uses the public Dossier registry (`https://dossier-registry.vercel.app`). Teams can add registries in `~/.dossier/config.json`:

```json
{
  "registries": {
    "public": {
      "url": "https://dossier-registry.vercel.app",
      "default": true
    },
    "internal": {
      "url": "https://dossier.internal.example.com"
    }
  }
}
```

Or per-project via `.dossierrc.json` in your project root (good for team-shared settings):

```json
{
  "registries": {
    "team": { "url": "https://dossier.myteam.example.com" }
  },
  "defaultRegistry": "team"
}
```

Authenticate per registry:

```bash
ai-dossier login                      # default registry
ai-dossier login --registry internal  # named registry
```

### Viewing configured registries

```bash
# Human-readable
ai-dossier config --list-registries

# Machine-readable JSON (for scripts and agents)
ai-dossier config --list-registries --json
```

If an error says a registry was not found, run `--list-registries` to verify the name. See the [CLI README](../../cli/README.md#registry-configuration) for full details.

---

## Credential troubleshooting

### "insecure permissions" warning

The CLI stores tokens in `~/.dossier/credentials.json` with `0600` permissions. If loosened, you'll see a warning; fix with:

```bash
chmod 600 ~/.dossier/credentials.json
```

The CLI also attempts to fix this automatically.

### "Failed to save credentials"

The CLI couldn't write the credentials file after login:

1. Ensure `~/.dossier/` exists and is writable:
   ```bash
   mkdir -p ~/.dossier && chmod 700 ~/.dossier
   ```
2. In containers/CI with a read-only home, use a token instead:
   ```bash
   export DOSSIER_REGISTRY_TOKEN=<your-token>
   ```

See the [CLI README troubleshooting](../../cli/README.md#troubleshooting) for more.

---

## Next steps

- [Quick Start](quick-start.md) — run your first dossier
- [Author your first dossier](../tutorials/your-first-dossier.md)
- [Using Dossier with Claude Code](../guides/claude-code-integration.md) — MCP and trigger skills
- [FAQ](../explanation/faq.md) — common questions and comparisons
