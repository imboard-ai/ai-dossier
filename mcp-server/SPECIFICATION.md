# Dossier MCP Server Specification

**Version**: 1.0.0-draft
**MCP Protocol**: 1.0
**Status**: Design Phase

---

## Overview

The **Dossier MCP Server** provides Model Context Protocol integration for the dossier automation standard. It enables LLMs to discover, understand, and execute dossiers seamlessly without requiring users to manually provide context or file contents.

### Problem Solved

Without MCP, using dossiers requires:
1. User manually explaining what dossiers are
2. User providing dossier file contents (copy-paste or file paths)
3. User explaining the execution protocol
4. User specifying available dossiers

**With the Dossier MCP Server**, users simply say:
```
"Use the project-init dossier"
```

The LLM automatically:
- Understands what dossiers are (via resources)
- Discovers available dossiers (via tools)
- Reads dossier content (via tools)
- Knows how to execute them (via prompts and protocol resource)

---

## Architecture

The MCP server provides three integration points:

1. **Tools** - Programmatic access to dossiers
2. **Resources** - Documentation and concept understanding
3. **Prompts** - Execution templates

---

## Tools

### `list_dossiers`

Discover available dossiers in a directory.

**Parameters:**
```typescript
{
  path?: string;        // Directory to search (default: cwd)
  recursive?: boolean;  // Search subdirectories (default: true)
  filter?: string;      // Glob pattern filter (default: "**/*.md")
}
```

**Returns:**
```typescript
{
  dossiers: Array<{
    name: string;           // e.g., "project-init"
    path: string;           // Relative path
    version: string;        // Semver version from dossier
    protocol: string;       // Protocol version
    status: string;         // Draft | Stable | Deprecated
    objective: string;      // Brief objective statement
    category?: string;      // From registry if available
  }>;
  registry?: {
    path: string;           // Path to registry file if found
    hasJourneyMaps: boolean;
    hasDependencies: boolean;
  };
}
```

**Example:**
```typescript
// Request
list_dossiers({ path: "./my-project" })

// Response
{
  "dossiers": [
    {
      "name": "project-init",
      "path": "dossiers/project-init.md",
      "version": "1.0.0",
      "protocol": "1.0",
      "status": "Stable",
      "objective": "Initialize project structure and configuration",
      "category": "Setup"
    },
    {
      "name": "deploy-to-aws",
      "path": "dossiers/deploy-to-aws.md",
      "version": "2.1.0",
      "protocol": "1.0",
      "status": "Stable",
      "objective": "Deploy application to AWS with validation",
      "category": "DevOps"
    }
  ],
  "registry": {
    "path": "dossiers/registry.md",
    "hasJourneyMaps": true,
    "hasDependencies": true
  }
}
```

---

### `read_dossier`

Read and parse a dossier file with metadata.

**Parameters:**
```typescript
{
  name: string;           // Dossier name or path
  basePath?: string;      // Base directory (default: cwd)
  includeRegistry?: boolean;  // Include registry context (default: true)
}
```

**Returns:**
```typescript
{
  metadata: {
    name: string;
    version: string;
    protocol: string;
    status: string;
    path: string;
  };
  content: string;        // Full markdown content
  sections: {
    objective?: string;
    prerequisites?: string;
    context?: string;
    decisions?: string;
    actions?: string;
    validation?: string;
    examples?: string;
    troubleshooting?: string;
  };
  registryContext?: {
    relatedDossiers: string[];
    dependencies: string[];
    suggestedAfter?: string[];
    journey?: string;      // Which journey this belongs to
  };
}
```

**Example:**
```typescript
// Request
read_dossier({ name: "project-init" })

// Response
{
  "metadata": {
    "name": "project-init",
    "version": "1.0.0",
    "protocol": "1.0",
    "status": "Stable",
    "path": "dossiers/project-init.md"
  },
  "content": "# Dossier: Project Init\n\n...",
  "sections": {
    "objective": "Initialize project structure...",
    "prerequisites": "- Current directory is empty...",
    "actions": "1. Analyze project type...",
    "validation": "- Verify package.json exists..."
  },
  "registryContext": {
    "relatedDossiers": ["environment-setup", "dependency-install"],
    "suggestedAfter": ["environment-setup"],
    "journey": "Greenfield Project Setup"
  }
}
```

