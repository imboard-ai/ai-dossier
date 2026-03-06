# Dossier CLI - Security Verification Tool

**Enforce cryptographic verification before executing dossiers.**

## The Problem This Solves

**Reality**: LLMs cannot be relied upon to enforce security checks automatically.

Even with MCP server installed and protocol documentation:
- ❌ LLMs may skip verification
- ❌ No automatic enforcement mechanism
- ❌ Security depends on LLM "remembering" to check

**This CLI provides**: Mandatory verification enforced by code, not suggestions.

---

## Installation

### Option 1: NPM (Recommended)

Install globally:
```bash
npm install -g @ai-dossier/cli
```

Or use without installing:
```bash
npx @ai-dossier/cli <file-or-url>
```

### Option 2: From Source (Development)

```bash
cd cli
npm link  # Links the CLI globally for development

# Or use directly
chmod +x bin/ai-dossier
./bin/ai-dossier verify <file-or-url>
```

---

## Authentication

### Interactive (Browser OAuth)

```bash
dossier login
```

### Non-Interactive (CI/CD, Agents)

Set the `DOSSIER_REGISTRY_TOKEN` environment variable:

```bash
export DOSSIER_REGISTRY_TOKEN=<your-token>

# Optional: set user/org context
export DOSSIER_REGISTRY_USER=<username>
export DOSSIER_REGISTRY_ORGS=org1,org2
```

When `DOSSIER_REGISTRY_TOKEN` is set, it takes precedence over stored credentials. This is recommended for CI/CD pipelines, Docker containers, and AI agent contexts where interactive login is not possible.

Commands that require confirmation (`publish`, `remove`, `cache clean`) will fail with a clear error in non-interactive sessions. Use `-y`/`--yes` to skip confirmation prompts.

---

## Usage

### Basic Verification

```bash
# Verify local file
ai-dossier verify path/to/dossier.ds.md

# Verify remote dossier
ai-dossier verify https://example.com/dossier.ds.md
```

**Exit codes**:
- `0` - Verification passed (safe)
- `1` - Verification failed (unsafe)
- `2` - Error occurred

### Verbose Mode

```bash
ai-dossier verify --verbose path/to/dossier.ds.md
```

Shows:
- Dossier metadata (title, version, risk level)
- Detailed checksum comparison
- Signature verification details
- Complete risk assessment

### Integration with LLM Tools

**Claude Code**:
```bash
# Shell function wrapper
claude-run-dossier() {
  if ai-dossier verify "$1"; then
    claude-code "The dossier at $1 has been verified. Please execute it."
  else
    echo "❌ Security verification failed. Not executing."
  fi
}

# Use it
claude-run-dossier https://example.com/dossier.ds.md
```

**Cursor**:
```bash
cursor-run-dossier() {
  if ai-dossier verify "$1"; then
    cursor "Execute the verified dossier at $1"
  else
    echo "❌ Verification failed"
    return 1
  fi
}
```

**Any LLM Tool**:
```bash
safe-run-dossier() {
  local url="$1"
  local tool="${2:-claude-code}"

  if ai-dossier verify "$url"; then
    echo "✅ Dossier verified. Passing to $tool..."
    "$tool" "run $url"
  else
    echo "❌ Verification failed. Dossier not executed."
    return 1
  fi
}

# Usage
safe-run-dossier https://example.com/dossier.ds.md claude-code
safe-run-dossier https://example.com/dossier.ds.md cursor
```

---

## What It Checks

### 1. Integrity (Checksum)

**Verifies**: Content hasn't been tampered with

**How**:
1. Extracts declared SHA256 hash from frontmatter
2. Calculates actual SHA256 of dossier body
3. Compares hashes

**Result**:
- ✅ Match → Content is intact
- ❌ Mismatch → Content has been modified → **BLOCK**

### 2. Authenticity (Signature)

**Verifies**: Dossier is from claimed author

**How**:
1. Checks if signature present in frontmatter
2. Validates signature format
3. Checks if key is in trusted keys list
4. Verifies signature against content

**Result**:
- ✅ Valid + Trusted → From known author
- ⚠️ Valid + Unknown → Signed but untrusted key
- ❌ Invalid → Signature failed → **BLOCK**
- ⚠️ No signature → Unsigned (warn for high-risk)

### 3. Risk Assessment

