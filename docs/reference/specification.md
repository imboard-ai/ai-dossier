# Dossier Specification v1.0

**Version**: 1.0.0
**Status**: Stable
**Last Updated**: 2025-11-05

---

## Abstract

This document defines the **Dossier standard** - a universal format for portable, verifiable, versioned skills. A dossier is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in. Dossiers provide structured guidance that AI agents interpret and execute intelligently, adapting to project-specific contexts while maintaining consistency and safety.

---

## 1. Introduction

### 1.1 Purpose

The Dossier specification establishes a standard format for creating automation instructions that:
- LLM agents can execute reliably across different implementations
- Adapt to project-specific contexts rather than hardcoding assumptions
- Improve continuously through structured feedback
- Maintain safety and validation standards

### 1.2 Scope

This specification covers:
- Required and optional sections in a dossier document
- Structural requirements and formatting conventions
- Protocol compliance requirements
- Validation and success criteria
- Versioning and compatibility

### 1.3 Target Audience

- **Dossier Authors**: Creating automation workflows
- **Implementation Developers**: Building dossier-based systems
- **LLM Agents**: Executing dossier instructions
- **End Users**: Understanding dossier capabilities

---

## 2. What is a Dossier?

### 2.1 Definition

A **dossier** is a skill — a reusable instruction set an AI executes — expressed as a structured markdown document, with the trust, versioning, and portability needed to share it safely across tools. It is the same kind of artifact as a Claude Code `SKILL.md`, plus a cryptographic signature, a pinnable version, and a registry path.

### 2.2 Key Characteristics

**Dossiers are**:
- ✅ **Declarative**: Describe what should be accomplished, not exact commands
- ✅ **Context-aware**: Instructions adapt based on analyzed project state
- ✅ **Verifiable**: Carry a checksum and optional signature, checked before execution
- ✅ **Versioned**: Semantically versioned and pinnable
- ✅ **Portable**: Work with any capable LLM agent, on any tool
- ✅ **Self-improving**: Can be enhanced based on execution feedback

**Dossiers add, on top of a plain skill**:
- 🔏 **Trust**: integrity + authenticity verification (a plain skill has none)
- 📌 **Versioning**: explicit semantic versions instead of informal edits
- 🌐 **Distribution**: a registry that makes skills discoverable and installable
- 🔁 **Portability**: one file that runs across LLM tools, not locked to one

### 2.3 Use Cases

Dossiers are ideal for:
- Project initialization and setup
- Multi-step deployment workflows
- Context-dependent configuration generation
- Complex maintenance operations
- Cross-repository coordination
- Environment-aware automation

---

## 3. Document Structure

### 3.1 Required Sections

Every compliant dossier **MUST** include these sections:

#### 3.1.1 Header

```markdown
# Dossier: [Name]

**Version**: [semver]
**Protocol Version**: [protocol-version]
**Status**: [Draft|Stable|Deprecated]
```

**Requirements**:
- Clear, descriptive name
- Semantic version number (MAJOR.MINOR.PATCH)
- Protocol version reference (e.g., "1.0")
- Status indicator

#### 3.1.2 Objective

```markdown
## Objective

[Clear statement of what this dossier accomplishes]
```

**Requirements**:
- Single, focused purpose
- Measurable outcome
- Written from user perspective
- 1-3 sentences maximum

#### 3.1.3 Prerequisites

```markdown
## Prerequisites

- [Condition that must be true before execution]
- [Required tool, file, or state]
- [Permission or access requirement]
```

**Requirements**:
- List all required preconditions
- Include validation commands where possible
- Specify required tools/permissions
- Define minimum versions if applicable

#### 3.1.4 Actions

```markdown
## Actions to Perform

1. [First action with clear instructions]
2. [Second action]
3. [Third action]
...
```

**Requirements**:
- Sequential, numbered list
- Clear, actionable instructions
- Include decision points explicitly
- Reference context gathering results

#### 3.1.5 Validation

```markdown
## Validation

**Success Criteria**:
1. [Verifiable criterion]
2. [Another criterion]

**Verification Commands**:
```bash
[Commands to verify success]
```
```

**Requirements**:
- Specific, measurable success criteria
- Concrete verification steps
- Clear pass/fail conditions

