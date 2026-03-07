# Dossier Schema Specification

**Version:** 1.0.0
**Status:** Stable
**Last Updated:** 2025-11-05

## Table of Contents

1. [Overview](#overview)
2. [Motivation](#motivation)
3. [Schema Format](#schema-format)
4. [Field Reference](#field-reference)
5. [Examples](#examples)
6. [Validation](#validation)
7. [Migration Guide](#migration-guide)
8. [Best Practices](#best-practices)

---

## Overview

The Dossier Schema is a **JSON-based frontmatter format** that provides deterministic, machine-readable metadata for Dossier automation files. It transforms Dossiers from purely interpretive Markdown documents into **structured, validatable, and discoverable automation specifications**.

### Key Benefits

1. **Deterministic Parsing**: LLMs and tools can extract metadata reliably without natural language interpretation
2. **Fast Validation**: Schema validation fails fast before expensive LLM execution
3. **Tooling Foundation**: Enables CLI tools, IDEs, registries, and automation systems
4. **Searchability**: Programmatic discovery by category, tags, tools, dependencies
5. **Predictable Costs**: Know required tools and dependencies before execution
6. **Professional Credibility**: Demonstrates maturity for enterprise adoption

---

## Motivation

### The Problem: Inconsistency and Ambiguity

Without a schema, LLM agents interpret Dossiers based on training and context. This creates brittleness:

- **Model Updates Break Execution**: New LLM versions may interpret instructions differently
- **Ambiguous Dependencies**: Relationships between Dossiers are implicit in prose
- **Unpredictable Tooling**: Can't know required tools until execution begins
- **Poor Discoverability**: Can't search or categorize Dossiers programmatically

### The Solution: Structured Metadata

The Dossier Schema provides:

```
Pure Markdown (Status Quo)          →    With Schema (Goal State)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ambiguous (LLM infers metadata)     →    Deterministic (explicit metadata)
Brittle (model changes break it)    →    Robust (validated before execution)
Isolated (hard to search/organize)  →    Integrated (tooling-ready)
```

---

## Schema Format

### Frontmatter Structure

Dossier Schema metadata is embedded at the **top of the Markdown file** using JSON in a YAML-style code fence:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Deploy Application to AWS",
  "version": "1.2.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Deploy a containerized application to AWS ECS with automated rollback capability",
  "category": ["devops", "deployment"],
  "tags": ["aws", "ecs", "docker", "terraform"],
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
        "description": "Target environment (dev, staging, production)",
        "type": "string",
        "validation": "^(dev|staging|production)$"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "terraform.tfstate",
        "description": "Terraform state file",
        "required": true
      }
    ]
  }
}
---

# Deploy Application to AWS

[Rest of Markdown content follows...]
```

### Key Rules

1. **Delimiter**: Use `---dossier` to open and `---` to close the frontmatter block
2. **Format**: JSON only (not YAML or TOML)
3. **Position**: Must be the very first content in the file (before any Markdown)
4. **Validation**: Must conform to `dossier-schema.json`
5. **Required Fields**: `dossier_schema_version`, `title`, `version`, `protocol_version`, `status`, `objective`

---

## Field Reference

### Core Metadata

#### `dossier_schema_version` (required)
- **Type**: String (semver)
- **Description**: Version of the Dossier Schema specification
- **Example**: `"1.0.0"`
- **Validation**: Must be `"1.0.0"` for this specification version

#### `title` (required)
- **Type**: String (3-200 characters)
- **Description**: Human-readable title of the Dossier
- **Example**: `"Deploy Application to AWS ECS"`

#### `version` (required)
- **Type**: String (semver)
- **Description**: Version of this specific Dossier
- **Example**: `"1.2.0"`, `"2.0.0-beta.1"`

#### `protocol_version` (required)
- **Type**: String (major.minor)
- **Description**: Dossier Protocol version this adheres to
- **Example**: `"1.0"`

#### `status` (required)
- **Type**: Enum
- **Values**: `"Draft"`, `"Stable"`, `"Deprecated"`, `"Experimental"`
- **Description**: Lifecycle status

#### `last_updated`
- **Type**: String (ISO 8601 date)
- **Description**: Last update date
- **Example**: `"2025-11-05"`

#### `objective` (required)
- **Type**: String (10-500 characters)
- **Description**: Clear, single-purpose statement (1-3 sentences)
- **Example**: `"Deploy a containerized application to AWS ECS with blue-green deployment strategy and automated rollback capability"`

---

### Organization & Discovery

#### `category`
- **Type**: Array of strings
- **Description**: Primary categories for organization
- **Values**: `devops`, `database`, `development`, `data-science`, `security`, `testing`, `deployment`, `maintenance`, `setup`, `migration`, `monitoring`, `infrastructure`, `ci-cd`, `documentation`
- **Example**: `["devops", "deployment"]`

#### `tags`
- **Type**: Array of strings
- **Description**: Free-form tags for searchability
- **Example**: `["aws", "ecs", "docker", "terraform", "blue-green"]`

#### `tools_required`
- **Type**: Array of objects
- **Description**: Tools/commands that must be available
- **Fields**:
  - `name` (required): Tool name (e.g., `"docker"`)
  - `version`: Minimum version (e.g., `">=20.0.0"`)
  - `check_command`: Command to verify availability (e.g., `"docker --version"`)
  - `install_url`: URL to installation instructions

**Example**:
```json
"tools_required": [
  {
    "name": "terraform",
    "version": ">=1.0.0",
    "check_command": "terraform --version",
    "install_url": "https://www.terraform.io/downloads"
  },
  {
    "name": "aws-cli",
    "version": ">=2.0.0",
    "check_command": "aws --version"
  }
]
```

---

### External References

#### `content_scope`
- **Type**: Enum
- **Values**: `"self-contained"`, `"references-external"`
- **Description**: Whether the dossier body is self-contained or references external URLs. Set to `"references-external"` when the body contains any external URLs (the linter enforces this).

#### `external_references`
- **Type**: Array of objects
- **Description**: Manifest of all external resources referenced in the dossier body. Required when `content_scope` is `"references-external"`.
- **Fields**:
  - `url` (required): URL or URL prefix of the external resource
  - `description` (required): What this external resource is used for
  - `type` (required): Type of resource — `"download"`, `"api"`, `"documentation"`, `"script"`, `"config"`, `"image"`, `"dossier"`, or `"other"`
  - `trust_level` (required): Trust level — `"trusted"`, `"user-verified"`, or `"unknown"`
  - `required` (required): Whether this external resource is required for execution

**Example**:
```json
"content_scope": "references-external",
"external_references": [
  {
    "url": "https://registry.npmjs.org",
    "description": "NPM registry for package installation",
    "type": "download",
    "trust_level": "trusted",
    "required": true
  },
  {
    "url": "https://raw.githubusercontent.com/org/repo/main/setup.sh",
    "description": "Bootstrap script fetched during setup",
    "type": "script",
    "trust_level": "user-verified",
    "required": false
  }
]
```

**Linter rule**: `external-references-declared` (default severity: `error`) scans the body for URLs and cross-references them against declared `external_references`. Placeholder URLs (`example.com`, `localhost`, `${VAR}`) are automatically excluded. URLs from `tools_required[].install_url`, `homepage`, `repository`, and `authors[].url` are auto-exempt.

**Recommended agent behavior** (see [PROTOCOL.md](../../PROTOCOL.md) for full details):
- URLs declared in `external_references` → Proceed (author has acknowledged the dependency)
- URLs with `type: "script"` and `trust_level: "unknown"` → Require explicit user approval
- URLs NOT declared in `external_references` → Warn user (URL is not in the trust chain)
- `content_scope` is `"self-contained"` but body has URLs → Treat as configuration error

---

### Risk & Duration

#### `risk_level`
- **Type**: Enum
- **Values**: `"low"`, `"medium"`, `"high"`, `"critical"`
- **Description**: Risk level of execution
- **Example**: `"high"` for production deployments, `"low"` for documentation generation

#### `estimated_duration`
- **Type**: Object
- **Fields**:
  - `min_minutes`: Minimum duration in minutes
  - `max_minutes`: Maximum duration in minutes
- **Example**:
```json
"estimated_duration": {
  "min_minutes": 15,
  "max_minutes": 45
}
```

---

### Relationships

#### `relationships`
- **Type**: Object
- **Description**: Relationships with other Dossiers

##### `relationships.preceded_by`
- **Type**: Array of objects
- **Description**: Dossiers that should run before this one
- **Fields**:
  - `dossier` (required): Name or path of preceding Dossier
  - `condition`: `"required"`, `"optional"`, or `"suggested"`
  - `reason`: Why this prerequisite exists

**Example**:
```json
"preceded_by": [
  {
    "dossier": "setup-aws-infrastructure",
    "condition": "required",
    "reason": "VPC and ECS cluster must exist before deployment"
  },
  {
    "dossier": "configure-secrets-manager",
    "condition": "suggested",
    "reason": "Secrets management improves security posture"
  }
]
```

##### `relationships.followed_by`
- **Type**: Array of objects
- **Description**: Dossiers that should run after this one
- **Fields**:
  - `dossier` (required): Name or path of following Dossier
  - `condition`: `"required"` or `"suggested"`
  - `purpose`: Purpose of the follow-up

**Example**:
```json
"followed_by": [
  {
    "dossier": "configure-monitoring",
    "condition": "suggested",
    "purpose": "Set up CloudWatch alarms for the deployed service"
  }
]
```

##### `relationships.alternatives`
- **Type**: Array of objects
- **Description**: Alternative Dossiers for similar goals
- **Fields**:
  - `dossier` (required): Name or path
  - `when_to_use`: When to use the alternative

**Example**:
```json
"alternatives": [
  {
    "dossier": "deploy-to-kubernetes",
    "when_to_use": "When targeting Kubernetes instead of ECS"
  }
]
```

##### `relationships.conflicts_with`
- **Type**: Array of objects
- **Description**: Dossiers that conflict with this one
- **Fields**:
  - `dossier` (required): Conflicting Dossier
  - `reason` (required): Why they conflict

**Example**:
```json
"conflicts_with": [
  {
    "dossier": "deploy-with-serverless-framework",
    "reason": "Cannot use both ECS and Lambda for the same service"
  }
]
```

##### `relationships.can_run_parallel_with`
- **Type**: Array of strings
- **Description**: Dossiers that can be executed simultaneously

**Example**:
```json
"can_run_parallel_with": [
  "setup-monitoring-stack",
  "configure-backup-policies"
]
```

---

### Inputs

#### `inputs`
- **Type**: Object
- **Description**: Input parameters required or accepted

##### `inputs.required`
- **Type**: Array of objects
- **Description**: Required inputs
- **Fields**:
  - `name` (required): Parameter name
  - `description` (required): Description
  - `type`: Data type (e.g., `"string"`, `"number"`, `"file"`, `"array"`)
  - `validation`: Validation rules or regex pattern
  - `example`: Example value

**Example**:
```json
"required": [
  {
    "name": "environment",
    "description": "Target deployment environment",
    "type": "string",
    "validation": "^(dev|staging|production)$",
    "example": "production"
  },
  {
    "name": "docker_image",
    "description": "Docker image URI",
    "type": "string",
    "validation": "^[a-z0-9.-]+/[a-z0-9-]+:[a-z0-9.-]+$",
    "example": "123456789.dkr.ecr.us-west-2.amazonaws.com/myapp:v1.2.0"
  }
]
```

##### `inputs.optional`
- **Type**: Array of objects
- **Description**: Optional inputs with defaults
- **Fields**: Same as `required`, plus:
  - `default`: Default value if not provided

**Example**:
```json
"optional": [
  {
    "name": "desired_count",
    "description": "Number of tasks to run",
    "type": "number",
    "default": 2,
    "example": "3"
  }
]
```

##### `inputs.from_dossiers`
- **Type**: Array of objects
- **Description**: Inputs sourced from other Dossiers' outputs
- **Fields**:
  - `source_dossier` (required): Source Dossier name
  - `output_name` (required): Name of the output
  - `usage`: How this input is used

**Example**:
```json
"from_dossiers": [
  {
    "source_dossier": "setup-aws-infrastructure",
    "output_name": "ecs_cluster_name",
    "usage": "ECS cluster ARN for deployment target"
  }
]
```

---

### Outputs

#### `outputs`
- **Type**: Object
- **Description**: Outputs produced by this Dossier

##### `outputs.files`
- **Type**: Array of objects
- **Description**: Files created or modified
- **Fields**:
  - `path` (required): File path (may include variables)
  - `description` (required): Description
  - `required`: Whether always created (default: `true`)
  - `format`: File format (e.g., `"json"`, `"yaml"`)

**Example**:
```json
"files": [
  {
    "path": "terraform.tfstate",
    "description": "Terraform state file tracking deployed resources",
    "required": true,
    "format": "json"
  },
  {
    "path": "deployment-${ENVIRONMENT}.log",
    "description": "Deployment execution log",
    "required": false,
    "format": "text"
  }
]
```

##### `outputs.configuration`
- **Type**: Array of objects
- **Description**: Configuration values produced
- **Fields**:
  - `key` (required): Configuration key
  - `description` (required): Description
  - `consumed_by`: Array of Dossiers that consume this
  - `export_as`: How to export (e.g., `"env_var"`, `"terraform_output"`)

**Example**:
```json
"configuration": [
  {
    "key": "service_endpoint",
    "description": "HTTPS endpoint of the deployed service",
    "consumed_by": ["configure-monitoring", "run-integration-tests"],
    "export_as": "env_var"
  }
]
```

##### `outputs.state_changes`
- **Type**: Array of objects
- **Description**: State changes made
- **Fields**:
  - `description` (required): Description of change
  - `affects`: What is affected
  - `reversible`: Whether it can be rolled back

**Example**:
```json
"state_changes": [
  {
    "description": "ECS service updated to new task definition",
    "affects": "Production ECS cluster",
    "reversible": true
  }
]
```

##### `outputs.artifacts`
- **Type**: Array of objects
- **Description**: Generated artifacts (scripts, reports, logs)
- **Fields**:
  - `path` (required): Artifact path
  - `purpose` (required): Purpose
  - `type`: Type (e.g., `"script"`, `"log"`, `"report"`)

**Example**:
```json
"artifacts": [
  {
    "path": "rollback-${TIMESTAMP}.sh",
    "purpose": "Automated rollback script for this deployment",
    "type": "script"
  }
]
```

---

### Coupling

#### `coupling`
- **Type**: Object (required fields: `level`)
- **Description**: Coupling level with other systems

##### `coupling.level`
- **Type**: Enum
- **Values**: `"None"`, `"Loose"`, `"Medium"`, `"Tight"`
- **Description**: Degree of coupling

##### `coupling.details`
- **Type**: String
- **Description**: Explanation of coupling

**Example**:
```json
"coupling": {
  "level": "Medium",
  "details": "Requires AWS infrastructure (VPC, ECS cluster) but can adapt to different configurations"
}
```

---

### Prerequisites

#### `prerequisites`
- **Type**: Array of objects
- **Description**: Prerequisites that must exist
- **Fields**:
  - `description` (required): Description
  - `validation_command`: Command to validate
  - `type`: Type (`"file"`, `"directory"`, `"tool"`, `"service"`, `"permission"`, `"environment"`)

**Example**:
```json
"prerequisites": [
  {
    "description": "AWS credentials configured",
    "validation_command": "aws sts get-caller-identity",
    "type": "permission"
  },
  {
    "description": "Docker daemon running",
    "validation_command": "docker info",
    "type": "service"
  }
]
```

---

### Validation

#### `validation`
- **Type**: Object
- **Description**: Success criteria and verification

##### `validation.success_criteria`
- **Type**: Array of strings
- **Description**: Verifiable criteria for success

**Example**:
```json
"success_criteria": [
  "ECS service is in ACTIVE state",
  "All tasks pass health checks",
  "Service endpoint returns 200 OK"
]
```

##### `validation.verification_commands`
- **Type**: Array of objects
- **Description**: Commands to verify success
- **Fields**:
  - `command` (required): Command to run
  - `expected` (required): Expected result
  - `description`: What this verifies

**Example**:
```json
"verification_commands": [
  {
    "command": "aws ecs describe-services --cluster ${CLUSTER} --services ${SERVICE}",
    "expected": "status: ACTIVE, runningCount: desiredCount",
    "description": "Verify service is running with correct task count"
  },
  {
    "command": "curl -I https://${SERVICE_ENDPOINT}/health",
    "expected": "HTTP/1.1 200 OK",
    "description": "Verify service responds to health check"
  }
]
```

---

### Rollback

#### `rollback`
- **Type**: Object
- **Description**: Rollback capability information
- **Fields**:
  - `supported`: Whether rollback is supported
  - `procedure`: Description of rollback procedure
  - `automated`: Whether rollback can be automated
  - `backup_required`: Whether backup is needed before execution

**Example**:
```json
"rollback": {
  "supported": true,
  "procedure": "Execute generated rollback script to revert to previous task definition",
  "automated": true,
  "backup_required": false
}
```

---

### MCP Integration

#### `mcp_integration` (Optional)

**Type**: Object

**Description**: MCP (Model Context Protocol) server integration metadata. Enables dossiers to declare MCP server requirements and fallback behavior when MCP is not available.

**Purpose**:
- Machine-readable MCP requirements for LLMs
- Enables automatic detection and guided setup
- Supports graceful degradation
- Maintains backwards compatibility

**Properties**:

##### `required` (boolean, default: false)
Whether the dossier MCP server is required for execution.
- `true`: Block execution if MCP not available (rare)
- `false`: Allow fallback to manual execution (recommended)

##### `server_name` (string, default: "@ai-dossier/mcp-server")
npm package name of the required MCP server.

##### `min_version` (string, semver format)
Minimum MCP server version required (e.g., "1.0.0"). Optional but recommended for version-dependent features.

##### `features_used` (array of strings)
List of MCP tools and resources this dossier uses. Values: "verify_dossier", "read_dossier", "list_dossiers", "validate_dossier", "dossier://protocol", "dossier://security", "dossier://concept"

Helps LLMs understand which MCP capabilities are needed.

##### `fallback` (string, enum, default: "manual_execution")
Behavior when MCP server is not available:
- "manual_execution": Continue with manual verification (recommended)
- "degraded": Reduced functionality, continue execution
- "error": Block execution, require MCP setup (rare)

##### `benefits` (array of strings)
Human-readable list of benefits when using MCP for this dossier. Shown to users when offering setup.

**Examples**:

High-risk dossier, MCP optional but recommended:
```json
{
  "mcp_integration": {
    "required": false,
    "server_name": "@ai-dossier/mcp-server",
    "min_version": "1.0.0",
    "features_used": ["verify_dossier"],
    "fallback": "manual_execution",
    "benefits": [
      "Automatic security verification",
      "Signature validation",
      "Clear risk assessment"
    ]
  }
}
```

Bootstrap/setup dossier (no MCP needed):
```json
{
  "mcp_integration": {
    "required": false,
    "fallback": "manual_execution",
    "benefits": [
      "This dossier sets up MCP integration (does not require it)"
    ]
  }
}
```

Dossier requiring MCP (very rare):
```json
{
  "mcp_integration": {
    "required": true,
    "server_name": "@ai-dossier/mcp-server",
    "min_version": "1.0.0",
    "features_used": ["validate_dossier", "dossier://registry"],
    "fallback": "error",
    "benefits": [
      "This dossier requires MCP for automated registry parsing"
    ]
  }
}
```

**Best Practices**:

For Dossier Authors:
1. Default to `required: false` - Most dossiers can work without MCP
2. Use `manual_execution` fallback - Best user experience
3. Document benefits clearly - Help users understand value
4. Test without MCP - Ensure fallback actually works
5. Only use `error` fallback when truly impossible without MCP

For LLM Agents:
1. Check MCP availability before execution (see PROTOCOL.md)
2. Respect fallback preferences
3. Offer setup guidance when MCP missing
4. Use MCP tools when available

**See Also**:
- PROTOCOL.md § MCP Server Integration
- SPECIFICATION.md § MCP Integration Examples
- examples/setup/setup-dossier-mcp.ds.md

---

### Additional Metadata

#### `authors`
- **Type**: Array of objects
- **Fields**: `name`, `email`, `url`

#### `license`
- **Type**: String (SPDX identifier)
- **Example**: `"MIT"`, `"Apache-2.0"`

#### `homepage`
- **Type**: String (URL)
- **Example**: `"https://docs.example.com/dossiers/deploy-aws"`

#### `repository`
- **Type**: String (URL)
- **Example**: `"https://github.com/org/dossiers"`

#### `custom`
- **Type**: Object
- **Description**: Custom fields for extensions
- **Note**: In Markdown, prefix custom sections with `X-`

---

## Examples

### Example 1: Simple Development Setup

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Setup Node.js Project",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2025-11-05",
  "objective": "Initialize a new Node.js project with TypeScript, ESLint, and Jest testing",
  "category": ["development", "setup"],
  "tags": ["nodejs", "typescript", "jest", "eslint"],
  "tools_required": [
    {
      "name": "node",
      "version": ">=18.0.0",
      "check_command": "node --version"
    },
    {
      "name": "npm",
      "version": ">=9.0.0",
      "check_command": "npm --version"
    }
  ],
  "risk_level": "low",
  "estimated_duration": {
    "min_minutes": 5,
    "max_minutes": 10
  },
  "inputs": {
    "required": [
      {
        "name": "project_name",
        "description": "Name of the project",
        "type": "string",
        "validation": "^[a-z][a-z0-9-]+$",
        "example": "my-awesome-app"
      }
    ],
    "optional": [
      {
        "name": "author",
        "description": "Project author name",
        "type": "string",
        "default": "Current git user"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "package.json",
        "description": "NPM package manifest",
        "required": true,
        "format": "json"
      },
      {
        "path": "tsconfig.json",
        "description": "TypeScript configuration",
        "required": true,
        "format": "json"
      }
    ]
  },
  "coupling": {
    "level": "None",
    "details": "Self-contained project initialization"
  }
}
---

# Setup Node.js Project

[Rest of Dossier content...]
```

### Example 2: High-Risk Database Migration

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Database Schema Migration",
  "version": "2.1.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2025-11-05",
  "objective": "Execute a database schema migration with automatic backup, dry-run validation, and rollback procedure",
  "category": ["database", "migration"],
  "tags": ["postgresql", "mysql", "mongodb", "schema", "migration"],
  "tools_required": [
    {
      "name": "pg_dump",
      "check_command": "pg_dump --version"
    },
    {
      "name": "psql",
      "check_command": "psql --version"
    }
  ],
  "risk_level": "critical",
  "estimated_duration": {
    "min_minutes": 30,
    "max_minutes": 120
  },
  "relationships": {
    "preceded_by": [
      {
        "dossier": "database-backup",
        "condition": "required",
        "reason": "Backup must be verified before schema changes"
      }
    ],
    "followed_by": [
      {
        "dossier": "verify-data-integrity",
        "condition": "required",
        "purpose": "Ensure migration did not corrupt data"
      }
    ],
    "conflicts_with": [
      {
        "dossier": "database-restore",
        "reason": "Cannot migrate and restore simultaneously"
      }
    ]
  },
  "inputs": {
    "required": [
      {
        "name": "migration_script",
        "description": "SQL migration script file",
        "type": "file",
        "validation": "\\.sql$",
        "example": "migrations/001_add_user_profiles.sql"
      },
      {
        "name": "database_url",
        "description": "Database connection string",
        "type": "string",
        "example": "postgresql://user:pass@localhost:5432/mydb"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "backup-${TIMESTAMP}.sql",
        "description": "Pre-migration backup",
        "required": true,
        "format": "sql"
      },
      {
        "path": "migration-${TIMESTAMP}.log",
        "description": "Migration execution log",
        "required": true,
        "format": "text"
      }
    ],
    "artifacts": [
      {
        "path": "rollback-${TIMESTAMP}.sql",
        "purpose": "Rollback script for this migration",
        "type": "script"
      }
    ],
    "state_changes": [
      {
        "description": "Database schema updated to new version",
        "affects": "All database tables and indexes",
        "reversible": true
      }
    ]
  },
  "coupling": {
    "level": "Tight",
    "details": "Tightly coupled to database schema; migration must match current schema version"
  },
  "prerequisites": [
    {
      "description": "Database is accessible",
      "validation_command": "psql ${DATABASE_URL} -c 'SELECT 1'",
      "type": "service"
    },
    {
      "description": "Migration script exists",
      "validation_command": "test -f ${MIGRATION_SCRIPT}",
      "type": "file"
    }
  ],
  "validation": {
    "success_criteria": [
      "Migration script executed without errors",
      "All tables exist with correct schema",
      "Sample queries return expected results"
    ],
    "verification_commands": [
      {
        "command": "psql ${DATABASE_URL} -c '\\dt'",
        "expected": "All expected tables listed",
        "description": "Verify all tables exist"
      }
    ]
  },
  "rollback": {
    "supported": true,
    "procedure": "Execute generated rollback SQL script to revert schema changes",
    "automated": true,
    "backup_required": true
  }
}
---

# Database Schema Migration

[Rest of Dossier content...]
```

---

## Validation

### Programmatic Validation

Use JSON Schema validators to ensure compliance:

**Node.js with Ajv**:
```javascript
const Ajv = require('ajv');
const schema = require('./dossier-schema.json');
const dossierFrontmatter = require('./my-dossier-frontmatter.json');

const ajv = new Ajv();
const validate = ajv.compile(schema);
const valid = validate(dossierFrontmatter);

if (!valid) {
  console.error('Validation errors:', validate.errors);
}
```

**Python with jsonschema**:
```python
import json
from jsonschema import validate, ValidationError

with open('dossier-schema.json') as f:
    schema = json.load(f)

with open('my-dossier-frontmatter.json') as f:
    dossier = json.load(f)

try:
    validate(instance=dossier, schema=schema)
    print("Valid!")
except ValidationError as e:
    print(f"Validation error: {e.message}")
```

### Pre-Execution Validation Workflow

```
1. Parse Dossier file
   ↓
2. Extract JSON frontmatter
   ↓
3. Validate against dossier-schema.json
   ↓
4. Check tools_required availability
   ↓
5. Verify prerequisites
   ↓
6. [PASS] → Execute Dossier
   [FAIL] → Report errors, exit
```

### Validation Levels

1. **Syntax Validation**: JSON is well-formed
2. **Schema Validation**: Conforms to `dossier-schema.json`
3. **Semantic Validation**: Relationships reference existing Dossiers
4. **Environment Validation**: Required tools are available
5. **Prerequisite Validation**: Prerequisites are met

---

## Migration Guide

### Migrating Existing Dossiers

#### Step 1: Extract Metadata from Markdown

Identify existing metadata sections in your Dossier:

```markdown
## Metadata

### Version
- **Dossier**: v1.2.0
- **Protocol**: v1.0

### Relationships
- **Preceded by**: setup-infrastructure (required)
```

#### Step 2: Convert to JSON

Create a JSON object with the same information:

```json
{
  "dossier_schema_version": "1.0.0",
  "title": "[Extract from H1]",
  "version": "1.2.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "[Extract from Objective section]",
  "relationships": {
    "preceded_by": [
      {
        "dossier": "setup-infrastructure",
        "condition": "required"
      }
    ]
  }
}
```

#### Step 3: Add Frontmatter

Place the JSON at the top of the file:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  ...
}
---

# [Original Dossier Title]

[Original content...]
```

#### Step 4: Validate

Run schema validation to ensure compliance.

#### Step 5: Optionally Remove Redundant Markdown

You may choose to remove the Markdown metadata sections (like `## Metadata`) since they're now in the frontmatter, or keep them for human readability.

### Backward Compatibility

- **Legacy Dossiers**: Dossiers without schema frontmatter are still valid and can be executed by LLMs
- **Gradual Adoption**: Add schema to new Dossiers first; migrate old ones over time
- **Dual Format**: You can keep both JSON frontmatter and Markdown metadata sections during transition

---

## Best Practices

### 1. Always Include Core Fields

Ensure these required fields are always present:
- `dossier_schema_version`
- `title`
- `version`
- `protocol_version`
- `status`
- `objective`

### 2. Be Specific with Relationships

Instead of:
```json
"preceded_by": [{"dossier": "setup"}]
```

Use:
```json
"preceded_by": [
  {
    "dossier": "setup-aws-infrastructure",
    "condition": "required",
    "reason": "VPC and ECS cluster must exist before deployment"
  }
]
```

### 3. Document All Tools

List every command-line tool your Dossier uses:

```json
"tools_required": [
  {"name": "terraform", "version": ">=1.0.0", "check_command": "terraform --version"},
  {"name": "aws-cli", "version": ">=2.0.0", "check_command": "aws --version"},
  {"name": "docker", "version": ">=20.0.0", "check_command": "docker --version"}
]
```

### 4. Define Clear Validation

Make success criteria measurable:

```json
"validation": {
  "success_criteria": [
    "Service responds to health checks",
    "All tasks are running",
    "Endpoint returns 200 OK"
  ],
  "verification_commands": [
    {
      "command": "curl -f https://${ENDPOINT}/health",
      "expected": "HTTP 200 OK",
      "description": "Health check passes"
    }
  ]
}
```

### 5. Set Appropriate Risk Levels

- **Low**: Documentation, setup, read-only operations
- **Medium**: Development tooling, non-production deployments
- **High**: Production deployments, configuration changes
- **Critical**: Database migrations, destructive operations

### 6. Version Semantically

Follow semver for `version`:
- **Major**: Breaking changes (e.g., incompatible input changes)
- **Minor**: New features (e.g., new decision points)
- **Patch**: Bug fixes (e.g., typo corrections)

### 7. Use Tags Liberally

Tags improve discoverability:

```json
"tags": [
  "aws",
  "ecs",
  "docker",
  "terraform",
  "blue-green",
  "rolling-deployment",
  "automated-rollback"
]
```

### 8. Document Coupling Honestly

Don't understate coupling:

```json
"coupling": {
  "level": "Tight",
  "details": "Requires specific Terraform modules and AWS account structure; not portable without modification"
}
```

---

## Future Enhancements

Planned for future schema versions:

1. **Conditional Execution**: `"conditions": {"os": "linux", "arch": "x64"}`
2. **Cost Estimates**: `"estimated_cost": {"min": 10, "max": 50, "currency": "USD"}`
3. **Dependency Graphs**: Machine-readable DAG of relationships
4. **Output Contracts**: Formal contracts for Dossier outputs
5. **Testing Metadata**: Test coverage, test commands
6. **Observability**: Monitoring and alerting configuration

---

## References

- **JSON Schema Specification**: [json-schema.org](https://json-schema.org/)
- **Semantic Versioning**: [semver.org](https://semver.org/)
- **Dossier Protocol**: See `PROTOCOL.md`
- **Dossier Specification**: See `SPECIFICATION.md`

---

## Questions or Feedback?

Open an issue at: https://github.com/imboard-ai/ai-dossier/issues

---

**Document Version**: 1.0.0
**License**: Same as Dossier project (see LICENSE file)
