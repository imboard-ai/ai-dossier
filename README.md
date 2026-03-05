# Dossier — Automation Instructions for AI Agents

**Stop writing brittle scripts. Start writing instructions that AI executes intelligently.**

✅ Portable workflows that adapt to your project
✅ Built-in verification (checksums, signatures, success criteria)
✅ Works with Claude, ChatGPT, Cursor—any LLM

[![Spec](https://img.shields.io/badge/Dossier%20Spec-v1.0-blue)](#)
[![MCP Ready](https://img.shields.io/badge/MCP-Ready-brightgreen)](#)
[![Security](https://img.shields.io/badge/Verification-Checksums%20%26%20Signatures-yellow)](#)
[![GitHub](https://img.shields.io/github/stars/imboard-ai/ai-dossier?style=social)](https://github.com/imboard-ai/ai-dossier)

> **Quick Concept**
> Dossier turns plain-text instructions into executable workflows with built-in verification.
> Like Dockerfiles for AI automation—structured, portable, verifiable.

**New here?** → [5-min Quick Start](docs/getting-started/installation.md) | **Want to try now?** → [30-sec demo](#try-it-now)

---

## At a Glance

📝 **What**: Structured instruction files (`.ds.md`) that AI agents execute intelligently
🎯 **Why**: Replace brittle scripts with adaptive, verifiable automation that handles edge cases naturally
⚡ **How**: Create dossier → Run with your AI → Get validated results with evidence
🔒 **Safety**: Built-in checksums, cryptographic signatures, and CLI verification tools
🌐 **Works with**: Claude, ChatGPT, Cursor, any LLM—no vendor lock-in

**Status**: v1.0 protocol | 15+ production examples | Active development

---

## Try it Now

**Option A — Claude Code with MCP (Recommended)**

Add the Dossier MCP server to enable automatic verification:

**Step 1**: Create or edit `~/.claude/settings.local.json`
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

**Step 2**: Restart Claude Code to load the MCP server

---

**Option B — Command-Line Verification (Works Anywhere)**

Verify dossier security before execution:

```bash
# Clone the repo and use the CLI verification tool
git clone https://github.com/imboard-ai/ai-dossier.git
cd dossier
chmod +x cli/bin/dossier-verify
cli/bin/dossier-verify examples/git-project-review/atomic/readme-reality-check.ds.md
```

---

**Option C — Try with Any LLM (Zero Installation)**

Copy this into any LLM chat (Claude, ChatGPT, Gemini):
```markdown
# dossier: hello-world
version: 1.0
objective: Print a friendly greeting and verify success.
steps:
  - "Print: Hello from Dossier 👋"
validate:
  - "Output contains: Hello from Dossier"
success: "You saw the greeting."
```

**Expected result**: The LLM will print "Hello from Dossier 👋" and confirm success.

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

## Examples Gallery

Real-world dossiers demonstrating the protocol across different domains:

| Example | Use Case | Est. Time |
|---------|----------|-----------|
| [Git Project Reality Check](./examples/git-project-review/) | Audit README claims against actual code with evidence | ~5 min |
| [Setup React Library](./examples/development/setup-react-library.ds.md) | Initialize production-ready component library with TypeScript, Storybook, tests | ~10 min |
| [ML Training Pipeline](./examples/data-science/train-ml-model.ds.md) | Train and validate ML models with reproducible experiment logs | ~10-15 min |
| [DB Migration](./examples/database/migrate-schema.ds.md) | Execute schema changes with automatic backup and rollback capability | ~10 min |
| [AWS Deploy](./examples/devops/deploy-to-aws.ds.md) | Deploy applications to AWS with infrastructure validation | ~15 min |

**Who should try these**: Project maintainers, DevOps/SRE teams, ML engineers, frontend developers

**Run the first one now:**

Ask your LLM:
```
Analyze my project using the readme-reality-check dossier from:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md
```

---

## Security & Verification

- Use the CLI tool (`cli/bin/dossier-verify`) to verify checksums/signatures before execution
- Prefer MCP mode for sandboxed, permissioned operations
- See [SECURITY_STATUS.md](./SECURITY_STATUS.md) for current guarantees and limitations

---

## Adopter Playbooks

- **Solo Dev**: paste a `.ds.md` into your LLM and run via MCP or CLI
- **OSS Maintainer**: add `/dossiers` + a CI check that runs the Reality Check on your README
- **Platform Team**: start with init → deploy → rollback dossiers; wire secrets & scanners

👉 Detailed playbooks in [docs/guides/adopter-playbooks.md](docs/guides/adopter-playbooks.md)

---

# Understanding Dossiers

**Dossiers** are intelligent instruction files that leverage LLM agents to automate complex workflows with adaptability and continuous improvement.

---

## What Are Dossiers?

A **dossier** is a structured instruction file (`.ds.md`) that an AI agent can execute. Instead of writing complex scripts that try to handle every edge case, dossiers provide **clear instructions** that LLM agents (like Claude Code, GPT-4, Cursor, Copilot) can follow intelligently.

> **❓ Questions?** See [FAQ](docs/explanation/faq.md) for common objections and detailed comparisons to alternatives (AGENTS.md, scripts, CI/CD, frameworks).

### The Concept

Modern developers **already have access to LLMs** in their workflows—82% use ChatGPT, 43% use GitHub Copilot[^17][^18][^19][^20]! So why write brittle shell scripts when we can provide structured guidance for intelligent agents?

**Traditional Approach** (brittle)[^21][^22][^23]:
```bash
# Complex script with 200+ lines
# Must handle: all project types, all edge cases, all errors
# Breaks when encountering unexpected setup
./setup-wizard.sh
```

**Dossier Approach** (adaptive):
```markdown
# Clear instructions for intelligent agent
# Agent adapts to actual project context
# Handles edge cases naturally through understanding
```

### Dossiers vs. AGENTS.md Files

**Key difference**: AGENTS.md files provide **project-level context** (architecture, conventions), while dossiers provide **workflow-level automation** with validation and security.

**They're complementary**: Use AGENTS.md for project understanding + dossiers for specific tasks. See [FAQ](docs/explanation/faq.md) for detailed comparison with concrete examples.

---

## 🔄 Self-Improving Dossiers

**One of Dossier's unique features**: Dossiers can improve through execution, learning from your project's specific needs.

Dossiers follow the **Dossier Execution Protocol** ([PROTOCOL](docs/reference/protocol.md)) which includes a **self-improvement system**.[^15][^16]

### How It Works

**Every dossier execution** is an opportunity to improve the dossier:

1. **Before executing**: LLM analyzes dossier quality
2. **Context-aware**: Identifies improvements based on YOUR project
3. **Suggests enhancements**: Proposes specific additions/refinements
4. **You decide**: Accept, iterate, or skip
5. **Continuously improves**: Dossiers get better with each use

**Example**:
```
User: "Use project-init dossier"

LLM: 🔄 Improvement Suggestion
     Your project has Python venv/ but dossier doesn't check for it.
     Should I add Python virtual environment detection? (y/N)

User: "yes"

LLM: ✓ Enhanced dossier with Python support
     ✓ Executing improved version...
```

**Protocol Version**: Each dossier specifies which protocol version it follows (e.g., v1.0)

📚 **Full protocol**: [PROTOCOL.md](./PROTOCOL.md)

---

## 🌐 Open Protocol, Not Vendor Lock-In

**A common question at this point**: "Who controls this protocol? Am I locked into a vendor?"

**Short answer**: You control it. Dossier is an open protocol, not a proprietary system.

Dossiers are an **OPEN PROTOCOL**, like Docker containers or HTTP - not a proprietary system:

### What "Open Protocol" Means

- ✅ **Specification is open source** - Full protocol publicly documented
- ✅ **Anyone can create dossiers** - No permission or licensing required
- ✅ **Anyone can execute dossiers** - Works with any LLM (Claude, GPT, Gemini, local models)
- ✅ **No external dependencies** - Dossiers are local markdown files
- ✅ **Multiple implementations encouraged** - Build your own tools and executors
- ✅ **Community-driven evolution** - Protocol changes via RFC process

### Governance Model

| Aspect | Status |
|--------|--------|
| Protocol specification | Open (Apache 2.0 after 2028, BSL 1.1 now) |
| Creating dossiers | Free & open |
| Executing dossiers | No restrictions |
| Tooling | Open source + optional commercial services |
| Protocol changes | Semantic versioning + community input |

**Think of it like**:
- **Docker**: Open container spec, optional registry services
- **Git**: Open protocol, optional hosting (GitHub, GitLab)
- **HTTP**: Open standard, various implementations

### What We Provide (Optional)

- Registry hosting (you can self-host)
- Signing key management (you can use your own keys)
- Premium tools (basic tools are open source)
- Enterprise support

**Your dossiers are yours** - stored in your repos, executable locally, no external calls required.

**See [FAQ.md § Protocol & Governance](./FAQ.md#protocol--governance) for detailed trust model.**

---

## 🔒 Security & Trust

Dossiers contain executable instructions, so **security is critical**. The Dossier system includes multiple layers of protection:

### Integrity Verification (Required)

Every dossier includes a **SHA256 checksum** to verify it hasn't been tampered with:

```json
{
  "checksum": {
    "algorithm": "sha256",
    "hash": "a3b5c8d9e1f2..."
  }
}
```

**Before execution**, LLM agents must verify the checksum matches the dossier content. If it doesn't match → **BLOCK execution**.

### Cryptographic Signatures (Optional)

Dossiers can be **signed with minisign** to verify authenticity:

```json
{
  "signature": {
    "algorithm": "minisign",
    "public_key": "RWT...",
    "signature": "...",
    "signed_by": "Imboard AI <security@imboard.ai>"
  }
}
```

**Trust levels:**
- ✅ **VERIFIED**: Signed by a key you trust
- ⚠️  **SIGNED_UNKNOWN**: Valid signature, unknown signer
- ⚠️  **UNSIGNED**: No signature (integrity still checked)
- ❌ **INVALID**: Signature failed → **BLOCK execution**

### Risk Assessment

Every dossier declares its risk level and operations:

```json
{
  "risk_level": "high",
  "risk_factors": ["modifies_cloud_resources", "requires_credentials"],
  "requires_approval": true,
  "destructive_operations": [
    "Creates/updates AWS infrastructure",
    "Modifies IAM roles"
  ]
}
```

**High-risk dossiers require user approval** before execution.

### Verification Tools

```bash
# Verify integrity + authenticity
node tools/verify-dossier.js path/to/dossier.md

# Sign a dossier (authors)
node tools/sign-dossier.js path/to/dossier.md --key your-key.key
```
### Trust Model

Like Docker Hub, Dossier uses **decentralized trust**:
- **Official dossiers**: Signed with AWS KMS by Imboard AI (see [KEYS.txt](./KEYS.txt))
- **Community dossiers**: Signed with minisign by their authors
- **You decide**: Which keys to trust in `~/.dossier/trusted-keys.txt`

📚 **Security Documentation**:
- **[security/](./security/)** - Complete security documentation hub
- **[SECURITY.md](./SECURITY.md)** - Vulnerability disclosure policy
- **[security/ARCHITECTURE.md](./security/ARCHITECTURE.md)** - Security architecture
- **[security/THREAT_MODEL.md](./security/THREAT_MODEL.md)** - Threat analysis
- **[security/KEY_MANAGEMENT.md](./security/KEY_MANAGEMENT.md)** - Key lifecycle management

---

## MCP Server Integration

### What is the MCP Server?

The **Dossier MCP Server** is a [Model Context Protocol](https://modelcontextprotocol.io) integration that enables Claude Code (and other MCP-compatible tools) to:

- ⚡ **Automatically verify** dossier security (checksums, signatures)
- 📋 **Discover dossiers** with natural language queries
- 🔒 **Validate authenticity** using cryptographic signatures
- 📖 **Access protocol documentation** built-in
- 🚀 **Streamline execution** with fewer manual steps

### Why Use MCP Server?

**Without MCP Server**:
```
User: "run deploy-to-aws.ds.md"

Claude: "Let me read that file..."
        *Reads file manually*
        "I need to verify the checksum manually..."
        *Guides user through verification*
        "Now let's check the risk level..."
        *Manual risk assessment*
        (5-10 minutes of manual steps)
```

**With MCP Server**:
```
User: "run deploy-to-aws.ds.md"

Claude: *Calls verify_dossier() automatically*
        "✅ Checksum verified
         ⚠️  Unsigned (no signature)
         🔴 High risk: modifies cloud resources

         Proceed? (y/N)"

(Automatic verification in 2 seconds)
```

### Quick Setup

**One-time setup** (5-10 minutes):

```
In Claude Code: "run examples/setup/setup-dossier-mcp.ds.md"
```

This interactive dossier will guide you through configuration.

**Or manually configure**:

1. Edit `~/.claude/settings.local.json`
2. Add:
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
3. Restart Claude Code

### With vs Without MCP

| Feature | Without MCP | With MCP |
|---------|-------------|----------|
| **Security Verification** | Manual (5-10 min) | Automatic (2 sec) |
| **Checksum Validation** | Calculate manually | ✅ Automatic |
| **Signature Verification** | External tool needed | ✅ Built-in |
| **Risk Assessment** | Read manually | ✅ Structured display |
| **Dossier Discovery** | File search | ✅ Natural language |
| **Protocol Access** | Read PROTOCOL.md | ✅ Built-in resource |
| **Trust Management** | Manual key checking | ✅ Automatic |

### Configuration Options

#### Option 1: npx (Recommended)

No installation needed - downloads on first use:

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

#### Option 2: Global Install

Explicit installation:

```bash
npm install -g @ai-dossier/mcp-server
```

```json
{
  "mcpServers": {
    "dossier": {
      "command": "dossier-mcp-server"
    }
  }
}
```

### Do I Need MCP Server?

**No!** Dossiers work without MCP server - it just makes them better.

- **With MCP**: Automatic verification, streamlined execution
- **Without MCP**: Manual verification, more steps, fully functional

All dossiers support **fallback to manual execution**.

### ⚠️ Important: Security Verification

**Current Reality**: LLMs don't automatically enforce security checks, even with MCP server.

**For mandatory verification**, use the CLI tool:
```bash
# Verify before executing
dossier-verify https://example.com/dossier.ds.md

# Or use wrapper function
claude-run-dossier https://example.com/dossier.ds.md
```

**See**: [`SECURITY_STATUS.md`](SECURITY_STATUS.md) - Current security status and roadmap

### Learn More

- **Setup Guide**: [`examples/setup/setup-dossier-mcp.ds.md`](examples/setup/setup-dossier-mcp.ds.md)
- **Security Status**: [`SECURITY_STATUS.md`](SECURITY_STATUS.md) - Gaps, vision, current tools
- **CLI Tool**: [`cli/`](cli/) - Command-line verification enforcer
- **Protocol**: [PROTOCOL.md § MCP Server Integration](PROTOCOL.md#-mcp-server-integration)
- **MCP Server Code**: [`mcp-server/`](mcp-server/)

---

## How to Use Dossiers

> **🎯 New to Dossier?** Start with the [5-minute Quick Start Guide](./QUICK_START.md)

Dossiers work with any LLM tool. Choose the method that fits your workflow:

### Quick Reference

| Method | Best For | Setup Time |
|--------|----------|------------|
| [MCP Integration](#mcp-server-integration) | Claude Code users | 2 min (one-time) |
| [File Access](#file-access-method) | Cursor, Aider, Continue | Instant |
| [Copy-Paste](#copy-paste-method) | ChatGPT, Claude.ai, Gemini | Instant |
| [CLI Verification](#security--verification) | Security-critical workflows | 1 min install |

### MCP Integration

If you use Claude Code, the MCP server provides automatic verification and discovery. See the complete [MCP Server Integration](#mcp-server-integration) section for setup.

### File Access Method

For AI tools with file access (Cursor, Aider, Continue):

```
"Execute the deploy-to-aws dossier from examples/devops/deploy-to-aws.ds.md"
```

The AI will read and execute the dossier file directly.

### Copy-Paste Method

For web-based LLMs (ChatGPT, Claude.ai, Gemini):

1. Get the dossier content: `cat path/to/dossier.ds.md`
2. Paste it into your LLM chat
3. The LLM will execute the instructions

**Pro tip**: Include this context for better results:
```
"This is a dossier—a structured workflow for AI agents. Please execute it step-by-step and validate success criteria."
```

---

## Example Dossier Types

Dossiers can be created for any automation workflow. Here are common categories:

### Project Setup Dossiers
- **project-init** - Initialize project structure
- **dependency-install** - Install dependencies
- **environment-setup** - Configure development environment

### Development Workflow Dossiers
- **feature-start** - Begin new feature development
- **code-review** - Automated code review checklist
- **test-setup** - Configure testing framework

### DevOps Dossiers
- **deployment** - Deploy to production/staging
- **backup** - Create backups
- **monitoring-setup** - Configure monitoring

### Maintenance Dossiers
- **cleanup** - Remove temporary files/structures
- **migration** - Data or code migrations
- **rollback** - Revert changes safely

## Implementations

The dossier standard is designed to be implementation-agnostic. Projects can adopt dossiers in various ways:

- **[Sample Implementation](./examples/sample-implementation/)** - Example showing how to organize and document your dossiers
- **[MI6](https://github.com/imboard-ai/mi6)** - An AI-native project automation framework (early adopter)
- **Your project** - Create your own dossier collection for your specific workflows

Want to create an implementation? See [SPECIFICATION.md](./SPECIFICATION.md) for the formal standard.

---

## 📚 Example Dossiers

This repository includes comprehensive example dossiers demonstrating the standard across diverse domains:

### 🔬 Data Science: ML Training Pipeline
**[examples/data-science/train-ml-model.ds.md](./examples/data-science/train-ml-model.ds.md)**

Train a machine learning model with proper validation, evaluation, and artifact management.

**What it demonstrates**:
- ✅ Computational workflows (not just deployment)
- ✅ Data validation and quality checks
- ✅ Python ecosystem (pandas, scikit-learn, numpy)
- ✅ Iterative experimentation with metrics tracking
- ✅ Artifact management (models, scalers, experiment logs)

**Key features**:
- Auto-detects classification vs regression
- Handles missing values and categorical encoding
- Generates performance metrics and feature importance
- Creates reproducible experiment logs
- Includes complete working Python code

**Perfect for**: Data scientists, ML engineers, analytics teams

---

### 🗄️ Database: Schema Migration
**[examples/database/migrate-schema.ds.md](./examples/database/migrate-schema.ds.md)**

Execute database schema migrations with comprehensive safety checks and rollback capability.

**What it demonstrates**:
- ✅ High-risk stateful operations
- ✅ ACID transaction workflows
- ✅ Multiple database types (PostgreSQL, MySQL, MongoDB, SQLite)
- ✅ Robust rollback procedures
- ✅ Data integrity validation

**Key features**:
- Automatic pre-migration backup
- Dry-run testing before production execution
- Transaction-based migration (where supported)
- Post-migration validation suite
- Complete rollback scripts

**Perfect for**: DevOps engineers, database administrators, backend developers

---

### ⚛️ Frontend Development: React Component Library
**[examples/development/setup-react-library.ds.md](./examples/development/setup-react-library.ds.md)**

Create a production-ready React component library with TypeScript, Storybook, and testing.

**What it demonstrates**:
- ✅ Development tooling setup (not operations)
- ✅ NPM publishing workflow
- ✅ Frontend ecosystem (React, Vite, Storybook)
- ✅ Multi-tool configuration
- ✅ Build optimization

**Key features**:
- TypeScript strict mode with generated type definitions
- Vite bundler with multiple output formats (ESM, CJS)
- Storybook for interactive documentation
- Vitest + React Testing Library
- Complete example components with tests and stories

**Perfect for**: Frontend developers, UI/UX engineers, design system teams

---

### 🚀 DevOps: AWS Deployment
**[examples/devops/deploy-to-aws.ds.md](./examples/devops/deploy-to-aws.ds.md)**

Deploy applications to AWS using Infrastructure as Code with validation and rollback.

**What it demonstrates**:
- ✅ Cloud infrastructure automation
- ✅ Infrastructure as Code (Terraform/CloudFormation)
- ✅ Deployment workflows
- ✅ Environment management

**Perfect for**: DevOps teams, cloud engineers, SREs

---

### 🔍 Git Project Review: LLM-Powered Analysis
**[examples/git-project-review/](./examples/git-project-review/)**

Atomic dossiers that analyze Git projects to surface insights requiring deep code understanding.

**What it demonstrates**:
- ✅ **Real LLM value** - Analysis impossible without understanding context
- ✅ **Atomic & composable** - Small, focused dossiers as building blocks
- ✅ **Dogfooding** - Can be run on the Dossier project itself
- ✅ **Universal utility** - Works on any Git project

**Available dossiers**:
- **readme-reality-check** (~30-60s) - Compares README claims vs actual code
- **onboarding-friction** (~45-90s) - Identifies new contributor pain points
- **architecture-patterns** (~60-90s) - Finds inconsistent patterns and duplication
- **schema-capability-check** (~1-2min) - Meta-tool to explore if features exist

**How to run** (works today):
```
Analyze https://github.com/yourorg/yourproject using:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md
```

Your LLM fetches the dossier, analyzes the project, and provides structured output with:
- Specific findings with file:line references
- Evidence-based insights (not speculation)
- Actionable recommendations

**Perfect for**: Maintainers, contributors, auditors analyzing any codebase

**Future vision**: Once composition is supported, these atomics combine into comprehensive audit suites.

---

### Why These Examples Matter

These dossiers prove the **universal applicability** of the dossier standard:

| Domain | Example | Complexity | Risk Level |
|--------|---------|-----------|------------|
| **Data Science** | ML Training | Medium | Low (local) |
| **Database** | Schema Migration | High | **Critical** |
| **Frontend** | React Library | Medium | Low (dev tools) |
| **DevOps** | AWS Deploy | High | High (infrastructure) |
| **Code Analysis** | Git Project Review | Low-Medium | None (read-only) |

**Each example includes**:
- ✅ Real, executable code (not placeholders)
- ✅ Complete before/after examples
- ✅ Comprehensive troubleshooting sections
- ✅ Validation procedures
- ✅ Context detection and decision trees
- ✅ LLM-executable instructions

**Domain diversity proves**:
- Dossiers work for **data processing**, **infrastructure**, **development**, and **analysis**
- Handle both **stateless** (ML training) and **stateful** (database) operations
- Support **local** (React library) and **remote** (AWS) execution
- Scale from **no-risk** (read-only analysis) to **critical** (database migration)
- Demonstrate **composability** (atomic analysis building blocks)

---

## Dossiers vs Scripts

Use **both** dossiers and traditional scripts - each for what they do best:

### Use Dossiers When:
- ✅ Context awareness needed (detect project structure)
- ✅ Decisions required (which templates to use)
- ✅ Adaptation needed (handle unexpected setups)
- ✅ User guidance helpful (explain choices)

### Use Scripts When:
- ✅ Inputs are clear and deterministic
- ✅ Fast execution matters
- ✅ No decisions needed
- ✅ Same operation every time

### Examples

| Task | Approach | Why |
|------|----------|-----|
| Set ENV variable | Script ✅ | Simple, deterministic |
| **Initialize project** | **Dossier** ✅ | Needs to understand project |
| Run benchmarks | Script ✅ | Fixed commands |
| **Setup development** | **Dossier** ✅ | Needs context detection |
| Validate config | Script ✅ | Schema checking |
| **Generate config** | **Dossier** ✅ | Needs intelligence |

---

## Dossier Structure

Every dossier follows this format:

```markdown
# Dossier: [Name]

## Objective
Clear statement of what this accomplishes

## Prerequisites
What must exist before running this dossier

## Context to Gather
What the LLM should analyze in the project:
- Directory structure
- Existing files
- Git repositories
- Configuration files

## Decision Points
Key choices the LLM needs to make:
- Which template to use
- What values to set
- How to handle edge cases

## Actions to Perform
Step-by-step instructions:
1. Do X
2. Do Y
3. Do Z

## Validation
How to verify success:
- Check file X exists
- Verify Y is valid
- Confirm Z works

## Example
Show what the expected result looks like

## Troubleshooting
Common issues and how to resolve them
```

---

## 🔬 Dossier Schema (v1.0.0)

**New in v1.0.0**: Dossiers now support **structured JSON metadata** via frontmatter, providing deterministic validation and tooling foundation.

### The Problem: Inconsistency & Ambiguity

Without a schema, LLMs interpret Dossiers based on training. This creates brittleness:

| **Without Schema** | **With Schema** |
|-------------------|-----------------|
| ❌ Ambiguous - LLM must infer metadata | ✅ Deterministic - explicit machine-readable structure |
| ❌ Brittle - model updates can break execution | ✅ Robust - validated before execution |
| ❌ Isolated - hard to search/categorize programmatically | ✅ Integrated - tooling-ready (CLI, IDE, registries) |
| ❌ Unpredictable costs - unknown tool requirements | ✅ Predictable - know tools/deps before execution |

### Why Structure Matters for LLMs

**"LLMs work fine without structure!"** - Yes, but they work BETTER with it[^1][^2]:

1. **Deterministic Parsing**: Extract metadata without LLM interpretation[^3][^4]
   - Without schema: LLM spends tokens figuring out "Where are prerequisites?"
   - With schema: `metadata.prerequisites` is always in the same place (zero parsing cost)

2. **Fast Validation**: Catch errors before expensive LLM execution[^5]
   - Schema validation: milliseconds, zero cost
   - LLM interpretation errors: discovered during expensive execution

3. **Reduced Model Variance**: Clear schema = consistent interpretation[^6][^7][^8]
   - GPT-4 and Claude interpret the same structured dossier identically
   - Freeform markdown can be interpreted differently across models

4. **Tooling Foundation**: Enable CLI tools, IDEs, registries, and automation[^24][^25]
   - Structured metadata = machine-readable
   - CLIs can validate without an LLM
   - IDEs can provide autocomplete
   - Registries can index and search

5. **Predictable Costs**: Know requirements before execution
   - See tool requirements upfront
   - Estimate complexity before LLM call

### Schema Format

Dossiers can include JSON frontmatter at the top of the file:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Deploy to AWS",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Deploy application to AWS using Infrastructure as Code",
  "category": ["devops", "deployment"],
  "tags": ["aws", "terraform", "ecs"],
  "tools_required": [
    {
      "name": "terraform",
      "version": ">=1.0.0",
      "check_command": "terraform --version"
    }
  ],
  "risk_level": "high",
  "relationships": {
    "preceded_by": [
      {
        "dossier": "setup-aws-infrastructure",
        "condition": "required",
        "reason": "Infrastructure must exist before deployment"
      }
    ]
  },
  "inputs": {
    "required": [
      {
        "name": "environment",
        "description": "Target environment (dev/staging/production)",
        "type": "string",
        "validation": "^(dev|staging|production)$"
      }
    ]
  }
}
---

# Dossier: Deploy to AWS

[Rest of markdown content...]
```

### Key Schema Features

**Required Fields**:
- `dossier_schema_version`: Schema version (currently `"1.0.0"`)
- `title`: Dossier name
- `version`: Semantic version
- `protocol_version`: Protocol compliance version
- `status`: Lifecycle status (`Draft`, `Stable`, `Deprecated`, `Experimental`)
- `objective`: Clear, measurable goal statement

**Organization & Discovery**:
- `category`: Primary categories (devops, database, development, etc.)
- `tags`: Free-form tags for searchability
- `tools_required`: List of required CLI tools with versions

**Relationships**:
- `preceded_by`: Dossiers that should run before this one
- `followed_by`: Dossiers that should run after
- `alternatives`: Alternative approaches for similar goals
- `conflicts_with`: Incompatible Dossiers
- `can_run_parallel_with`: Dossiers that can execute simultaneously

**Inputs & Outputs**:
- `inputs.required`: Required parameters with validation
- `inputs.optional`: Optional parameters with defaults
- `outputs.files`: Files created/modified
- `outputs.configuration`: Configuration values produced
- `outputs.artifacts`: Generated scripts, logs, reports

**Validation & Safety**:
- `risk_level`: Risk assessment (`low`, `medium`, `high`, `critical`)
- `prerequisites`: Requirements that must be met
- `validation.success_criteria`: Verifiable success conditions
- `rollback`: Rollback capability information

### Validation Tools

Validate Dossiers programmatically before execution:

**Node.js**:
```bash
cd examples/validation
npm install ajv ajv-formats
node validate-dossier.js ../devops/deploy-to-aws.ds.md
```

**Python**:
```bash
pip install jsonschema
python validate-dossier.py ../devops/deploy-to-aws.ds.md
```

**Output**:
```
🔍 Validating: ../devops/deploy-to-aws.ds.md

✓ Frontmatter extracted successfully
  Title: Deploy to AWS
  Version: 1.0.0
  Status: Stable

✅ VALID - Dossier schema is compliant
```

### Backward Compatibility

**Important**: Dossiers without schema frontmatter remain valid and can be executed by LLM agents. The schema is an **enhancement**, not a breaking change.

- ✅ **Legacy Dossiers**: Pure markdown Dossiers still work
- ✅ **Gradual Adoption**: Add schema to new Dossiers first
- ✅ **Dual Format**: Can keep both JSON frontmatter and markdown metadata during transition

### Complete Documentation

- **[SCHEMA.md](./SCHEMA.md)** - Complete schema specification
- **[dossier-schema.json](./dossier-schema.json)** - JSON Schema definition
- **[examples/validation/](./examples/validation/)** - Validation tools and examples
- **[templates/dossier-template.md](./templates/dossier-template.md)** - Updated template with schema

### Example with Schema

See **[examples/devops/deploy-to-aws.ds.md](./examples/devops/deploy-to-aws.ds.md)** for a complete example Dossier with schema frontmatter.

---

## Creating Custom Dossiers

### Naming Convention

**All dossier files should use the `.ds.md` extension** to clearly identify them as dossier files:

```bash
✅ add-git-worktree-support.ds.md
✅ deploy-to-production.ds.md
✅ setup-development-environment.ds.md

❌ setup-project.md  # Could be regular documentation
❌ dossier-deploy.md # Unclear naming
```

**Benefits**:
- Instantly recognizable as dossier files
- Won't be confused with regular documentation
- Tools can easily glob for `**/*.ds.md`
- Follows common patterns (`.test.js`, `.spec.ts`, etc.)

### 1. Use the Template

Start with the dossier template:

```bash
cp templates/dossier-template.md \
   dossiers/my-custom-dossier.ds.md
```

### 2. Follow the Format

Fill in all sections. Be specific and clear. The LLM will follow your instructions literally.

### 3. Test with an LLM

Try your dossier with an AI assistant. Refine based on results.

### 4. Share with Community

Share useful dossiers! Contribute to dossier implementations or create your own collection.

---

## Organizing Multiple Dossiers

As your dossier collection grows, organization becomes important. A **dossier registry** helps document relationships, workflows, and navigation paths.

### Why Use a Registry?

When you have multiple dossiers, a registry provides:
- **Quick reference** - Summary table of all dossiers
- **Journey mapping** - Common workflow paths (e.g., greenfield vs brownfield)
- **Relationship documentation** - Which dossiers depend on or complement each other
- **Navigation guidance** - Help users find the right dossier for their needs
- **Output tracking** - What each dossier produces and what consumes it

### Registry Pattern

A dossier registry typically includes:

1. **Quick Reference Table**
   - List all dossiers with version, purpose, and coupling level
   - Helps users scan available automation

2. **Journey Maps**
   - Group dossiers into common workflows
   - Show sequential paths (e.g., "New Project: init → setup → deploy")
   - Visualize with mermaid diagrams

3. **Relationship Matrix**
   - Document dependencies between dossiers
   - Identify sequential, suggested, or conflicting relationships
   - Note coupling levels (loose, medium, tight)

4. **Output Matrix**
   - Track what files/artifacts each dossier creates
   - Document which other dossiers consume those outputs
   - Helps understand data flow

5. **Navigation Guide**
   - User-centric paths ("I want to..." → recommended dossiers)
   - Makes discovery easier for both humans and LLMs

### Example Registry

See **[examples/sample-implementation/dossiers-registry.md](./examples/sample-implementation/dossiers-registry.md)** for a complete example showing:
- Categorization (Setup, Development, Maintenance)
- Journey mapping (Greenfield vs Brownfield paths)
- Relationship and output matrices
- Coupling level classification
- User-centric navigation

### When to Create a Registry

- **3+ dossiers**: Consider a simple list
- **5+ dossiers**: Add categorization and basic relationships
- **10+ dossiers**: Full registry with journeys and matrices

A well-organized registry makes your dossier collection more discoverable and helps LLMs understand how to chain multiple dossiers together intelligently.

---

## Best Practices

### ✅ Do:
- **Be specific**: "Copy all .md files from tasks/active/" not "get the tasks"
- **Show examples**: Include expected output samples
- **Handle errors**: Include troubleshooting sections
- **Validate results**: Always include validation steps
- **Be LLM-agnostic**: Don't use Claude-specific features

### ❌ Don't:
- **Assume context**: Explicitly state what to check
- **Skip validation**: Always verify the outcome
- **Be vague**: "Set up the project" → too broad
- **Hardcode paths**: Use relative paths or configurable variables
- **Require specific LLM**: Should work with any AI

---

## Examples

### Example 1: AWS Deployment

```
User: "Deploy to AWS staging using the deploy-to-aws dossier"

AI: (Follows deploy-to-aws.ds.md dossier)
    ✓ Detected: AWS credentials configured
    ✓ Found: terraform/ configuration
    ✓ Validated: Staging environment exists
    ✓ Running: terraform plan
    ✓ Confirmed: Changes look safe
    ✓ Executing: terraform apply
    ✓ Verified: Deployment successful
    ✓ Output: Staging URL: https://staging.example.com

    "Deployment complete! Staging is live."
```

### Example 2: Project Setup

```
User: "Initialize this Node.js project using project-init dossier"

AI: (Follows project-init.md dossier)
    ✓ Detected: Node.js project (package.json found)
    ✓ Analyzed: Dependencies and scripts
    ✓ Created: Development environment config
    ✓ Set up: .gitignore with Node.js patterns
    ✓ Initialized: Git repository
    ✓ Created: README.md template

    "Project initialized! Ready for development."
```

### Example 3: Database Migration

```
User: "Run the database migration dossier for the user table changes"

AI: (Follows db-migration.md dossier)
    ✓ Detected: PostgreSQL database
    ✓ Validated: Connection to database
    ✓ Created: Backup of current schema
    ✓ Generated: Migration script
    ✓ Reviewed: Changes with user
    ✓ Applied: Migration successfully
    ✓ Verified: Data integrity maintained

    "Migration complete! Backup saved to backups/schema-2025-11-05.sql"
```

---

## Why This Works

### 1. **Adaptive Intelligence**
LLMs can understand your project's unique structure and adapt dossier instructions accordingly.[^9][^10][^11]

### 2. **Less Code to Maintain**
Dossiers are markdown files with instructions, not complex error-prone scripts.

### 3. **Better Error Handling**
LLMs can troubleshoot and retry intelligently rather than crashing on unexpected input.[^12][^13][^14]

### 4. **User Trust**
Users see what the AI is doing and can guide the process, unlike opaque scripts.

### 5. **Community Extensible**
Anyone can write a dossier - no shell scripting expertise required.

---

## Troubleshooting

### "The AI didn't follow the dossier correctly"

**Causes**:
- Dossier instructions too vague
- Missing context about project structure
- Edge case not documented

**Solutions**:
- Make instructions more explicit
- Add examples of expected output
- Update dossier with troubleshooting section

---

### "Dossier works with Claude but not GPT-4"

**Cause**: LLM-specific assumptions

**Solution**: Make dossier more explicit:
- Avoid relying on tool-specific features
- Be very clear about file paths
- Include step-by-step validation

---

### "I don't have access to an LLM"

If you don't have an LLM agent:
- Dossiers can still serve as excellent documentation
- Follow dossier steps manually
- Use traditional automation scripts alongside dossiers
- Dossiers provide clear workflow documentation even without AI execution

---

## Documentation

### Getting Started
- [Quick Start Guide](docs/getting-started/installation.md) - Get started in 5 minutes
- [Tutorials](docs/tutorials/) - Step-by-step learning experiences
- [FAQ](docs/explanation/faq.md) - Frequently asked questions

### Reference
- [Protocol Specification](docs/reference/protocol.md) - Dossier execution protocol
- [Formal Specification](docs/reference/specification.md) - Complete formal specification
- [Schema](docs/reference/schema.md) - Dossier schema specification (v1.0.0)
- [dossier-schema.json](./dossier-schema.json) - JSON Schema definition

### Guides & Examples
- [How-To Guides](docs/guides/) - Task-oriented guides
- [Example Dossiers](./examples/) - Example implementations
- [Adopter Playbooks](docs/guides/adopter-playbooks.md) - Adoption strategies

### Architecture & Contributing
- [Architecture Overview](ARCHITECTURE.md) - System architecture
- [Contributing Guide](CONTRIBUTING.md) - How to contribute
- [Security](SECURITY.md) - Security policy and verification
- [Changelog](CHANGELOG.md) - Version history

### Integrations
- [MCP Server](./mcp-server/) - Model Context Protocol integration
- [CLI Tool](./cli/) - Command-line verification tool
- [Registry](./registry/) - Dossier registry API (deployed via Vercel)
- [MI6](https://github.com/imboard-ai/mi6) - Community implementation example

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

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE). You are free to use, copy, modify, and distribute it, with one restriction: you may not offer it as a hosted or managed service to third parties.

The canonical hosted registry is operated by [ImBoard.ai](https://github.com/imboard-ai) at `dossier-registry.vercel.app`.

## References

[^1]: Liu, M. X., Liu, F., Fiannaca, A. J., Koo, T., Dixon, L., Terry, M., & Cai, C. J. (2024). "We Need Structured Output": Towards User-centered Constraints on Large Language Model Output. *CHI Conference on Human Factors in Computing Systems (CHI EA '24)*.

[^2]: Yang, J., Jiang, D., He, L., et al. (2025). StructEval: Benchmarking LLMs' Capabilities to Generate Structural Outputs. *arXiv:2505.20139*.

[^3]: Perozzi, B., Fatemi, B., Zelle, D., Tsitsulin, A., Kazemi, M., Al-Rfou, R., & Halcrow, J. (2024). Let Your Graph Do the Talking: Encoding Structured Data for LLMs. *arXiv (CS > Machine Learning)*.

[^4]: Microsoft Research. (2024). Token Efficiency with Structured Output from Language Models. *Microsoft Technical Blog*.

[^5]: Grigorev, D. S., Kovalev, A. K., & Panov, A. I. (2025). VerifyLLM: LLM-Based Pre-Execution Task Plan Verification for Robots. *IROS 2025*.

[^6]: Chuang, Y.-N., Tang, R., Jiang, X., & Hu, X. (2024). SPeC: A Soft Prompt-Based Calibration on Performance Variability of Large Language Model in Clinical Notes Summarization. *Journal of Biomedical Informatics*.

[^7]: Errica, F., Siracusano, G., Sanvito, D., & Bifulco, R. (2025). What Did I Do Wrong? Quantifying LLMs' Sensitivity and Consistency to Prompt Engineering. *Annual Conference of the Nations of the Americas Chapter of the Association for Computational Linguistics (NAACL 2025)*.

[^8]: dottxt.ai. (2024). Structured Generation Improves LLM Performance. *Technical Blog/Research*.

[^9]: Zhu, Y., Moniz, J. R. A., Bhargava, S., Lu, J., Piraviperumal, D., Li, S., Zhang, Y., Yu, H., & Tseng, B.-H. (2024). Can Large Language Models Understand Context? *EACL 2024 (Findings)*.

[^10]: Using an LLM to Help With Code Understanding. (2024). *arXiv*.

[^11]: Natural Language based Context Modeling and Reasoning for Ubiquitous Computing with Large Language Models: A Tutorial. (2023). *arXiv:2309.15074*.

[^12]: Tyen, G., Mansoor, H., Cărbune, V., Chen, P., & Mak, T. (2024). LLMs cannot find reasoning errors, but can correct them given the error location. *ACL 2024 Findings*.

[^13]: The STROT Framework: Structured Prompting and Feedback-Guided Reasoning with LLMs for Data Interpretation. (2025). *arXiv:2505.01636*.

[^14]: Are Retrials All You Need? Enhancing Large Language Model Reasoning Without Verbalized Feedback. (2025). *arXiv:2504.12951*.

[^15]: Pan, L., Saxon, M., Xu, W., Nathani, D., Wang, X., & Wang, W. Y. (2024). Automatically Correcting Large Language Models: Surveying the Landscape of Diverse Automated Correction Strategies. *Transactions of the Association for Computational Linguistics (TACL)*, 12, 484-506.

[^16]: Progress or Regress? Self-Improvement Reversal in Post-training. (2024). *arXiv:2407.05013*.

[^17]: Stack Overflow. (2024). Developer Survey 2024. 82% of professional developers use ChatGPT, 43% use Microsoft Copilot, 25% use GitHub Copilot, 16% use Claude.

[^18]: McKinsey. (2024). Enterprise AI Survey 2024. 78% of organizations use AI in at least one business function (up from 55% prior year); 71% enterprise adoption of generative AI.

[^19]: LangChain. (2024). State of AI 2024 Report. 61.7% of developers/ML teams have or plan to have LLM apps in production within a year; 37.3% use AI chatbots in their work every day; 60.6% implementing prompt engineering.

[^20]: Anthropic. (2024). Market Analysis 2024. Anthropic leads enterprise AI with 32% market share; 73% of enterprises spend over $50,000 annually on LLMs; 37% spend over $250,000 annually.

[^21]: Balancing Automation with Human Expertise in Exploratory Testing and Edge-Case Analysis. (2024). *ResearchGate*.

[^22]: De Reanzi, S. R., & Thangaiah, P. R. J. (2021). Survey on Software Test Automation Return on Investment. *SAGE Journals*. Maintenance overhead (fixing script failures) is 22-30% for traditional scripts.

[^23]: DAPLab Research. (2025). Columbia University Technical Blog. Notes that "digital environments are messy and stateful: every agent action perturbs hidden processes, files, and I/O, making single-shot execution brittle."

[^24]: Schema Matching with Large Language Models: an Experimental Study. (2024). *arXiv:2407.11852*.

[^25]: LLM4Schema.org: Generating Schema.org Markups. (2024). *HAL Science*.