### 3.2 Recommended Sections

Dossiers **SHOULD** include these sections when applicable:

#### 3.2.1 Context to Gather

```markdown
## Context to Gather

Before taking actions, analyze:
- [Aspect of project to examine]
- [Configuration to detect]
- [State to verify]
```

**Purpose**: Guide LLM in understanding project-specific context

#### 3.2.2 Decision Points

```markdown
## Decision Points

### Decision 1: [Description]

**Options**:
- Option A: [When to use]
- Option B: [When to use]

**Recommendation**: [Default choice with rationale]
```

**Purpose**: Document key choices and guidance for LLM

#### 3.2.3 Example

```markdown
## Example

**Scenario**: [Description of example project]

**Expected Output**:
```
[Sample output showing success]
```
```

**Purpose**: Clarify expected results and format

#### 3.2.4 Troubleshooting

```markdown
## Troubleshooting

### Issue: [Common problem]

**Symptoms**: [How to identify]
**Cause**: [Why it occurs]
**Solution**: [How to resolve]
```

**Purpose**: Handle common edge cases and errors

### 3.3 Optional Sections

Dossiers **MAY** include additional sections as needed:
- **Background**: Context about why this dossier exists
- **Related Dossiers**: Links to complementary dossiers
- **Advanced Options**: Power-user features
- **Rollback**: How to undo changes
- **FAQ**: Frequently asked questions

### 3.4 Schema Frontmatter (RECOMMENDED)

As of Dossier Specification v1.0.0, dossiers **SHOULD** include structured metadata using JSON frontmatter:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Deploy Application to AWS",
  "version": "1.2.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Deploy a containerized application to AWS ECS",
  "category": ["devops", "deployment"],
  "tags": ["aws", "ecs", "docker"],
  "tools_required": [
    {
      "name": "terraform",
      "version": ">=1.0.0",
      "check_command": "terraform --version"
    }
  ],
  "relationships": {
    "preceded_by": [
      {
        "dossier": "setup-aws-infrastructure",
        "condition": "required",
        "reason": "Infrastructure must exist before deployment"
      }
    ]
  }
}
---

# Dossier: Deploy Application to AWS
[... rest of markdown content ...]
```

**Purpose**: The schema frontmatter provides:
- **Deterministic parsing**: Machine-readable metadata without LLM interpretation
- **Fast validation**: Schema validation before expensive LLM execution
- **Tooling foundation**: Enables CLI tools, IDEs, registries, and automation
- **Searchability**: Programmatic discovery by category, tags, tools, dependencies
- **Predictable costs**: Know required tools and dependencies before execution

**Format Requirements**:
- Placed at the **very top** of the file (before any markdown content)
- Delimited by `---dossier` and `---`
- Valid JSON format (validated against `dossier-schema.json`)
- Must include required fields: `dossier_schema_version`, `title`, `version`, `protocol_version`, `status`, `objective`

**Complete Documentation**: See [SCHEMA.md](./schema.md) for:
- Complete field reference
- Validation rules
- Examples
- Migration guide from pure Markdown dossiers
- Best practices

**Backward Compatibility**: Dossiers without schema frontmatter remain valid and can be executed by LLM agents. The schema is an enhancement, not a breaking change.

### 3.5 MCP Integration (Optional)

The `mcp_integration` field enables dossiers to declare MCP server requirements and fallback behavior. This allows LLMs to detect when the dossier MCP server is available and provide streamlined, automatic security verification.

#### Example 1: High-Risk Dossier with MCP Benefits

For high-risk dossiers, MCP provides automatic security verification but manual execution is still possible:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Deploy to AWS",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Deploy application to AWS ECS with automated rollback",
  "category": ["devops", "deployment"],
  "risk_level": "high",
  "mcp_integration": {
    "required": false,
    "server_name": "@ai-dossier/mcp-server",
    "min_version": "1.0.0",
    "features_used": ["verify_dossier", "dossier://security"],
    "fallback": "manual_execution",
    "benefits": [
      "Automatic checksum and signature verification",
      "Clear risk assessment presentation",
      "Streamlined approval workflow"
    ]
  }
}
---

# Dossier: Deploy to AWS
[... rest of content ...]
```