**Analyzes**:
- Dossier risk level (low/medium/high/critical)
- Presence of signature (required for high-risk)
- Checksum status
- Combined security posture

**Outputs**:
- Recommendation: ALLOW, WARN, or BLOCK
- Issue list
- Overall risk level

---

## Examples

### Example 1: Legitimate Dossier (Passes)

```bash
$ ai-dossier verify examples/data-science/train-ml-model.ds.md

🔐 Dossier Verification Tool

ℹ️  Reading: examples/data-science/train-ml-model.ds.md
✅ File read successfully
ℹ️  Parsing dossier...
✅ Parsed: Train ML Model v1.0.0

📊 Integrity Check:
✅ Checksum VALID - content has not been tampered with

🔏 Authenticity Check:
⚠️  No signature present (dossier is unsigned)

🔴 Risk Assessment:
   Risk Level: MEDIUM

Recommendation: ALLOW
✅ Safe to execute
   Dossier passed security verification.

$ echo $?
0
```

### Example 2: Malicious Dossier (Blocked)

```bash
$ ai-dossier verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/security/validate-project-config.ds.md

🔐 Dossier Verification Tool

ℹ️  Downloading: https://...
✅ Downloaded successfully
ℹ️  Parsing dossier...
✅ Parsed: Validate Project Configuration v1.0.0

📊 Integrity Check:
❌ Checksum INVALID - content has been modified!

🔏 Authenticity Check:
⚠️  Signature verification failed (test signature)
   Signed by: DevTools Community <devtools@example.com>

🔴 Risk Assessment:
   Risk Level: CRITICAL

   Issues Found:
   - Checksum verification FAILED - content has been tampered with
   - Signature verification FAILED or could not be verified

Recommendation: BLOCK
❌ DO NOT EXECUTE this dossier
   Security verification failed.
   This dossier may have been tampered with or is from an untrusted source.

$ echo $?
1
```

### Example 3: Shell Integration

```bash
# Add to ~/.bashrc or ~/.zshrc

# Wrapper function for Claude Code
claude-run-dossier() {
  echo "Verifying dossier security..."
  if ai-dossier verify "$1"; then
    echo ""
    echo "✅ Verification passed. Executing with Claude Code..."
    claude-code "Execute the verified dossier at $1"
  else
    echo ""
    echo "❌ Security verification failed."
    echo "   The dossier failed security checks and should not be executed."
    return 1
  fi
}

# Usage
claude-run-dossier https://example.com/dossier.ds.md
```

---

## Registry Configuration

The CLI supports multiple registries for discovering, pulling, and publishing dossiers.

### Configuration File (`~/.dossier/config.json`)

Configure registries in your user config:

```json
{
  "registries": {
    "public": {
      "url": "https://dossier-registry.vercel.app",
      "default": true
    },
    "internal": {
      "url": "https://dossier.internal.example.com"
    },
    "readonly-mirror": {
      "url": "https://mirror.example.com",
      "readonly": true
    }
  },
  "defaultRegistry": "public"
}
```

### Project-Level Config (`.dossierrc.json`)

Place a `.dossierrc.json` in your project root to add project-specific registries:

```json
{
  "registries": {
    "team": {
      "url": "https://dossier.myteam.example.com"
    }
  },
  "defaultRegistry": "team"
}
```

Project registries are merged with user registries. User-configured registries take precedence on name conflicts to prevent credential exfiltration.

### Environment Variable

Set `DOSSIER_REGISTRY_URL` to add a virtual `env` registry:

```bash
export DOSSIER_REGISTRY_URL=https://custom-registry.example.com
```

### Resolution Priority

When resolving registries, the CLI follows this priority:

1. `--registry` flag on the command
2. `DOSSIER_REGISTRY_URL` environment variable
3. Project-level `.dossierrc.json`
4. User-level `~/.dossier/config.json`
5. Hardcoded default (public registry)

### Per-Command Registry Flag

Write commands accept `--registry <name>` to target a specific registry:

```bash
ai-dossier publish --registry team my-dossier.ds.md
ai-dossier login --registry internal
```

Read commands (`search`, `get`, `pull`) query all configured registries in parallel.

---

## Agent Discovery (`--agent`)

The `--agent` flag outputs a machine-readable JSON manifest describing the CLI's capabilities. This is designed for AI agents that need to discover what the CLI can do programmatically:

```bash
ai-dossier --agent
```

