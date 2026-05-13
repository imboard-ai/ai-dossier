---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Setup Tracing",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-05-13",
  "objective": "Turn on execution tracing for dossier runs by writing a tracing block to the user (or project) Dossier config. After this dossier runs, `mcp-server` will start emitting traces to the configured registry on every journey, with no further setup required.",
  "category": [
    "setup",
    "monitoring"
  ],
  "tags": [
    "tracing",
    "configuration",
    "mcp",
    "observability"
  ],
  "tools_required": [],
  "risk_level": "medium",
  "requires_approval": false,
  "risk_factors": [
    "modifies_files"
  ],
  "destructive_operations": [
    "Writes ~/.dossier/config.json (preserves existing keys) or .dossierrc.json in the current project directory"
  ],
  "estimated_duration": {
    "min_minutes": 1,
    "max_minutes": 3
  },
  "inputs": {
    "required": [],
    "optional": [
      {
        "name": "url",
        "description": "Custom logger URL. Omit to use the user's logged-in registry (the default behavior).",
        "type": "string",
        "default": "",
        "example": "https://obs.imboard.corp"
      },
      {
        "name": "scope",
        "description": "Where to write the tracing block. 'user' writes ~/.dossier/config.json (default, applies to all projects). 'project' writes .dossierrc.json in the current directory (applies only to this project, can be checked into git).",
        "type": "string",
        "default": "user",
        "example": "user"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "~/.dossier/config.json",
        "description": "User config with tracing.enabled = true (when scope=user). Other keys preserved."
      },
      {
        "path": ".dossierrc.json",
        "description": "Project config with tracing block (when scope=project, in the current project directory)."
      }
    ]
  },
  "checksum": {
    "algorithm": "sha256",
    "hash": "bd7a1985c7f19d3591eff31f1e5f89746627333500a13509e872829741dd3903"
  }
}
---

# Setup Tracing

This dossier configures execution tracing for your dossier runs. After it
finishes, every journey that the dossier MCP server orchestrates will emit
a trace to the configured registry, visible via `ai-dossier traces list`.

The dossier deliberately handles the **environment-aware bits** — which
config file to touch, which token to reuse — so the platform can't be
locked to a single Claude / MCP-host shape.

## What it does, briefly

1. Verifies the user is logged in (`~/.dossier/credentials.json`).
2. Picks a target file based on `scope` (user-level by default).
3. Reads the existing JSON (preserving every other key).
4. Sets `tracing.enabled = true` and `tracing.url` (if a custom URL was
   given).
5. Writes the file back with `mode: 0o600`.
6. Tells the user to restart their MCP host so the new env takes effect.

## Prerequisites

- `~/.dossier/credentials.json` exists and has a non-expired `public`
  entry (or the registry the user wants traces to go to). If not, instruct
  the user to run `ai-dossier login` first and stop.
- For `scope=project`, the current working directory should be the project
  root. Confirm with the user before writing if cwd doesn't look like a
  project.

## Step-by-step

**Step 1: Verify login.**

Read `~/.dossier/credentials.json`. If it doesn't exist, the file is
empty, or `expires_at` is in the past for the relevant registry entry,
stop and report:

> ❌ Not logged in (or token expired). Run `ai-dossier login` first.

**Step 2: Resolve target path.**

- If `scope` input is `"project"` (or the user explicitly asks for project
  scope), the target is `<cwd>/.dossierrc.json`.
- Otherwise, the target is `~/.dossier/config.json`.

Print the resolved path back to the user before continuing.

**Step 3: Read existing file (if any).**

If the target file exists, read it and parse as JSON. If parsing fails,
stop and ask the user to fix or remove the file manually — never
overwrite a file you can't parse.

If the target file does not exist, start from an empty object `{}`.

**Step 4: Merge the tracing block.**

Set `tracing.enabled` to `true`. If the optional `url` input was given,
set `tracing.url` to that value. Otherwise leave `tracing.url` absent so
the resolver falls back to the logged-in registry's URL.

Preserve every other key in the file as-is (do NOT touch `defaultLlm`,
`registries`, `theme`, etc.).

**Step 5: Write the file.**

Write the merged JSON back with `mode: 0o600` (user-readable only). The
existing config directory `~/.dossier/` is already mode `0o700` so this
just inherits the same security posture.

**Step 6: Verify by re-reading.**

Read the file back, parse it, confirm `tracing.enabled === true`, print
the effective tracing block to the user.

**Step 7: Tell the user what to do next.**

> ✅ Tracing enabled. Restart your MCP host (Claude Desktop / Code) so
> the dossier MCP server picks up the new config. After your next
> journey runs, `ai-dossier traces list` will show it.

## Validation

After step 6, the success condition is a single re-read of the target
file showing `tracing.enabled === true`. If any of the file operations
errored (permission denied, disk full), stop and report the underlying
error verbatim — don't try to recover.

## Out of scope

- This dossier does NOT write a token into the config file. The token is
  always resolved from `~/.dossier/credentials.json` (via the user's
  existing `ai-dossier login`) or `DOSSIER_TRACE_TOKEN` env var at
  runtime.
- This dossier does NOT modify the user's MCP host config (Claude
  Desktop / Code settings). The resolver inside `mcp-server` reads the
  Dossier config directly, so no host-side edits are needed.
- For self-hosted org loggers that need a different auth scheme (not the
  registry JWT), fork this dossier and update step 4 to also set
  `tracing.token_env_var` or similar — but be careful not to write secrets
  to the file directly.