**LLM Behavior**:
- Tries `verify_dossier()` tool first
- If not available, offers MCP setup guidance
- If user declines, proceeds with manual verification
- Never blocks execution (fallback: manual_execution)

---

#### Example 2: Medium-Risk with Optional MCP

Medium-risk dossiers work well without MCP but benefit from it:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Train ML Model",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Train and evaluate a machine learning model with proper validation",
  "category": ["data-science"],
  "risk_level": "medium",
  "mcp_integration": {
    "required": false,
    "features_used": ["verify_dossier"],
    "fallback": "manual_execution"
  }
}
---

# Dossier: Train ML Model
[... rest of content ...]
```

**LLM Behavior**:
- Briefly mentions MCP availability if detected
- Doesn't push hard for setup
- Proceeds with manual mode if MCP not configured
- Focuses on executing the workflow

---

#### Example 3: Bootstrap/Setup Dossier

Setup dossiers that configure MCP should not require it (avoids chicken-and-egg problem):

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Set Up Dossier MCP Server",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Configure Claude Code to use the dossier MCP server",
  "category": ["setup"],
  "risk_level": "low",
  "mcp_integration": {
    "required": false,
    "fallback": "manual_execution",
    "benefits": [
      "This dossier sets up MCP integration (does not require it)"
    ]
  }
}
---

# Dossier: Set Up Dossier MCP Server
[... rest of content ...]
```

**Key**: `required: false` prevents chicken-and-egg problem where you'd need MCP to set up MCP.

---

#### Example 4: MCP-Dependent Dossier (Rare)

Very few dossiers should truly require MCP - only when functionality is genuinely impossible without it:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Advanced Registry Operations",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Experimental",
  "objective": "Perform automated operations on dossier registry with validation",
  "category": ["maintenance"],
  "risk_level": "medium",
  "mcp_integration": {
    "required": true,
    "server_name": "@ai-dossier/mcp-server",
    "min_version": "1.1.0",
    "features_used": [
      "get_registry",
      "validate_dossier",
      "dossier://registry"
    ],
    "fallback": "error",
    "benefits": [
      "This dossier requires MCP for automated registry parsing",
      "Registry relationships cannot be parsed manually efficiently"
    ]
  }
}
---

# Dossier: Advanced Registry Operations
[... rest of content ...]
```

**LLM Behavior**:
- Blocks execution if MCP not available
- Shows clear setup instructions
- Does not attempt manual fallback
- Explains why MCP is required

---

#### When to Use Each Pattern

| Pattern | Use When | `required` | `fallback` | Example |
|---------|----------|-----------|-----------|---------|
| **Optional MCP** | Most dossiers | `false` | `manual_execution` | deploy-to-aws, train-ml-model |
| **Bootstrap** | Setting up MCP | `false` | `manual_execution` | setup-dossier-mcp |
| **Required MCP** | Truly impossible without | `true` | `error` | Registry operations (rare) |

**Default Pattern**: Optional MCP with `manual_execution` fallback provides the best user experience - users get enhanced functionality when MCP is available, but dossiers remain fully functional without it.

**Design Philosophy**:
- MCP enhances the experience but shouldn't be a hard requirement
- Users should be guided to set up MCP, not blocked from using dossiers
- The dossier system works great with or without MCP

---

## 4. Protocol Compliance

### 4.1 Protocol Reference

Every dossier **MUST** reference a protocol version:

```markdown
**Protocol Version**: 1.0
```

### 4.2 Protocol Adherence

Dossiers **MUST** be compatible with the referenced [PROTOCOL.md](./protocol.md), including:
- Self-improvement analysis support
- Safety guidelines (backups, confirmations)
- Standard output formatting
- Validation patterns
- Error handling conventions

### 4.3 Protocol Updates

When protocol versions change:
- **Minor updates (1.0 → 1.1)**: Dossiers remain compatible
- **Major updates (1.x → 2.0)**: Dossiers must be updated or explicitly reference older protocol

---

## 5. Content Guidelines

### 5.1 Writing Style

**DO**:
- ✅ Use clear, imperative language
- ✅ Be specific about file paths and commands
- ✅ Provide examples of expected output
- ✅ Include context for decisions
- ✅ Write for LLM interpretation

**DON'T**:
- ❌ Assume unstated context
- ❌ Use vague instructions ("set up", "configure")
- ❌ Hardcode environment-specific values
- ❌ Require specific LLM features
- ❌ Skip validation steps

### 5.2 Adaptability

Dossiers **SHOULD**:
- Guide context gathering before taking action
- Provide decision trees for different scenarios
- Handle common edge cases gracefully
- Adapt instructions based on detected context
- Offer alternatives when assumptions fail

### 5.3 Safety

Dossiers **MUST**:
- Require confirmation for destructive operations
- Validate prerequisites before proceeding
- Include rollback instructions for risky operations
- Provide clear error messages
- Document potential side effects

---

## 6. Formatting Requirements

### 6.1 File Format

- **Format**: Markdown (.md)
- **Encoding**: UTF-8
- **Line endings**: LF (Unix-style) preferred
- **Extension**: `.md`

### 6.2 Markdown Conventions

**Required**:
- H1 (`#`) for dossier title only
- H2 (`##`) for main sections
- H3 (`###`) for subsections
- Code blocks with language tags (` ```bash `, ` ```json `)
- Bullet lists with `-` or numbered lists with `1.`

