# CLI Evolution Planning

Planning document for redesigning the Dossier CLI from single-purpose `dossier-verify` to multi-command `dossier` CLI.

## Status Overview

**Current Version**: v0.2.9
**Released**: 2025-11-28
**Status**: ✅ Phase 1 Complete + Phase 2 In Progress - MCP Prompts Added

### Implementation Progress

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 1: MVP | ✅ Complete | 100% |
| Phase 2: Enhanced Authoring | 🚧 In Progress | 66% |
| Phase 3: Advanced Features | 📋 Planned | 0% |

### Command Status

| Command | Status | Version | Priority |
|---------|--------|---------|----------|
| `verify` | ✅ Done | v0.2.0 | P0 |
| `run` | ✅ Done | v0.2.3 | P0 |
| `config` | ✅ Done | v0.2.1 | P0 |
| `create` | ✅ Done | v0.2.4 | P1 |
| `list` | ✅ Done | v0.2.5 | P1 |
| `sign` | ✅ Done | v0.2.6 | P2 |
| `checksum` | ✅ Done | v0.2.7 | P2 |
| `validate` | ✅ Done | v0.2.8 | P2 |
| `publish` | 📋 Planned | - | P2 |
| `init` | 📋 Planned | - | P3 |
| `info` | 📋 Planned | - | P3 |

---

## Evolution History

### v0.2.9 - MCP Prompts Implementation ✅ (2025-11-28)

**What Changed**:
- ✅ Implemented MCP prompts for Claude Code integration
- ✅ Added `execute-dossier` prompt - guided execution with verification
- ✅ Added `create-dossier` prompt - delegates to meta-dossier template
- ✅ Added prompts capability to MCP server
- ✅ Created Claude Code integration guide (`docs/guides/claude-code-integration.md`)
- ✅ Updated MCP server README with prompts status

**Prompts**:

1. **`execute-dossier`**
   - Arguments: `dossier_path` (required)
   - Guides Claude through: VERIFY → READ → EXECUTE → REPORT protocol

2. **`create-dossier`**
   - Arguments: `title` (required), `category` (optional), `risk_level` (optional)
   - Delegates to meta-dossier at `examples/authoring/create-dossier.ds.md`
   - Single source of truth - template updates automatically propagate

**Files Modified**:
- `mcp-server/src/index.ts` - Added ListPrompts and GetPrompt handlers
- `mcp-server/README.md` - Updated prompts status to implemented
- `docs/guides/claude-code-integration.md` - New user guide

**Design Decisions**:
- Prompts use user role messages (not assistant) per MCP spec
- `create-dossier` references meta-dossier instead of embedding template
- Deferred `suggest-dossier` to future (requires LLM-based matching)

### v0.2.8 - Validate Command Implementation ✅ (2025-11-28)

**What Changed**:
- ✅ Implemented `dossier validate` command for frontmatter validation
- ✅ Validates required fields: `dossier_schema_version`, `title`, `version`
- ✅ Warns on missing recommended fields: `objective`, `risk_level`, `status`
- ✅ Validates field values (risk levels, statuses, semver format)
- ✅ Supports both JSON and basic YAML frontmatter
- ✅ JSON output for CI/CD integration
- ✅ Strict mode treats warnings as errors

**Command Syntax**:
```bash
dossier validate <file> [options]

Options:
  --strict    Treat warnings as errors
  --quiet     Only output errors (no warnings)
  --json      Output results as JSON
```

**Examples**:
```bash
# Validate a dossier
dossier validate file.ds.md

# Strict mode for CI/CD
dossier validate file.ds.md --strict

# JSON output for automation
dossier validate file.ds.md --json
```

**Validation Rules**:
- Required: `dossier_schema_version`, `title`, `version`
- Recommended: `objective`, `risk_level`, `status`
- Warns on invalid risk levels, statuses, version format
- Warns if high-risk dossier is unsigned

### v0.2.7 - Checksum Command Implementation ✅ (2025-11-28)

**What Changed**:
- ✅ Implemented `dossier checksum` command for integrity management
- ✅ Calculate SHA256 checksum of dossier body
- ✅ Verify existing checksum against content
- ✅ Update checksum in frontmatter
- ✅ Quiet mode for scripting (`--quiet`)

**Command Syntax**:
```bash
dossier checksum <file> [options]

Options:
  --update    Update checksum in frontmatter
  --verify    Verify existing checksum (exit 0 if valid, 1 if invalid)
  --quiet     Only output the hash (for scripting)
```

**Examples**:
```bash
# Show checksum and compare with frontmatter
dossier checksum file.ds.md

# Verify checksum (useful in CI/CD)
dossier checksum file.ds.md --verify

# Update checksum after editing
dossier checksum file.ds.md --update

# Get just the hash for scripting
dossier checksum file.ds.md --quiet
```

### v0.2.6 - Sign Command Implementation ✅ (2025-11-28)

**What Changed**:
- ✅ Implemented `dossier sign` command as CLI wrapper around existing signing tools
- ✅ AWS KMS signing support (default method)
- ✅ Ed25519 local key signing support
- ✅ Dry-run mode for checksum-only calculation
- ✅ Helpful error messages with key generation instructions

**Command Syntax**:
```bash
dossier sign <file> [options]

Options:
  --method <type>     Signing method: kms (default) or ed25519
  --key <path>        Path to Ed25519 private key (required for ed25519)
  --key-id <id>       Key identifier
  --region <region>   AWS region for KMS (default: us-east-1)
  --signed-by <name>  Signer identity (e.g., "Name <email@example.com>")
  --dry-run           Calculate checksum only, do not sign
```

