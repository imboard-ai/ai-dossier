# Dossier Guide

A comprehensive guide to understanding, creating, and using dossiers.

> **New here?** Start with the [Quick Start Guide](../getting-started/quick-start.md) or the [README](../../README.md) first.

---

## What Are Dossiers?

A **dossier** is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in. It's the same kind of thing as a Claude Code `SKILL.md`, plus a cryptographic signature, a pinnable version, and a registry to distribute it through. The same `.ds.md` file runs on Claude Code, GPT, Cursor, or any capable agent.

> See [FAQ](../explanation/faq.md) for common objections and detailed comparisons — including [Isn't a dossier just a skill?](../explanation/faq.md#isnt-a-dossier-just-a-skill) and AGENTS.md, scripts, CI/CD, and frameworks.

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

See the [examples/](../../examples/) directory for dossier examples you can use as templates.

---

## Best Practices

> For comprehensive authoring guidance with examples, see [Authoring Guidelines](authoring-guidelines.md).

**Focus on what and why, not how:**
- State clear objectives and success criteria -- this is the most valuable part of any dossier
- Include constraints and non-obvious requirements (architectural decisions, required tools, environment-specific config)
- Document known pitfalls that would waste significant agent time
- Let agents discover implementation details themselves -- they're good at it

**Invest in validation:**
- Every dossier must include verifiable success criteria
- Prefer automated checks (commands that return pass/fail) over subjective assessments
- Validation is the contract between the dossier author and the executing agent

**Avoid over-specification:**
- Don't provide step-by-step bash commands for standard operations -- agents can figure these out
- Don't name-drop tools unless they're genuine constraints (mentioning a tool makes agents use it 2.5x more, even when it's suboptimal -- [arXiv 2602.11988](https://arxiv.org/abs/2602.11988))
- Don't list information the agent can infer from the codebase (directory trees, file lists, project type)
- Don't write exhaustive troubleshooting for common errors -- agents can read error messages

**Do include non-inferable information:**
- Internal tooling, custom workflows, undocumented APIs
- Environment-specific constraints: credentials, endpoints, required tool versions
- Domain context: business rationale, historical decisions, performance requirements
- Decision criteria: when there are multiple valid approaches, explain how to choose

---

## MCP Server Integration

The Dossier MCP Server enables Claude Code to automatically verify dossier security, discover dossiers, and streamline execution.

See [MCP Server README](../../mcp-server/README.md) for setup and details.

---

## Troubleshooting

### "The AI didn't follow the dossier correctly"

- Clarify the **objective** and **success criteria** -- agents follow goals better than procedures
- Check if the dossier over-specifies *how* instead of *what* -- rigid steps give agents less room to adapt
- Add constraints for the specific behavior you need, rather than more procedural steps

### "Dossier works with Claude but not GPT-4"

- Avoid relying on tool-specific features
- Be very clear about file paths
- Include step-by-step validation

### "I don't have access to an LLM"

Dossiers can still serve as excellent documentation. Follow the steps manually or use traditional automation scripts alongside dossiers.