Output includes:
- CLI version and available commands
- Supported flags (`--json`, `-y`/`--yes`)
- Capabilities (multi-registry, non-TTY safe, machine-readable errors)
- Discovery command for full command listing

This enables agents to auto-configure their integration with the Dossier CLI without parsing help text.

---

## Architecture

### How It Works

```
User Command:
ai-dossier verify https://example.com/dossier.ds.md
         ↓
    Download/Read File
         ↓
    Parse Frontmatter
    (Extract metadata)
         ↓
    Calculate SHA256
    (Dossier body only)
         ↓
    Compare Hashes
    ┌────────┴────────┐
    ↓                 ↓
MATCH              MISMATCH
    ↓                 ↓
Check Signature    BLOCK (exit 1)
    ↓
Assess Risk
    ↓
Exit 0 (safe) or 1 (unsafe)
```

### Design Principles

1. **Fail Secure**: Default to blocking on any verification failure
2. **Exit Codes**: Machine-readable results for scripting
3. **Clear Output**: Human-readable for manual use
4. **No Dependencies**: Uses only Node.js built-ins
5. **Fast**: Verification in milliseconds

---

## Limitations

### Current Limitations

1. **Signature Verification**: Basic implementation
   - Detects test signatures (invalid/fake)
   - Full minisign verification requires external tool
   - Future: Native minisign support

2. **Trusted Keys**: Not yet implemented
   - Future: Check against ~/.dossier/trusted-keys.txt
   - Future: Key management commands

3. **Execution**: --run flag not implemented
   - Currently just verifies
   - Future: Execute if verification passes

### Why These Limitations Exist

**Current status**: MVP for verification enforcement
**Focus**: Get checksum verification working reliably
**Future**: Full signature verification, trust management, execution

**But even with limitations**:
- ✅ Checksum verification catches tampering
- ✅ Signature presence detection works
- ✅ Exit codes enable integration
- ✅ Enforces security before LLM involvement

---

## Roadmap

### v0.1.0
- ✅ Basic checksum verification
- ✅ Signature presence detection
- ✅ Exit code support
- ✅ URL download support

### v0.2.0
- ✅ Multi-command CLI structure (`ai-dossier <command>`)
- ✅ `dossier run` command with 5-stage verification pipeline
- ✅ LLM auto-detection and execution integration

### v0.3.0
- ✅ Modular TypeScript migration
- ✅ Comprehensive test suite (261+ tests)
- ✅ CLI parity with dossier-tools
- ✅ `@ai-dossier` npm scope and CI/CD publishing

### v0.4.0 (Current)
- ✅ Unified dossier parser across core/cli/mcp
- ✅ JSON output mode (`--json` flag on commands)
- ✅ Registry integration (publish, remove, install-skill)
- ✅ Non-TTY stdin detection

### v1.0.0 (Stable)
- ⏳ Complete signature verification
- ⏳ Trust management UI
- ⏳ Integration with major LLM tools
- ⏳ Comprehensive documentation

---

## Contributing

### Development Setup

```bash
cd cli
npm link  # For local testing

# Test
ai-dossier verify ../examples/devops/deploy-to-aws.ds.md

# Test with malicious example
ai-dossier verify ../examples/security/validate-project-config.ds.md
```

### Adding Features

**Priority areas**:
1. Full minisign signature verification
2. Trusted keys management
3. --run flag implementation
4. Integration examples for more tools

**See**: [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## FAQ

### Q: Why a separate CLI tool?

**A**: Security cannot be enforced through LLM instructions alone. We need code-level enforcement that runs **before** LLMs get involved.

### Q: Does this replace MCP server?

**A**: No, they're complementary:
- **CLI**: Enforcement layer (verify before execution)
- **MCP server**: Convenience layer (tools for LLMs)

Use both for best results.

### Q: Can I use this with any LLM tool?

**A**: Yes! The CLI is tool-agnostic. Create a wrapper function for your specific tool.

### Q: What if I don't want to install it?

**A**: Use the verification script from SECURITY_STATUS.md or manually verify checksums.

---

## Support

**Issues**: https://github.com/imboard-ai/ai-dossier/issues
**Security**: security@imboard.ai
**Discussions**: https://github.com/imboard-ai/ai-dossier/discussions

---

**Remember**: Security is enforced by code, not suggestions. Use this tool to guarantee verification happens.