**Examples**:
```bash
# Sign with AWS KMS (default)
dossier sign examples/my-dossier.ds.md --signed-by "Team <team@example.com>"

# Sign with custom KMS key
dossier sign file.ds.md --key-id alias/my-key --region us-west-2

# Sign with Ed25519 local key
dossier sign file.ds.md --method ed25519 --key private-key.pem --key-id my-key-2025

# Dry run (checksum only)
dossier sign file.ds.md --dry-run
```

**Implementation Notes**:
- Wraps existing `tools/sign-dossier-kms.js` and `tools/sign-dossier.js`
- KMS requires AWS credentials configured
- Ed25519 requires generating a keypair with `openssl genpkey -algorithm ED25519`

### v0.2.5 - List Command Implementation ✅ (2025-11-28)

**What Changed**:
- ✅ Implemented `dossier list` command with local and remote support
- ✅ Local directory scanning with optional recursive search
- ✅ GitHub repository support via `github:owner/repo` shorthand
- ✅ GitHub URL support (`https://github.com/owner/repo/tree/branch/path`)
- ✅ Metadata parsing from JSON and YAML frontmatter
- ✅ Multiple output formats: table (default), json, simple
- ✅ Filtering options: `--risk`, `--category`, `--signed-only`
- ✅ Summary statistics: signed/unsigned count, risk level breakdown

**Command Syntax**:
```bash
dossier list [source] [options]

# Local directory
dossier list ./examples --recursive

# GitHub repository
dossier list github:owner/repo
dossier list github:owner/repo/path@branch
dossier list https://github.com/owner/repo/tree/main/examples

Options:
  -r, --recursive        Search subdirectories recursively
  --signed-only          Only show signed dossiers
  --risk <level>         Filter by risk level (low, medium, high, critical)
  --category <category>  Filter by category
  --format <fmt>         Output format (table, json, simple)
  --show-path            Show full path instead of filename
```

**Example Output**:
```
🔍 Fetching dossiers from GitHub: imboard-ai/ai-dossier
   Path: examples
   Branch: main

   Found 15 dossier file(s)

TITLE                           RISK      SIGNED  FILE
──────────────────────────────────────────────────────────────────────────
Deploy to AWS                   HIGH      ✅       deploy-to-aws.ds.md
Train ML Model                  MEDIUM    ✅       train-ml-model.ds.md
...

Total: 15 dossier(s)
   Signed: 15  |  Unsigned: 0
   Risk: low: 8  |  medium: 4  |  critical: 1  |  high: 2
```

**Implementation Notes**:
- Uses GitHub API for repository tree fetching (unauthenticated, rate-limited)
- TODO: Add authentication support for private repos and higher rate limits
- TODO: Add caching to avoid repeated fetches
- TODO: Add GitLab support

### v0.2.4 - Create Command Implementation ✅ (2025-11-25)

**What Changed**:
- ✅ Implemented `dossier create` command with meta-dossier approach
- ✅ Created and signed meta-dossier for dossier creation (`examples/authoring/create-dossier.ds.md`)
- ✅ Single-path architecture: always executes meta-dossier via Claude Code
- ✅ Context prepending approach: builds markdown header with user-provided flags
- ✅ Removed Cursor support (simplified to Claude Code only)
- ✅ Interactive mode execution for better UX and file creation
- ✅ Fixed critical AWS KMS signature verification bug (DIGEST mode mismatch)

**Command Syntax**:
```bash
dossier create [file] [options]

Options:
  --title <title>           Dossier title
  --objective <text>        Primary objective
  --risk <level>            Risk level (low/medium/high/critical)
  --category <category>     Category
  --tags <tags>            Comma-separated tags
  --llm <name>             LLM to use (claude-code, auto)
```

**Implementation Approach**:
- Meta-dossier handles all validation and file generation
- CLI wrapper prepends user context to meta-dossier content
- Writes to temp file and launches Claude Code with content as prompt
- Meta-dossier reads context from prepended header
- Prompts for missing metadata interactively
- Generates valid dossier with proper frontmatter and sections

**Key Technical Decisions**:
1. Context passing: Prepended markdown header (not environment variables)
2. Execution mode: Interactive mode (not headless `-p`)
3. LLM support: Claude Code only (removed Cursor)
4. Command: `claude "$(cat 'tmpFile')"` to pass content as prompt

**Testing**:
```bash
# Successfully created test dossier with all metadata
dossier create test-complete.ds.md \
  --title "Test Dossier Creation" \
  --objective "Verify that the create command works end-to-end" \
  --risk low \
  --category development \
  --tags "test,cli,verification"

# Result: Valid dossier with proper frontmatter and structure
```

**Documentation**:
- Created comprehensive planning document: `docs/planning/create-command-implementation.md`
- Created signing guide: `docs/guides/signing-dossiers.md`
- Updated CLI evolution document with create command status

### v0.2.3 - Headless Mode Confirmation ✅ (2025-11-16)

**What Changed**:
- ✅ Confirmed headless mode (`-p` flag) as correct approach for dossier execution
- ✅ Tested and validated both interactive and headless modes
- ✅ Documented that interactive mode requires TTY and cannot work with piped input
- ✅ Verified full end-to-end execution with real dossiers
- ✅ Production-ready dossier execution pipeline

**Key Findings**:
- Interactive mode (`claude` without `-p`) fails with piped input (Ink raw mode error)
- Headless mode (`claude -p`) required for automated dossier execution
- Output correctly displayed to stdout with `-p` flag
- Execution completes automatically and exits cleanly