**Recommended**:
- Emoji for visual clarity (following protocol conventions)
- Tables for comparison matrices
- Blockquotes (`>`) for important notes
- Bold (`**text**`) for emphasis
- Inline code (`` `code` ``) for commands/files

### 6.3 Naming Conventions

**Dossier files**:
- Lowercase with hyphens: `project-init.md`, `deploy-to-aws.md`
- Descriptive and action-oriented
- Avoid special characters except hyphens
- Include `.md` extension

---

## 7. Versioning and Compatibility

### 7.1 Dossier Versioning

Dossiers **MUST** use semantic versioning (semver):

**Format**: `MAJOR.MINOR.PATCH`

**Increment rules**:
- **MAJOR**: Breaking changes to dossier behavior
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, clarifications

### 7.2 Protocol Compatibility

Dossiers **SHOULD** specify minimum protocol version:

```markdown
**Protocol Version**: 1.0
```

**Meaning**: Compatible with protocol v1.0.0 through v1.x.x

### 7.3 Deprecation

When deprecating a dossier:
1. Update status to "Deprecated"
2. Provide migration path in header
3. Keep file accessible for reference
4. Remove from primary navigation/registry

---

## 8. Implementation Requirements

### 8.1 For LLM Agents

When executing dossiers, agents **MUST**:
1. Read and parse dossier structure
2. Validate prerequisites before proceeding
3. Gather specified context
4. Follow actions sequentially
5. Verify success criteria
6. Report outcomes clearly

Agents **SHOULD**:
- Perform self-improvement analysis per protocol
- Adapt instructions to detected context
- Ask for clarification when ambiguous
- Provide progress updates
- Handle errors gracefully

### 8.2 For Implementations

Projects adopting dossiers **SHOULD**:
1. Organize dossiers in consistent directory structure
2. Provide registry or navigation guide
3. Include templates for custom dossiers
4. Document implementation-specific conventions
5. Maintain compatibility with protocol version

### 8.3 For Dossier Authors

When creating dossiers, authors **MUST**:
1. Follow this specification
2. Reference a protocol version
3. Include all required sections
4. Test with multiple LLM agents
5. Validate against real projects

Authors **SHOULD**:
- Include troubleshooting guidance
- Provide examples
- Document decision rationale
- Consider edge cases
- Enable self-improvement

---

## 9. Validation and Testing

### 9.1 Structural Validation

A compliant dossier **MUST** pass these checks:
- [ ] Valid markdown syntax
- [ ] All required sections present
- [ ] Protocol version specified
- [ ] Semver version number
- [ ] Clear objective statement
- [ ] Specific prerequisites
- [ ] Actionable steps
- [ ] Validation criteria defined

### 9.2 Content Validation

A quality dossier **SHOULD** include:
- [ ] Context gathering guidance
- [ ] Decision points documented
- [ ] Examples provided
- [ ] Troubleshooting section
- [ ] Rollback instructions (for destructive ops)
- [ ] Clear, specific language
- [ ] No hardcoded environment assumptions

