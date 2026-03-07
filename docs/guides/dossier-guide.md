# Dossier Guide

A comprehensive guide to understanding, creating, and using dossiers.

> **New here?** Start with the [Quick Start Guide](../getting-started/installation.md) or the [README](../../README.md) first.

---

## What Are Dossiers?

A **dossier** is a structured instruction file (`.ds.md`) that an AI agent can execute. Instead of writing complex scripts that try to handle every edge case, dossiers provide **clear instructions** that LLM agents (like Claude Code, GPT-4, Cursor, Copilot) can follow intelligently.

> See [FAQ](../explanation/faq.md) for common objections and detailed comparisons to alternatives (AGENTS.md, scripts, CI/CD, frameworks).

### Dossiers vs. AGENTS.md Files

**Key difference**: AGENTS.md files provide **project-level context** (architecture, conventions), while dossiers provide **workflow-level automation** with validation and security.

**They're complementary**: Use AGENTS.md for project understanding + dossiers for specific tasks.

### Dossiers vs Scripts

Use **both** dossiers and traditional scripts - each for what they do best:

| Task | Approach | Why |
|------|----------|-----|
| Set ENV variable | Script | Simple, deterministic |
| **Initialize project** | **Dossier** | Needs to understand project |
| Run benchmarks | Script | Fixed commands |
| **Setup development** | **Dossier** | Needs context detection |
| Validate config | Script | Schema checking |
| **Generate config** | **Dossier** | Needs intelligence |

---

## Dossier Structure

Every dossier follows this format:

```markdown
---dossier
{
  "title": "My Dossier",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "stable",
  "objective": "Clear statement of what this accomplishes",
  "risk_level": "low"
}
---

# Dossier: [Name]

## Objective
Clear statement of what this accomplishes

## Prerequisites
What must exist before running this dossier

## Context to Gather
What the LLM should analyze in the project

## Decision Points
Key choices the LLM needs to make

## Actions to Perform
Step-by-step instructions

## Validation
How to verify success

## Troubleshooting
Common issues and how to resolve them
```

---

## Dossier Schema (v1.0.0)

Dossiers support **structured JSON metadata** via frontmatter, providing deterministic validation and tooling foundation.

### Required Fields

- `dossier_schema_version`: Schema version (currently `"1.0.0"`)
- `title`: Dossier name
- `version`: Semantic version
- `protocol_version`: Protocol compliance version
- `status`: Lifecycle status (`draft`, `stable`, `deprecated`, `experimental`)
- `objective`: Clear, measurable goal statement

### Organization & Discovery

- `category`: Primary categories (devops, database, development, etc.)
- `tags`: Free-form tags for searchability
- `tools_required`: List of required CLI tools with versions

### Relationships

- `preceded_by`: Dossiers that should run before this one
- `followed_by`: Dossiers that should run after
- `alternatives`: Alternative approaches for similar goals
- `conflicts_with`: Incompatible dossiers
- `can_run_parallel_with`: Dossiers that can execute simultaneously

### Inputs & Outputs

- `inputs.required`: Required parameters with validation
- `inputs.optional`: Optional parameters with defaults
- `outputs.files`: Files created/modified
- `outputs.artifacts`: Generated scripts, logs, reports

### External References

- `content_scope`: Whether the body is `"self-contained"` or `"references-external"`
- `external_references`: Manifest of external URLs with `type`, `trust_level`, and `required` status
  - Linter rule `external-references-declared` enforces that all body URLs are declared
  - Scripts with `trust_level: "unknown"` require explicit user approval

### Validation & Safety

- `risk_level`: Risk assessment (`low`, `medium`, `high`, `critical`)
- `prerequisites`: Requirements that must be met
- `validation.success_criteria`: Verifiable success conditions
- `rollback`: Rollback capability information

### Complete Schema Documentation

- [Schema Reference](../reference/schema.md) - Complete schema specification
- [dossier-schema.json](../../dossier-schema.json) - JSON Schema definition
- [Validation examples](../../examples/validation/) - Validation tools

---

## Security & Trust

Dossiers contain executable instructions, so **security is critical**. The system includes multiple layers of protection.

### Integrity Verification

Every dossier includes a **SHA256 checksum** to verify it hasn't been tampered with. Before execution, agents must verify the checksum matches the content.