**Testing**:
```bash
# Successfully executed real dossier
dossier run https://raw.githubusercontent.com/.../readme-reality-check.ds.md

# Complete workflow verified:
# ✅ Download from URL to temp file
# ✅ All 5 verification stages passed
# ✅ Execution with claude -p
# ✅ Analysis output displayed
# ✅ Clean exit
```

### v0.2.2 - Secure URL Handling ✅ (2025-11-16)

**What Changed**:
- ✅ Implemented secure temp file download for URL-based dossiers
- ✅ URL detection with proper handling
- ✅ Download verification before execution
- ✅ Automatic cleanup of temp files

**Implementation**:
```bash
# For URLs:
tmpfile=$(mktemp /tmp/dossier.XXXXXX.ds.md) && \
curl -sL "${url}" -o "${tmpfile}" && \
test -s "${tmpfile}" && \
cat "${tmpfile}" | claude -p; \
status=$?; rm -f "${tmpfile}"; exit $status

# For local files:
cat "${file}" | claude -p
```

**Benefits**:
- Better error handling (verify download succeeded)
- Audit trail (temp file path can be logged)
- Debugging capability (inspect downloaded content)
- Security (validate before execution)
- Clean execution flow

### v0.2.1 - Configuration System & LLM Support ✅ (2025-11-16)

**What Changed**:
- ✅ Added configuration system (`~/.dossier/config.json`)
- ✅ Implemented `dossier config` command for settings management
- ✅ Configurable default LLM (claude-code, cursor, auto)
- ✅ DRY refactoring with helper functions
- ✅ Fixed dossier execution to actually run (not just open for editing)

**Configuration File**:
```json
{
  "defaultLlm": "claude-code",
  "theme": "auto",
  "auditLog": true
}
```

**Commands**:
```bash
# Manage configuration
dossier config                          # List all settings
dossier config defaultLlm               # Get specific value
dossier config defaultLlm claude-code   # Set value
dossier config --reset                  # Reset to defaults
```

**LLM Integration**:
- Priority: CLI option `--llm` > config file > auto-detect
- Auto-detection: claude-code → cursor → fail with helpful message
- Helper functions: `detectLlm()`, `buildLlmCommand()`
- Eliminated code duplication

### v0.2.0 - Multi-Command Structure ✅ (2025-11-15)

**What Changed**:
- ✅ Added commander.js CLI framework
- ✅ Implemented subcommand architecture
- ✅ Created 10 command placeholders with helpful TBD messages
- ✅ Migrated `verify` to new structure
- ✅ Removed `dossier-verify` standalone command (breaking change)
- ✅ Updated package scope to `@ai-dossier/*`

**Command**: `dossier <command>`

```bash
dossier verify <file|url> [--verbose]
dossier run <file|url>    # TBD
dossier create [file]     # TBD
# ... 7 more commands
```

### v0.1.x - Single-Purpose Verification (Legacy)

**Command**: `dossier-verify`

```bash
dossier-verify <file|url> [--verbose] [--help]
```

**Functionality**:
- Verify checksum integrity
- Verify signatures (basic)
- Risk assessment
- Exit codes (0=safe, 1=unsafe, 2=error)

**Limitations** (Resolved in v0.2.0):
- ❌ Single-purpose: Only verification, no creation or execution
- ❌ Poor naming: "verify" doesn't reflect full capabilities
- ❌ Not extensible: Hard to add new features
- ❌ Limited workflow: Can't create, sign, or execute dossiers
- ❌ No discovery: Can't list or search available dossiers

---

## User Jobs-to-be-Done Analysis

### 1. Dossier Authors (Creating Content)

**Jobs**:
- Create a new dossier from scratch
- Create from a template
- Calculate and add checksum automatically
- Sign with their key (Minisign or AWS KMS)
- Validate format before publishing
- **Share dossier with community** (like `docker push`)
- Publish to registry for discoverability

**Pain Points**:
- Manual checksum calculation is error-prone
- Signing requires external tools
- No way to validate before sharing
- **No easy way to share dossiers publicly**
- **No central registry for discovery**

### 2. Dossier Users (Consuming Content)

**Jobs**:
- **Discover dossiers in public registry** (like Docker Hub)
- **Install dossiers from registry by ID** (like `npm install`)
- Verify dossier before execution (security)
- Execute verified dossier with AI agent
- List available dossiers in directory/registry
- Download dossiers from URLs
- View metadata without full execution

**Pain Points**:
- Verification and execution are separate steps
- No built-in execution workflow
- **Hard to discover available dossiers**
- **No way to install from registry by ID**
- **Must manually download and save files**

### 3. Security-Conscious Users

**Jobs**:
- Verify checksums and signatures
- Audit dossier before trusting
- Check against specification schema
- Review dossier execution history

**Pain Points**:
- Limited audit trail
- No comprehensive security analysis
- Can't track dossier provenance

### 4. Developers/Integrators

**Jobs**:
- Initialize dossier projects quickly
- Validate against spec during development
- Generate documentation from dossiers
- Export to other formats (JSON, YAML)
- Integrate with CI/CD pipelines

**Pain Points**:
- No scaffolding tools
- Manual schema validation
- No automation for common tasks

---

## Proposed CLI Structure

### Modern Convention: Subcommands

Following patterns from `git`, `docker`, `npm`, `gh`:

```bash
dossier <command> [arguments] [options]

# Examples:
dossier run deploy-aws.ds.md
dossier create my-deployment.ds.md
dossier verify https://example.com/dossier.ds.md
dossier list ./dossiers
```

### Why Subcommands?

✅ **Discoverable**: `dossier --help` shows all commands
✅ **Extensible**: Easy to add new commands
✅ **Clear**: Each command has clear purpose
✅ **Standard**: Matches user expectations from git, npm, etc.
✅ **Context-aware**: Each command can have its own options