---

### `get_registry`

Get the dossier registry for a project.

**Parameters:**
```typescript
{
  path?: string;          // Directory to search (default: cwd)
}
```

**Returns:**
```typescript
{
  found: boolean;
  registryPath?: string;
  summary?: {
    totalDossiers: number;
    categories: string[];
    journeys: Array<{
      name: string;
      dossiers: string[];
    }>;
  };
  content?: string;       // Full registry markdown
}
```

---

### `validate_dossier`

Validate a dossier against the specification.

**Parameters:**
```typescript
{
  path: string;           // Path to dossier file
  level?: "basic" | "standard" | "advanced";  // Compliance level
}
```

**Returns:**
```typescript
{
  valid: boolean;
  compliance: "basic" | "standard" | "advanced" | "non-compliant";
  errors: Array<{
    section: string;
    issue: string;
    severity: "error" | "warning" | "info";
  }>;
  warnings: Array<{
    section: string;
    suggestion: string;
  }>;
  score: {
    required: number;     // 0-100
    recommended: number;  // 0-100
    overall: number;      // 0-100
  };
}
```

---

### `verify_dossier`

**🔒 Security verification** - Verify integrity and authenticity of a dossier.

**Parameters:**
```typescript
{
  path: string;                    // Path to dossier file
  trusted_keys_path?: string;      // Path to trusted-keys.txt (default: ~/.dossier/trusted-keys.txt)
}
```

**Returns:**
```typescript
{
  dossierFile: string;               // Path to dossier
  integrity: {
    status: "valid" | "invalid" | "missing";
    message: string;
    expectedHash?: string;           // From frontmatter
    actualHash?: string;             // Calculated
  };
  authenticity: {
    status: "verified" | "signed_unknown" | "unsigned" | "invalid" | "error";
    message: string;
    signer?: string;                 // From signature.signed_by
    keyId?: string;                  // From signature.key_id
    publicKey?: string;              // From signature.public_key
    isTrusted: boolean;              // Is key in trusted-keys.txt?
    trustedAs?: string;              // Key identifier from trusted-keys.txt
  };
  riskAssessment: {
    riskLevel: "low" | "medium" | "high" | "critical" | "unknown";
    riskFactors: string[];           // From frontmatter
    destructiveOperations: string[]; // From frontmatter
    requiresApproval: boolean;       // From frontmatter
  };
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  message: string;                   // Human-readable recommendation
  errors: string[];                  // Any errors encountered
}
```

**Example Response (Verified):**
```typescript
{
  "dossierFile": "examples/devops/deploy-to-aws.md",
  "integrity": {
    "status": "valid",
    "message": "Checksum matches - content has not been tampered with",
    "expectedHash": "a3b5c8d9e1f2...",
    "actualHash": "a3b5c8d9e1f2..."
  },
  "authenticity": {
    "status": "verified",
    "message": "Verified signature from trusted source: imboard-ai-2024",
    "signer": "Imboard AI <security@imboard.ai>",
    "keyId": "imboard-ai-2024",
    "publicKey": "RWTx5V7Kf1KLN8BVF3PqZ...",
    "isTrusted": true,
    "trustedAs": "imboard-ai-2024"
  },
  "riskAssessment": {
    "riskLevel": "high",
    "riskFactors": ["modifies_cloud_resources", "requires_credentials"],
    "destructiveOperations": [
      "Creates/updates AWS infrastructure",
      "Modifies IAM roles"
    ],
    "requiresApproval": true
  },
  "recommendation": "WARN",
  "message": "Verified dossier from trusted source. High risk operations require approval.",
  "errors": []
}
```

**Example Response (Unsigned Warning):**
```typescript
{
  "dossierFile": "custom-dossier.md",
  "integrity": {
    "status": "valid",
    "message": "Checksum matches - content has not been tampered with",
    "expectedHash": "abc123...",
    "actualHash": "abc123..."
  },
  "authenticity": {
    "status": "unsigned",
    "message": "No signature found - authenticity cannot be verified",
    "isTrusted": false
  },
  "riskAssessment": {
    "riskLevel": "medium",
    "riskFactors": ["modifies_files"],
    "destructiveOperations": ["Creates configuration files"],
    "requiresApproval": false
  },
  "recommendation": "WARN",
  "message": "Unsigned dossier with medium risk. Verify source before execution.",
  "errors": []
}
```