### 9.3 Execution Testing

Dossiers **SHOULD** be tested by:
1. Multiple LLM agents (Claude, GPT-4, etc.)
2. Different project contexts
3. Various starting conditions
4. Edge cases and error scenarios
5. Users with different experience levels

---

## 10. Examples

### 10.1 Minimal Compliant Dossier

```markdown
# Dossier: Hello World

**Version**: 1.0.0
**Protocol Version**: 1.0
**Status**: Stable

## Objective

Create a "Hello World" text file in the current directory.

## Prerequisites

- Current directory is writable
- Command: `test -w .`

## Actions to Perform

1. Create file named `hello.txt`
2. Write "Hello World" to the file
3. Set file permissions to readable by all

## Validation

**Success Criteria**:
1. File `hello.txt` exists
2. File contains "Hello World"
3. File is readable

**Verification Commands**:
```bash
test -f hello.txt && cat hello.txt | grep "Hello World"
```
```

### 10.2 Comprehensive Dossier Example

See [examples/devops/deploy-to-aws.ds.md](../../examples/devops/deploy-to-aws.ds.md) for a complete, production-ready dossier.

---

## 11. Compliance Levels

### Level 1: Basic Compliance

**Requirements**:
- All required sections present
- Protocol version referenced
- Clear objective and actions
- Validation criteria defined

**Suitable for**: Simple, straightforward workflows

### Level 2: Standard Compliance

**Requirements**:
- Level 1 +
- Context gathering defined
- Decision points documented
- Examples provided
- Troubleshooting included

**Suitable for**: Most production workflows

### Level 3: Advanced Compliance

**Requirements**:
- Level 2 +
- Self-improvement optimization
- Comprehensive edge case handling
- Multi-implementation testing
- Detailed rollback procedures

**Suitable for**: Critical, complex workflows

---

## 12. Extension and Customization

### 12.1 Implementation-Specific Extensions

Implementations **MAY** add custom sections prefixed with `X-`:

```markdown
## X-MyProject-Custom-Section

[Implementation-specific content]
```

**Rules**:
- Prefix with `X-` followed by implementation name
- Document in implementation guide
- Do not break standard section requirements
- LLMs should ignore unknown `X-` sections gracefully

### 12.2 Local Protocol Extensions

Projects **MAY** extend protocol locally (see [PROTOCOL.md](./protocol.md) § Custom Protocol Extensions).

---

## 13. Changelog

### v1.0.0 (2025-11-05)

**Initial Release**:
- Core dossier structure specification
- Required and optional sections defined
- Protocol compliance requirements
- Formatting and style guidelines
- Versioning standards
- Implementation requirements
- Validation criteria
- **Schema frontmatter support** (§3.4):
  - JSON-based metadata frontmatter
  - Machine-readable dossier metadata
  - Deterministic parsing and validation
  - Tooling foundation for registries and CLI
  - Complete schema specification in SCHEMA.md
  - JSON Schema definition (dossier-schema.json)

---

## 14. References

- [PROTOCOL.md](./protocol.md) - Dossier Execution Protocol
- [SCHEMA.md](./schema.md) - Dossier Schema Specification (JSON frontmatter)
- [README.md](../../README.md) - Introduction to dossiers
- [examples/](../../examples/) - Example implementations
- [dossier-schema.json](../../dossier-schema.json) - JSON Schema definition

---

## 15. Appendix: Decision Rationale

### Why Markdown?

- ✅ Human-readable and LLM-parseable
- ✅ Widely supported tooling
- ✅ Version control friendly
- ✅ No special parsers required
- ✅ Rich formatting options

### Why Not JSON/YAML/XML?

- ❌ Less human-readable
- ❌ Harder to write documentation
- ❌ Requires strict parsing
- ❌ Not ideal for long-form instructions

### Why Protocol Reference?

- ✅ Enables protocol evolution
- ✅ Maintains compatibility
- ✅ Allows for breaking changes
- ✅ Clear expectations for agents

---

**🎯 Dossier Specification v1.0.0**

*Defining the universal standard for LLM-executable automation*