---

## Core Commands Specification

### 1. `dossier run` (Primary Command)

**Purpose**: Verify, audit, and execute dossier in one step

**Syntax**:
```bash
dossier run <file|url> [options]
```

**Workflow**:
```
1. Download/read dossier
   ↓
2. Verify checksum (FAIL if invalid)
   ↓
3. Verify signature (FAIL if present but invalid)
   ↓
4. Risk assessment
   ↓
5. Log audit trail
   ↓
6. Prompt user if high-risk
   ↓
7. Execute via LLM
```

**Options**:
```bash
--llm <name>           # LLM to use: claude-code, cursor, auto (default)
--audit-server <url>   # Audit log endpoint (future)
--dry-run              # Verify and show plan, don't execute
--force                # Skip risk warnings (not verification)
--no-prompt            # Don't ask for confirmation
--verbose              # Detailed output
--quiet                # Minimal output
```

**Examples**:
```bash
# Basic run (auto-detect LLM)
dossier run deploy-aws.ds.md

# With specific LLM
dossier run setup-project.ds.md --llm claude-code

# Dry run (safety check)
dossier run risky-operation.ds.md --dry-run

# CI/CD usage
dossier run ci-deploy.ds.md --no-prompt --force
```

**Exit Codes**:
- `0` - Verification passed, execution completed
- `1` - Verification failed (checksum/signature)
- `2` - Execution error
- `3` - User cancelled

**Security Rules**:
- ❌ CANNOT skip checksum verification
- ❌ CANNOT skip signature verification (if present)
- ✅ CAN skip risk warnings with `--force`
- ✅ CAN skip user prompts with `--no-prompt`

### 2. `dossier verify` (Security Command)

**Purpose**: Verify integrity and authenticity WITHOUT executing

**Syntax**:
```bash
dossier verify <file|url> [options]
```

**Use Cases**:
- Security review before deciding to execute
- Batch verification of multiple dossiers
- CI/CD checks without execution
- Manual audit workflows

**Options**:
```bash
--verbose              # Show detailed verification steps
--json                 # Output results as JSON
--exit-code-only       # Silent mode (use exit code only)
```

**Examples**:
```bash
# Interactive verification
dossier verify deploy-aws.ds.md

# Scripting (JSON output)
dossier verify deploy-aws.ds.md --json > results.json

# Batch verification
for f in dossiers/*.ds.md; do
  dossier verify "$f" --exit-code-only && echo "✅ $f"
done
```

**Output**:
```
🔐 Dossier Verification Tool

📊 Integrity Check:
✅ Checksum VALID

🔏 Authenticity Check:
⚠️  No signature present

🔴 Risk Assessment:
   Risk Level: MEDIUM

Recommendation: ALLOW (with caution)
```

### 3. `dossier create` (Authoring Command)

**Purpose**: Create new dossier with proper structure

**Syntax**:
```bash
dossier create [file] [options]
```

**Options**:
```bash
--template <name>      # Use template (basic, devops, data-science, etc.)
--interactive          # Guided creation with prompts
--title <title>        # Dossier title
--risk <level>         # Risk level (low/medium/high/critical)
--checksum             # Auto-calculate checksum
--sign                 # Sign after creation
```

**Examples**:
```bash
# Interactive mode (guided)
dossier create

# From template
dossier create deploy-prod.ds.md --template devops

# With metadata
dossier create setup.ds.md --title "Setup Project" --risk medium

# Create and sign in one step
dossier create deploy.ds.md --template devops --sign
```

**Workflow**:
```
1. Prompt for metadata (or use flags)
2. Create file with frontmatter
3. Open in $EDITOR or show next steps
4. Calculate checksum (if --checksum)
5. Sign (if --sign)
```

**Output File**:
```markdown
---
title: Deploy to AWS
version: "1.0.0"
risk_level: medium
checksum: sha256:abc123...
created: 2025-11-15T18:00:00Z
---

# Deploy to AWS

## Objective
[Your objective here]

## Steps
1. [Your steps here]

## Validation
- [ ] Deployment successful
```

### 4. `dossier list` (Discovery Command)

**Purpose**: Discover available dossiers

**Syntax**:
```bash
dossier list [directory|registry] [options]
```

**Options**:
```bash
--recursive            # Search subdirectories
--verified-only        # Only show verified dossiers
--risk <level>         # Filter by risk level
--signed-only          # Only show signed dossiers
--format <fmt>         # Output format (table, json, simple)
```

**Examples**:
```bash
# List in current directory
dossier list

# List in specific directory
dossier list ./dossiers

# Recursive search
dossier list ./projects --recursive

# Filter by risk
dossier list --risk low --verified-only

# JSON output for tooling
dossier list --format json
```

**Output**:
```
Found 5 dossiers:

TITLE                    FILE                     RISK     SIGNED  STATUS
Deploy to AWS            deploy-aws.ds.md         MEDIUM   ⚠️      ✅
Setup React Library      setup-react.ds.md        LOW      ✅      ✅
Train ML Model           train-ml.ds.md          MEDIUM   ⚠️      ✅
Database Migration       migrate-db.ds.md         HIGH     ✅      ✅
Critical Deployment      critical-deploy.ds.md    CRITICAL ✅      ✅
```

---

## Additional Commands (Phase 2+)

### `dossier sign`

```bash
dossier sign <file> [options]

Options:
  --key <path>           # Path to signing key
  --method <type>        # minisign, kms
  --output <file>        # Output signed dossier
```

**Use Cases**:
- Sign dossiers before sharing
- Re-sign after updates
- Add signature to unsigned dossiers