**Example Response (Blocked - Tampered):**
```typescript
{
  "dossierFile": "tampered-dossier.md",
  "integrity": {
    "status": "invalid",
    "message": "CHECKSUM MISMATCH - dossier has been tampered with!",
    "expectedHash": "abc123...",
    "actualHash": "def456..."
  },
  "authenticity": {
    "status": "error",
    "message": "Cannot verify signature - integrity check failed",
    "isTrusted": false
  },
  "riskAssessment": {
    "riskLevel": "unknown",
    "riskFactors": [],
    "destructiveOperations": [],
    "requiresApproval": true
  },
  "recommendation": "BLOCK",
  "message": "DO NOT EXECUTE - Dossier has been tampered with!",
  "errors": ["Checksum verification FAILED - do not execute!"]
}
```

**Usage in LLM Execution:**

When an LLM reads a dossier, it should:
1. **Call `verify_dossier`** before execution
2. **Check recommendation**:
   - `ALLOW`: Proceed confidently (verified + low risk)
   - `WARN`: Show user the warning and request approval
   - `BLOCK`: Do NOT execute, show error to user
3. **Show risk information** from `riskAssessment`
4. **Follow PROTOCOL.md** security verification steps

**Security Flow:**
```typescript
// 1. Verify dossier
const verification = await verify_dossier({ path: "dossier.md" });

// 2. Handle recommendation
if (verification.recommendation === "BLOCK") {
  console.error(verification.message);
  console.error("Errors:", verification.errors);
  return; // DO NOT EXECUTE
}

if (verification.recommendation === "WARN") {
  console.warn(verification.message);
  console.warn("Risk Level:", verification.riskAssessment.riskLevel);
  console.warn("Destructive Operations:", verification.riskAssessment.destructiveOperations);

  // Request user approval
  const approved = await askUser("Proceed? (y/N)");
  if (!approved) return;
}

// 3. Proceed with execution
executeDossier(dossierContent);
```

---

## Resources

Resources provide documentation and context about the dossier system.

### `dossier://concept`

**URI**: `dossier://concept`
**MIME Type**: `text/markdown`

**Description**: Introduction to the dossier concept - what they are, why they exist, and how to use them.

**Content**: Condensed version of README.md focusing on:
- What are dossiers?
- Why use dossiers vs scripts?
- Basic usage patterns
- When to use dossiers

---

### `dossier://protocol`

**URI**: `dossier://protocol`
**MIME Type**: `text/markdown`

**Description**: The Dossier Execution Protocol - how to execute dossiers, including self-improvement, safety guidelines, and validation.

**Content**: Full PROTOCOL.md content

---

### `dossier://specification`

**URI**: `dossier://specification`
**MIME Type**: `text/markdown`

**Description**: Formal specification for creating compliant dossiers.

**Content**: Full SPECIFICATION.md content

---

### `dossier://examples`

**URI**: `dossier://examples`
**MIME Type**: `application/json`

**Description**: List of example dossiers with descriptions.

**Content**:
```json
{
  "examples": [
    {
      "name": "AWS Deployment",
      "path": "examples/devops/deploy-to-aws.md",
      "description": "Deploy applications to AWS using Infrastructure as Code",
      "demonstrates": [
        "Cloud infrastructure automation",
        "Terraform/CloudFormation",
        "Environment management",
        "Rollback procedures"
      ]
    },
    {
      "name": "ML Training Pipeline",
      "path": "examples/data-science/train-ml-model.md",
      "description": "Train ML models with validation and artifact management",
      "demonstrates": [
        "Data validation",
        "Python ecosystem",
        "Iterative experimentation",
        "Artifact management"
      ]
    },
    {
      "name": "Database Migration",
      "path": "examples/database/migrate-schema.md",
      "description": "Execute schema migrations with safety and rollback",
      "demonstrates": [
        "High-risk operations",
        "ACID transactions",
        "Multiple DB types",
        "Backup procedures"
      ]
    },
    {
      "name": "React Component Library",
      "path": "examples/development/setup-react-library.md",
      "description": "Create production-ready React library with TypeScript",
      "demonstrates": [
        "Development tooling",
        "NPM publishing",
        "Frontend ecosystem",
        "Build optimization"
      ]
    }
  ]
}
```