### Cryptographic Signatures

Dossiers can be signed to verify authenticity. Trust levels:
- **VERIFIED**: Signed by a key you trust
- **SIGNED_UNKNOWN**: Valid signature, unknown signer
- **UNSIGNED**: No signature (integrity still checked)
- **INVALID**: Signature failed - BLOCK execution

### Risk Assessment

Every dossier declares its risk level and destructive operations. High-risk dossiers require user approval before execution.

### Trust Model

Like Docker Hub, Dossier uses **decentralized trust**:
- **Official dossiers**: Signed with AWS KMS by Imboard AI (see [KEYS.txt](../../KEYS.txt))
- **Community dossiers**: Signed by their authors
- **You decide**: Which keys to trust in `~/.dossier/trusted-keys.txt`

See [Security Architecture](../../security/ARCHITECTURE.md) for full details.

---

## Self-Improving Dossiers

Dossiers can improve through execution, learning from your project's specific needs. Every execution is an opportunity to improve:

1. **Before executing**: LLM analyzes dossier quality
2. **Context-aware**: Identifies improvements based on YOUR project
3. **Suggests enhancements**: Proposes specific additions/refinements
4. **You decide**: Accept, iterate, or skip

See the [Protocol](../reference/protocol.md) for full details on the self-improvement system.

---

## Open Protocol

Dossier is an **open protocol**, like Docker containers or HTTP - not a proprietary system:

- Specification is open source
- Anyone can create and execute dossiers
- Works with any LLM (Claude, GPT, Gemini, local models)
- No external dependencies required
- Community-driven evolution via RFC process

See [FAQ - Protocol & Governance](../explanation/faq.md#protocol--governance) for the detailed trust model.

---

## How to Use Dossiers

Dossiers work with any LLM tool:

| Method | Best For |
|--------|----------|
| MCP Integration | Claude Code users |
| File Access | Cursor, Aider, Continue |
| Copy-Paste | ChatGPT, Claude.ai, Gemini |
| CLI Verification | Security-critical workflows |

See the [Quick Start Guide](../getting-started/installation.md) for setup instructions.

---

## Creating Custom Dossiers

### Naming Convention

All dossier files should use the `.ds.md` extension:

```bash
add-git-worktree-support.ds.md
deploy-to-production.ds.md
setup-development-environment.ds.md
```

### Steps

1. **Use the template**: `cp templates/dossier-template.md dossiers/my-custom-dossier.ds.md`
2. **Follow the format**: Fill in all sections. Be specific and clear.
3. **Test with an LLM**: Try your dossier with an AI assistant. Refine based on results.
4. **Publish**: `ai-dossier publish ./my-dossier.ds.md --namespace my-namespace`

---

## Organizing Multiple Dossiers

As your collection grows, a **dossier registry** helps document relationships, workflows, and navigation paths.

- **3+ dossiers**: Consider a simple list
- **5+ dossiers**: Add categorization and basic relationships
- **10+ dossiers**: Full registry with journeys and matrices

See [examples/sample-implementation/dossiers-registry.md](../../examples/sample-implementation/dossiers-registry.md) for a complete registry example.

---

## Best Practices

**Do:**
- Be specific: "Copy all .md files from tasks/active/" not "get the tasks"
- Show examples: Include expected output samples
- Handle errors: Include troubleshooting sections
- Validate results: Always include validation steps
- Be LLM-agnostic: Don't use tool-specific features

**Don't:**
- Assume context: Explicitly state what to check
- Skip validation: Always verify the outcome
- Be vague: "Set up the project" is too broad
- Hardcode paths: Use relative paths or configurable variables

---

## MCP Server Integration

The Dossier MCP Server enables Claude Code to automatically verify dossier security, discover dossiers, and streamline execution.

See [MCP Server README](../../mcp-server/README.md) for setup and details.

---

## Troubleshooting

### "The AI didn't follow the dossier correctly"

- Make instructions more explicit
- Add examples of expected output
- Update dossier with troubleshooting section

### "Dossier works with Claude but not GPT-4"

- Avoid relying on tool-specific features
- Be very clear about file paths
- Include step-by-step validation

### "I don't have access to an LLM"

Dossiers can still serve as excellent documentation. Follow the steps manually or use traditional automation scripts alongside dossiers.