### `dossier publish` (aka `share`)

```bash
dossier publish <file> [options]

Options:
  --registry <url>       # Registry URL (default: public registry)
  --name <name>          # Custom name in registry
  --tags <tags>          # Comma-separated tags
  --private              # Private publication (auth required)
```

**Purpose**: Share dossier with community via registry (like `docker push`)

**Workflow**:
```
1. Validate dossier format
   ↓
2. Verify checksum present
   ↓
3. Prompt to sign if unsigned
   ↓
4. Upload to registry
   ↓
5. Return GUID + public URL
```

**MVP Implementation**:
```bash
$ dossier publish deploy-aws.ds.md

🔐 Validating dossier...
✅ Format valid
✅ Checksum present
⚠️  Dossier is unsigned. Sign it? [y/N]: n

📦 Publishing to registry...
✅ Published successfully!

Registry ID:  dsr-7f3a9b2c-4d1e-4a5f-8c6b-9e2d1a3b4c5d
Public URL:   https://registry.dossier.ai/dsr-7f3a9b2c
Install:      dossier run dsr-7f3a9b2c

[MVP: Just prints this message, no actual upload yet]
```

**Future: Actual Registry Integration**:
```bash
POST https://registry.dossier.ai/v1/dossiers

Body:
{
  "dossier": {
    "title": "Deploy to AWS",
    "version": "1.0.0",
    "content": "...",
    "checksum": "sha256:...",
    "signature": "minisign:..."
  },
  "metadata": {
    "author": "operator",
    "tags": ["devops", "aws", "deployment"],
    "visibility": "public"
  }
}

Response:
{
  "id": "dsr-7f3a9b2c-4d1e-4a5f-8c6b-9e2d1a3b4c5d",
  "url": "https://registry.dossier.ai/dsr-7f3a9b2c",
  "shortId": "dsr-7f3a9b2c"
}
```

**Use Cases**:
- Share dossiers with community
- Publish to private team registry
- Version control for dossiers
- Track dossier usage/downloads
- Enable discovery via search

**Related Commands**:
```bash
dossier search devops          # Find published dossiers
dossier install dsr-7f3a9b2c   # Download from registry
dossier unpublish <id>         # Remove from registry
```

### `dossier info`

```bash
dossier info <file|url> [options]

Options:
  --json                 # JSON output
  --short                # Brief summary only
```

**Output**:
```
Title:          Deploy to AWS
Version:        1.0.0
Risk Level:     MEDIUM
Checksum:       sha256:abc123...
Signature:      ⚠️ Unsigned
Created:        2025-11-15
Last Modified:  2025-11-15
File Size:      2.4 KB
```

### `dossier init`

```bash
dossier init [project-name] [options]

Options:
  --template <name>      # Project template
  --git                  # Initialize git repo
```

**Creates**:
```
my-project/
├── dossiers/
│   ├── setup.ds.md
│   └── deploy.ds.md
├── .dossier/
│   ├── config.json
│   └── trusted-keys.txt
└── README.md
```

### `dossier validate`

```bash
dossier validate <file> [options]

Options:
  --schema <file>        # Custom schema
  --fix                  # Auto-fix issues
```

**Checks**:
- Valid YAML frontmatter
- Required fields present
- Checksum format correct
- Signature format valid
- Risk level valid
- Spec version compatibility

### `dossier checksum`

```bash
dossier checksum <file> [options]

Options:
  --update               # Update checksum in file
  --verify               # Just verify, don't update
```

**Use Cases**:
- Update checksum after editing
- Quick integrity check
- Pre-signing validation

---

## Audit Logging Design

### MVP (Phase 1): Console Output

**Purpose**: Show that audit logging happens (build trust)

**Implementation**:
```javascript
function logAudit(dossier, user, action) {
  console.log(`
📝 AUDIT LOG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Timestamp:    ${new Date().toISOString()}
Dossier:      ${dossier.metadata.title}
File:         ${dossier.path}
Checksum:     ${dossier.checksumValid ? '✅ VALID' : '❌ INVALID'}
Signature:    ${dossier.signatureStatus}
Risk Level:   ${dossier.metadata.risk_level}
User:         ${user}
Executed By:  ${llm}
Action:       ${action}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[In production, this log would be sent to audit server]
  `.trim());
}
```

### Future (Phase 2): Remote Audit Server

**API Endpoint**:
```bash
POST https://audit.dossier.ai/v1/logs

Body:
{
  "timestamp": "2025-11-15T18:00:00Z",
  "dossier": {
    "title": "Deploy to AWS",
    "version": "1.0.0",
    "file": "deploy-aws.ds.md",
    "checksum": "sha256:abc123...",
    "signature": "minisign:xyz789..."
  },
  "verification": {
    "checksum": "valid",
    "signature": "unsigned",
    "risk_level": "medium"
  },
  "execution": {
    "user": "user@localhost",
    "llm": "claude-code",
    "action": "run",
    "status": "started"
  }
}
```

**Privacy Considerations**:
- Hash user identifiers
- Don't send dossier content
- Only send metadata and verification results
- Allow opt-out via `--no-audit`

---

## LLM Integration Strategy

### Auto-Detection (`--llm auto`)

**Detection Order**:
```
1. Check for Claude Code in PATH
   → command -v claude

2. Check for Cursor in PATH
   → command -v cursor

3. Fail with helpful message
   → "No LLM detected. Install Claude Code or use --llm <name>"
```

### Execution Methods