---

### `dossier://security`

**URI**: `dossier://security`
**MIME Type**: `text/markdown`

**Description**: Security architecture and trust model - how dossiers are signed, verified, and trusted.

**Content**: Full SECURITY_ARCHITECTURE.md content

**Key Topics**:
- Multi-layer security (integrity, authenticity, risk assessment)
- Signing with minisign
- Trust model (decentralized like Docker Hub)
- Verification workflow
- Risk classification guidelines
- Best practices for authors and users

---

### `dossier://keys`

**URI**: `dossier://keys`
**MIME Type**: `text/plain`

**Description**: Official and community public keys for signature verification.

**Content**: Full KEYS.txt content

**Usage**:
- Provides official Imboard AI public key
- Explains how to add keys to trusted-keys.txt
- Documents trust model
- Lists revoked keys

---

## Prompts

Prompts provide execution templates for common dossier operations.

### `execute-dossier`

**Name**: `execute-dossier`
**Description**: Execute a dossier following the standard protocol

**Arguments**:
```typescript
{
  dossier: string;        // Dossier name to execute
  options?: {
    skipImprovement?: boolean;    // Skip self-improvement analysis
    autoConfirm?: boolean;        // Don't prompt for confirmations (dangerous!)
    dryRun?: boolean;             // Validate but don't execute
  };
}
```

**Prompt Template**:
```
You are about to execute the "{dossier}" dossier following the Dossier Execution Protocol v1.0.

## Protocol Steps

1. **🔒 Security Verification** (REQUIRED - ALWAYS FIRST)
   - Use verify_dossier tool to check integrity and authenticity
   - Check verification.recommendation:
     * BLOCK → DO NOT EXECUTE, show error to user
     * WARN → Show warning + risk info, request user approval
     * ALLOW → Proceed with confidence
   - If WARN and user declines → STOP execution
   - Access dossier://security for security architecture details

2. **Read Protocol & Dossier**
   - Access dossier://protocol resource for execution guidelines
   - Use read_dossier tool to get the dossier content
   - Review self-improvement analysis requirements

3. **Pre-Execution Analysis** (unless skipImprovement=true)
   - Analyze dossier quality per protocol
   - Identify potential improvements based on current project
   - Suggest enhancements to user
   - Apply improvements if user accepts

4. **Validate Prerequisites**
   - Check all prerequisites from dossier
   - Verify required tools/permissions
   - Confirm with user if any prerequisites are missing

5. **Gather Context**
   - Analyze project structure per "Context to Gather" section
   - Identify relevant files and configurations
   - Understand project-specific constraints

6. **Make Decisions**
   - Process "Decision Points" section
   - Choose appropriate options based on gathered context
   - Explain choices to user

7. **Execute Actions**
   - Follow "Actions to Perform" sequentially
   - Request confirmation for destructive operations (unless autoConfirm=true)
   - Provide progress updates
   - Handle errors per troubleshooting guidance
   - Log all actions for audit trail

8. **Validate Results**
   - Run all validation checks from "Validation" section
   - Verify success criteria met
   - Report outcome to user

8. **Post-Execution** (if improvements were made)
   - Offer to save improved dossier version
   - Document what was learned

## Execution Options

- Skip self-improvement: {skipImprovement || false}
- Auto-confirm actions: {autoConfirm || false}
- Dry run mode: {dryRun || false}

Begin execution now. Start by reading the protocol and dossier.
```

---

### `create-dossier`

**Name**: `create-dossier`
**Description**: Create a new dossier from scratch

**Arguments**:
```typescript
{
  name: string;           // Dossier name
  type: "setup" | "development" | "devops" | "maintenance" | "custom";
  compliance?: "basic" | "standard" | "advanced";  // Target compliance level
}
```