**Claude Code** (Headless Mode - Required):
```bash
# For URLs (download to temp file first)
tmpfile=$(mktemp /tmp/dossier.XXXXXX.ds.md) && \
curl -sL "${url}" -o "${tmpfile}" && \
test -s "${tmpfile}" && \
cat "${tmpfile}" | claude -p; \
status=$?; rm -f "${tmpfile}"; exit $status

# For local files
cat "${file}" | claude -p
```

**Why Headless Mode (`-p`) is Required**:
- Interactive mode requires a TTY (terminal) and cannot work with piped input
- Attempting to pipe dossier content to `claude` without `-p` fails with:
  ```
  ERROR: Raw mode is not supported on the current process.stdin
  ```
- Headless mode (`-p`) outputs to stdout and exits automatically
- Perfect for automation, CI/CD, and scripting

**Cursor**:
```bash
cursor "${file}"
```
*Note: Cursor integration is placeholder - needs investigation for headless execution*

### Configuration File

**`~/.dossier/config.json`** (Implemented):
```json
{
  "defaultLlm": "claude-code",
  "theme": "auto",
  "auditLog": true
}
```

**Configuration Commands**:
```bash
dossier config                          # List all settings
dossier config defaultLlm               # Get specific value
dossier config defaultLlm claude-code   # Set value
dossier config --reset                  # Reset to defaults
```

**LLM Selection Priority**:
1. CLI flag: `--llm claude-code` (highest priority)
2. Config file: `~/.dossier/config.json`
3. Auto-detection: Check PATH for `claude`, then `cursor`

**Helper Functions** (Implemented):
```javascript
detectLlm(llmOption, silent)    // Auto-detect or validate LLM
buildLlmCommand(llm, file)      // Build execution command
```

---

## Security Model for `run` Command

### Verification Rules (Cannot Be Bypassed)

**ALWAYS FAIL if**:
- ❌ Checksum is invalid (content tampered)
- ❌ Signature present but invalid (bad signature)
- ❌ Critical risk without signature

**ALWAYS WARN if** (can proceed with `--force`):
- ⚠️ No signature (unsigned dossier)
- ⚠️ High risk level
- ⚠️ Unknown/untrusted key

**ALWAYS LOG**:
- 📝 Every execution attempt
- 📝 Verification results
- 📝 User decision (proceed/cancel)

### Risk-Based Behavior

```
Risk: LOW
  → No signature: ALLOW (no prompt)
  → Signed: ALLOW

Risk: MEDIUM
  → No signature: PROMPT ("Proceed? [y/N]")
  → Signed: ALLOW

Risk: HIGH
  → No signature: BLOCK
  → Signed + trusted: ALLOW
  → Signed + unknown: PROMPT with strong warning

Risk: CRITICAL
  → No signature: BLOCK (hard)
  → Signed + trusted: PROMPT
  → Signed + unknown: BLOCK
```

### Example Flows

**Safe dossier (low risk, signed)**:
```bash
$ dossier run setup.ds.md

🔐 Verifying...
✅ Checksum valid
✅ Signed by: trusted-author@example.com
📊 Risk: LOW
📝 Audit logged
🤖 Executing with Claude Code...
```

**Unsigned medium-risk dossier**:
```bash
$ dossier run deploy.ds.md

🔐 Verifying...
✅ Checksum valid
⚠️  No signature
📊 Risk: MEDIUM

Proceed with unsigned dossier? [y/N]:
```

**Tampered dossier (checksum fail)**:
```bash
$ dossier run malicious.ds.md

🔐 Verifying...
❌ Checksum INVALID
📊 Content has been tampered with

❌ BLOCKED
   This dossier failed security verification.
   Do NOT execute.

Exit code: 1
```

---

## Implementation Phases

### Phase 1: MVP (Core Commands) ✅ 100% Complete

**Timeline**: 2025-11-15 to 2025-11-25
**Status**: ✅ Complete

**Infrastructure** ✅:
- [x] Subcommand architecture (commander.js)
- [x] Help system with all commands
- [x] Package publishing to npm
- [x] Automated workflow with version detection
- [x] Documentation restructure

**Commands**:
1. ✅ `dossier verify` - Done (v0.2.0) - Multi-stage verification
2. ✅ `dossier run` - Done (v0.2.3) - Multi-stage verification + audit + execute
3. ✅ `dossier config` - Done (v0.2.1) - Configuration management
4. ✅ `dossier create` - Done (v0.2.4) - Meta-dossier-based creation

**Features**:
- [x] Subcommand architecture
- [x] Auto-detect LLM (claude-code only, cursor removed)
- [x] Console audit logging (print to stdout)
- [x] Multi-stage verification pipeline (5 stages)
- [x] Configurable verification flags (skip options)
- [x] Dry-run mode
- [x] Configuration system with ~/.dossier/config.json
- [x] Meta-dossier approach for dossier creation
- [x] Context prepending for user-provided metadata
- [x] Interactive mode execution

**Deliverables**:
- [x] Refactored CLI codebase structure
- [x] Updated documentation
- [x] Migration from `dossier-verify` (removed old command)
- [x] `run` command implementation (with 5-stage verification)
- [x] `config` command implementation
- [x] `create` command implementation (meta-dossier approach)
- [x] Comprehensive planning documents
- [x] Signing guide documentation
- [ ] Test coverage (deferred to Phase 2)
- [ ] `list` command implementation (moved to Phase 2)

### Phase 2: Enhanced Authoring 🚧 66% Complete

**Timeline**: 2-3 weeks
**Status**: In Progress

**Commands**:
5. ✅ `dossier list` - List and discover dossiers (v0.2.5)
6. ✅ `dossier sign` - Sign dossiers with KMS or Ed25519 (v0.2.6)
7. ✅ `dossier checksum` - Checksum utilities (v0.2.7)
8. ✅ `dossier validate` - Schema validation (v0.2.8)
9. 📋 `dossier publish` - Share to registry (MVP: print GUID only)
10. 📋 `dossier init` - Scaffold projects