**Prompt Template**:
```
Create a new dossier named "{name}" of type "{type}".

## Steps

1. **Read Specification**
   - Access dossier://specification resource
   - Understand required sections and format
   - Review compliance requirements for "{compliance || "standard"}" level

2. **Interview User**
   - What is the objective of this dossier?
   - What prerequisites are needed?
   - What context should be gathered?
   - What actions should be performed?
   - How should success be validated?
   - What common issues might occur?

3. **Draft Dossier**
   - Follow SPECIFICATION.md structure
   - Include all required sections
   - Add recommended sections (context, decisions, examples, troubleshooting)
   - Use clear, specific language
   - Provide examples

4. **Validate Draft**
   - Use validate_dossier tool
   - Address any errors or warnings
   - Aim for "{compliance || "standard"}" compliance level

5. **Review with User**
   - Present draft for feedback
   - Iterate based on input
   - Finalize and save

Begin by reading the specification and interviewing the user.
```

---

### `improve-dossier`

**Name**: `improve-dossier`
**Description**: Analyze and improve an existing dossier

**Arguments**:
```typescript
{
  dossier: string;        // Dossier name or path
  projectContext?: string;  // Optional: analyze for specific project
}
```

**Prompt Template**:
```
Analyze and improve the "{dossier}" dossier.

## Analysis Process

1. **Read Current Dossier**
   - Use read_dossier tool
   - Review all sections
   - Check compliance level with validate_dossier

2. **Context Analysis** (if projectContext provided)
   - Examine {projectContext || "current project"}
   - Identify gaps between dossier and actual project needs
   - Find missing edge cases or decision points

3. **Quality Assessment**
   - Evaluate completeness of each section
   - Check for vague or ambiguous instructions
   - Identify missing examples or troubleshooting
   - Review for LLM-agnostic language

4. **Improvement Suggestions**
   - Propose specific enhancements:
     * Missing prerequisites
     * Additional context to gather
     * New decision points
     * Better action clarity
     * Enhanced validation
     * Missing troubleshooting cases
   - Prioritize by impact

5. **User Review**
   - Present findings and suggestions
   - Explain rationale for each improvement
   - Let user choose which to apply

6. **Apply Improvements**
   - Make approved changes
   - Increment version number appropriately
   - Validate improved dossier
   - Save updated version

Begin analysis now.
```

---

## Implementation Guide

### 1. Project Setup

```bash
# Initialize MCP server project
mkdir dossier-mcp-server
cd dossier-mcp-server
npm init -y

# Install MCP SDK
npm install @modelcontextprotocol/sdk

# Install dependencies
npm install typescript @types/node
npm install -D tsx
```

### 2. Directory Structure

```
dossier-mcp-server/
├── src/
│   ├── index.ts              # Server entry point
│   ├── tools/
│   │   ├── listDossiers.ts
│   │   ├── readDossier.ts
│   │   ├── getRegistry.ts
│   │   └── validateDossier.ts
│   ├── resources/
│   │   ├── concept.ts
│   │   ├── protocol.ts
│   │   ├── specification.ts
│   │   └── examples.ts
│   ├── prompts/
│   │   ├── executeDossier.ts
│   │   ├── createDossier.ts
│   │   └── improveDossier.ts
│   ├── parsers/
│   │   ├── dossierParser.ts
│   │   ├── registryParser.ts
│   │   └── validator.ts
│   └── types/
│       └── dossier.ts
├── package.json
├── tsconfig.json
└── README.md
```

### 3. Core Implementation

**Server Entry (`src/index.ts`)**:
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listDossiersHandler } from "./tools/listDossiers.js";
import { readDossierHandler } from "./tools/readDossier.js";
import { getRegistryHandler } from "./tools/getRegistry.js";
import { validateDossierHandler } from "./tools/validateDossier.js";

import { getConceptResource } from "./resources/concept.js";
import { getProtocolResource } from "./resources/protocol.js";
import { getSpecificationResource } from "./resources/specification.js";
import { getExamplesResource } from "./resources/examples.js";