**Features**:
- [ ] Templates for common use cases
- [ ] Interactive creation mode
- [ ] Key management basics
- [ ] Better error messages
- [ ] **Registry publish (MVP simulation)** - Print registry ID to demonstrate workflow

**Deliverables**:
- [ ] Template library
- [ ] Signing integration
- [ ] Comprehensive examples
- [ ] **Registry publish command** (simulation with GUID generation)

### Phase 3: Advanced Features 📋 0% Complete

**Timeline**: 4-6 weeks
**Status**: Planned

**Commands**:
10. 📋 `dossier search` - Search registry for dossiers
11. 📋 `dossier install` - Download from registry by ID
12. 📋 `dossier info` - Metadata display
13. 📋 `dossier diff` - Compare dossiers
14. 📋 `dossier export` - Format conversion
15. 📋 `dossier audit` - Deep security analysis
16. 📋 `dossier unpublish` - Remove from registry

**Features**:
- [ ] Remote audit server integration
- [ ] **Full registry integration** (search, install, publish, unpublish)
- [ ] Trust management UI
- [ ] Advanced analytics
- [ ] Dossier versioning in registry
- [ ] Download statistics

**Deliverables**:
- [ ] Audit server API
- [ ] **Registry server implementation**
  - [ ] REST API for dossier storage
  - [ ] Search and discovery
  - [ ] Download tracking
  - [ ] Version management
- [ ] Trust management system
- [ ] Registry CLI commands (search, install, unpublish)

---

## Technical Architecture

### Proposed Structure

```
cli/
├── bin/
│   └── dossier              # Main entry point
├── src/
│   ├── commands/            # Command implementations
│   │   ├── run.js
│   │   ├── verify.js
│   │   ├── create.js
│   │   ├── list.js
│   │   └── index.js
│   ├── lib/                 # Shared utilities
│   │   ├── llm-detect.js
│   │   ├── audit-log.js
│   │   ├── prompt.js
│   │   └── output.js
│   ├── templates/           # Dossier templates
│   │   ├── basic.md
│   │   ├── devops.md
│   │   └── data-science.md
│   └── index.js            # CLI router
├── package.json
└── README.md
```

### Command Router

```javascript
#!/usr/bin/env node

const { program } = require('commander');
const { runCommand } = require('./src/commands/run');
const { verifyCommand } = require('./src/commands/verify');
const { createCommand } = require('./src/commands/create');
const { listCommand } = require('./src/commands/list');

program
  .name('dossier')
  .description('Dossier CLI - Automation standard for AI agents')
  .version('0.2.0');

program
  .command('run')
  .description('Verify and execute dossier')
  .argument('<file>', 'Dossier file or URL')
  .option('--llm <name>', 'LLM to use (claude-code, cursor, auto)', 'auto')
  .option('--dry-run', 'Show plan without executing')
  .option('--force', 'Skip risk warnings')
  .action(runCommand);

program
  .command('verify')
  .description('Verify dossier without executing')
  .argument('<file>', 'Dossier file or URL')
  .option('--verbose', 'Detailed output')
  .option('--json', 'JSON output')
  .action(verifyCommand);

program
  .command('create')
  .description('Create new dossier')
  .argument('[file]', 'Output file')
  .option('--template <name>', 'Use template')
  .option('--interactive', 'Guided creation')
  .action(createCommand);

program
  .command('list')
  .description('List available dossiers')
  .argument('[directory]', 'Directory to search', '.')
  .option('--recursive', 'Search subdirectories')
  .option('--verified-only', 'Only verified dossiers')
  .action(listCommand);

program.parse();
```

### Dependencies

**New**:
- `commander` - CLI framework (industry standard)
- `inquirer` - Interactive prompts
- `chalk` - Terminal colors (already using)
- `ora` - Spinners for loading states
- `clipboardy` - Clipboard integration (fallback)

**Existing**:
- `@ai-dossier/core` - Verification logic

---

## Migration Strategy

### Backward Compatibility

**Keep `dossier-verify` as alias**:
```bash
# Old command still works
dossier-verify file.ds.md

# Internally maps to:
dossier verify file.ds.md
```

**Deprecation Plan**:
1. v0.2.0 - Introduce new commands, keep `dossier-verify`
2. v0.3.0 - Add deprecation warning to `dossier-verify`
3. v1.0.0 - Remove `dossier-verify`, only `dossier verify`

### User Communication

**In package.json**:
```json
{
  "bin": {
    "dossier": "./bin/dossier",
    "dossier-verify": "./bin/dossier-verify-legacy"
  }
}
```

**Deprecation message**:
```
⚠️  DEPRECATED: dossier-verify will be removed in v1.0.0
   Use: dossier verify <file>

   Migration guide: https://github.com/imboard-ai/ai-dossier/wiki/CLI-Migration
```

---

## User Personas & Workflows

### Persona 1: DevOps Engineer

**Job**: Deploy applications safely

**Workflow**:
```bash
# Discover deployment dossiers
dossier list ./devops --risk high --signed-only

# Review before running
dossier info deploy-production.ds.md

# Dry run to see plan
dossier run deploy-production.ds.md --dry-run

# Execute with audit trail
dossier run deploy-production.ds.md
```

### Persona 2: Dossier Author

**Job**: Create and share dossiers