const server = new Server(
  {
    name: "dossier-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_dossiers",
      description: "Discover available dossiers in a directory",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to search" },
          recursive: { type: "boolean", description: "Search subdirectories" },
          filter: { type: "string", description: "Glob pattern filter" },
        },
      },
    },
    {
      name: "read_dossier",
      description: "Read and parse a dossier file with metadata",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Dossier name or path" },
          basePath: { type: "string", description: "Base directory" },
          includeRegistry: { type: "boolean", description: "Include registry context" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_registry",
      description: "Get the dossier registry for a project",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to search" },
        },
      },
    },
    {
      name: "validate_dossier",
      description: "Validate a dossier against the specification",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to dossier file" },
          level: {
            type: "string",
            enum: ["basic", "standard", "advanced"],
            description: "Compliance level",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "list_dossiers":
      return listDossiersHandler(request.params.arguments);
    case "read_dossier":
      return readDossierHandler(request.params.arguments);
    case "get_registry":
      return getRegistryHandler(request.params.arguments);
    case "validate_dossier":
      return validateDossierHandler(request.params.arguments);
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// Register resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "dossier://concept",
      name: "Dossier Concept",
      description: "Introduction to dossiers",
      mimeType: "text/markdown",
    },
    {
      uri: "dossier://protocol",
      name: "Dossier Execution Protocol",
      description: "How to execute dossiers",
      mimeType: "text/markdown",
    },
    {
      uri: "dossier://specification",
      name: "Dossier Specification",
      description: "Formal dossier standard",
      mimeType: "text/markdown",
    },
    {
      uri: "dossier://examples",
      name: "Example Dossiers",
      description: "Example dossiers with descriptions",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  switch (uri) {
    case "dossier://concept":
      return getConceptResource();
    case "dossier://protocol":
      return getProtocolResource();
    case "dossier://specification":
      return getSpecificationResource();
    case "dossier://examples":
      return getExamplesResource();
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Register prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "execute-dossier",
      description: "Execute a dossier following the standard protocol",
      arguments: [
        {
          name: "dossier",
          description: "Dossier name to execute",
          required: true,
        },
      ],
    },
    {
      name: "create-dossier",
      description: "Create a new dossier from scratch",
      arguments: [
        {
          name: "name",
          description: "Dossier name",
          required: true,
        },
        {
          name: "type",
          description: "Dossier type",
          required: true,
        },
      ],
    },
    {
      name: "improve-dossier",
      description: "Analyze and improve an existing dossier",
      arguments: [
        {
          name: "dossier",
          description: "Dossier name or path",
          required: true,
        },
      ],
    },
  ],
}));

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Dossier MCP Server running on stdio");
}

main().catch(console.error);
```

### 4. Installation & Configuration

**For Users:**

```bash
# Install globally
npm install -g @ai-dossier/mcp-server

# Or use npx
npx @ai-dossier/mcp-server
```

**Claude Desktop Configuration:**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["@ai-dossier/mcp-server"]
    }
  }
}
```

**Cursor Configuration:**

Add to `.cursor/mcp_config.json`:

```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["@ai-dossier/mcp-server"]
    }
  }
}
```

---

## Testing

### Manual Testing

```bash
# List dossiers in current directory
echo '{"method":"list_dossiers","params":{"path":"."}}' | npx @ai-dossier/mcp-server

# Read a specific dossier
echo '{"method":"read_dossier","params":{"name":"project-init"}}' | npx @ai-dossier/mcp-server

# Get registry
echo '{"method":"get_registry","params":{"path":"."}}' | npx @ai-dossier/mcp-server
```

### Integration Testing

1. **Test with Claude Desktop**:
   - Install MCP server
   - Configure claude_desktop_config.json
   - Restart Claude Desktop
   - Try: "List available dossiers in this project"
   - Try: "Execute the project-init dossier"

2. **Test with Cursor**:
   - Configure MCP server
   - Restart Cursor
   - Try: "What dossiers are available?"
   - Try: "Use the deploy-to-aws dossier"

---

## Roadmap

### Phase 1: Core Functionality (v1.0.0)
- ✅ Specification complete
- ⏳ Basic tools implementation
- ⏳ Resource providers
- ⏳ Execute-dossier prompt
- ⏳ Basic parser
- ⏳ Testing suite

### Phase 2: Enhanced Features (v1.1.0)
- ⏳ Registry parsing and relationships
- ⏳ Advanced validation
- ⏳ Journey map support
- ⏳ Dependency tracking
- ⏳ Create-dossier prompt
- ⏳ Improve-dossier prompt

### Phase 3: Ecosystem (v1.2.0)
- ⏳ NPM package published
- ⏳ Comprehensive documentation
- ⏳ Example projects
- ⏳ Community templates
- ⏳ VS Code extension integration

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Development setup
- Testing guidelines
- Pull request process
- Code style

---

## License

AGPL-3.0 - See LICENSE file

---

**Status**: Specification complete, implementation in progress. Contributions welcome!