**Workflow**:
```bash
# Create from template
dossier create my-deployment.ds.md --template devops --interactive

# Edit content
$EDITOR my-deployment.ds.md

# Validate format
dossier validate my-deployment.ds.md

# Add checksum
dossier checksum my-deployment.ds.md --update

# Sign
dossier sign my-deployment.ds.md --key ~/.ssh/minisign.key

# Verify before sharing
dossier verify my-deployment.ds.md --verbose

# Publish to registry
dossier publish my-deployment.ds.md --tags "devops,aws"
# Returns: dsr-abc123 (registry ID)
```

### Persona 3: Security Auditor

**Job**: Audit dossier safety

**Workflow**:
```bash
# Batch verification
for f in dossiers/*.ds.md; do
  dossier verify "$f" --json >> audit-results.json
done

# Check specific dossier
dossier verify suspicious.ds.md --verbose

# Deep audit
dossier audit suspicious.ds.md
```

### Persona 4: Solo Developer

**Job**: Quick automation

**Workflow**:
```bash
# Just run trusted dossier
dossier run setup-project.ds.md

# That's it! (verify + execute in one step)
```

---

## Breaking Changes from v0.1.x

### Command Name

**Old**:
```bash
dossier-verify file.ds.md
```

**New**:
```bash
dossier verify file.ds.md
```

### Binary Name in package.json

**Old**:
```json
{
  "bin": {
    "dossier-verify": "./bin/dossier-verify"
  }
}
```

**New**:
```json
{
  "bin": {
    "dossier": "./bin/dossier",
    "dossier-verify": "./bin/dossier-verify-legacy"  // Backward compat
  }
}
```

### Version Bump

- v0.1.1 (current) → v0.2.0 (minor version for new features)

---

## Open Questions

1. **Should `dossier run` require confirmation for unsigned high-risk dossiers?**
   - Option A: Always prompt (safer)
   - Option B: Only with `--interactive` flag (faster)
   - Recommendation: Always prompt unless `--force` or `--no-prompt`

2. **Should we support executing multiple dossiers in sequence?**
   ```bash
   dossier run setup.ds.md deploy.ds.md cleanup.ds.md
   ```
   - Useful for workflows
   - Need to handle failures (continue or stop?)

3. **Should audit logging be opt-in or opt-out?**
   - Option A: Opt-in (`--audit`)
   - Option B: Opt-out (`--no-audit`)
   - Recommendation: Opt-out (audit by default for security)

4. **Should we support dossier chaining/dependencies?**
   ```yaml
   requires:
     - setup-environment.ds.md
     - install-dependencies.ds.md
   ```
   - Powerful for complex workflows
   - Adds complexity to verification

5. **Should `create` open $EDITOR automatically?**
   - Convenient but assumes environment
   - Maybe with `--edit` flag?

---

## Success Metrics

### Phase 1 Success Criteria

**Infrastructure** (5/6 complete):
- [x] CLI structure with commander.js
- [x] Help system
- [x] Documentation updated
- [x] Published to npm
- [x] Smart version detection in workflow
- [ ] 90% test coverage

**Commands** (2/4 complete):
- [x] `verify` command working
- [x] `run` command working (5-stage verification)
- [ ] `create` command working
- [ ] `list` command working

**Features** (2/2 complete):
- [x] LLM auto-detection for Claude Code and Cursor
- [x] Console audit logging

### User Adoption Metrics

- [ ] 50+ GitHub stars
- [ ] 10+ weekly npm downloads
- [ ] 5+ community dossiers created
- [ ] 0 critical security issues

### Developer Experience

- [ ] Clear, helpful error messages
- [ ] Fast execution (< 500ms for verify)
- [ ] Intuitive command names
- [ ] Good defaults (minimal flags needed)

---

## Related

- Issue #27: npm publishing
- Issue #28: Standalone binaries
- [CLI README](../../cli/README.md)
- [Architecture Overview](../architecture/overview.md)

---

## Next Steps (Priority Order)

### Immediate (v0.2.x)

**1. Implement `dossier run` command** (P0 - Highest value)
- [ ] Integrate with `dossier verify` logic
- [ ] Add LLM auto-detection (claude-code, cursor)
- [ ] Implement console audit logging
- [ ] Add user prompts for high-risk dossiers
- [ ] Execute via detected LLM
- [ ] Add `--dry-run`, `--force`, `--no-prompt` options
- **Target**: v0.2.1
- **Effort**: 1-2 days
- **Issue**: Create issue for implementation

**2. Implement `dossier create` command** (P1 - Enable authoring)
- [ ] Interactive mode with prompts
- [ ] Basic template (frontmatter + structure)
- [ ] Auto-calculate checksum
- [ ] Option to open in $EDITOR
- **Target**: v0.2.2
- **Effort**: 1 day
- **Issue**: Create issue for implementation

**3. Implement `dossier list` command** (P1 - Discovery)
- [ ] Scan directory for .ds.md files
- [ ] Parse metadata from each
- [ ] Display table format
- [ ] Add --recursive option
- **Target**: v0.2.3
- **Effort**: 1 day
- **Issue**: Create issue for implementation

### Short Term (v0.3.x - Phase 2)

**4. Implement `dossier sign` command** (P2)
**5. Implement `dossier publish` command** (P2 - MVP simulation)
**6. Implement `dossier checksum` command** (P2)
**7. Implement `dossier validate` command** (P2)

### Medium Term (v0.4.x - Phase 3)

**8. Registry server development**
**9. Full publish/search/install integration**
**10. Advanced commands** (info, diff, export, audit)

---

**Current Status**: ✅ v0.2.9 Released - Phase 2 75% Complete: MCP Prompts + List + Sign + Checksum + Validate

**Last Updated**: 2025-11-28 (v0.2.9 release - MCP prompts for Claude Code integration)
