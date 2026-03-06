# Dossier Architecture Overview

High-level architecture overview of the Dossier project.

## System Architecture

Dossier consists of three main components in a monorepo structure:

```
dossier/
├── packages/core/          # @ai-dossier/core - Verification library
├── cli/                    # @ai-dossier/cli - CLI tool
└── mcp-server/            # @ai-dossier/mcp-server - MCP integration
```

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       End Users / AI Agents                  │
└────────────┬────────────────────────────┬────────────────────┘
             │                            │
             ▼                            ▼
     ┌───────────────┐           ┌──────────────────┐
     │  @ai-dossier/cli │           │ @ai-dossier/mcp     │
     │               │           │                  │
     │ - Verify      │           │ - Discover       │
     │ - Download    │           │ - Verify         │
     │ - Execute     │           │ - Execute        │
     └───────┬───────┘           └────────┬─────────┘
             │                            │
             └────────────┬───────────────┘
                          │
                          ▼
                 ┌────────────────┐
                 │ @ai-dossier/core  │
                 │                │
                 │ - Parser       │
                 │ - Checksum     │
                 │ - Signature    │
                 │ - Types        │
                 └────────────────┘
```

## Core Library (@ai-dossier/core)

**Purpose**: Shared verification and parsing logic

**Key Modules**:
- `parser.ts` - Dossier parsing (frontmatter + body)
- `checksum.ts` - SHA256 integrity verification
- `signature.ts` - Minisign & AWS KMS signature verification
- `types.ts` - TypeScript type definitions

**Dependencies**:
- `@aws-sdk/client-kms` - AWS KMS integration
- `tweetnacl` - Ed25519 cryptography (Minisign)

**Exports**:
```typescript
export interface Dossier {
  metadata: DossierMetadata;
  body: string;
}

export function parseDossier(content: string): Dossier
export function verifyChecksum(dossier: Dossier): boolean
export function verifySignature(dossier: Dossier): SignatureResult
```

## CLI Tool (@ai-dossier/cli)

**Purpose**: Command-line verification for users

**Entry Point**: `bin/ai-dossier`

**Flow**:
```
User Command
    ↓
Download/Read File
    ↓
Parse Dossier (using @ai-dossier/core)
    ↓
Verify Checksum
    ↓
Verify Signature (if present)
    ↓
Risk Assessment
    ↓
Exit 0 (safe) or 1 (unsafe)
```

**Features**:
- Local file and URL support
- Verbose mode for debugging
- Exit codes for scripting
- Human-readable output

### Multi-Registry Resolution

The CLI supports querying multiple registries in parallel when resolving dossiers. This is handled by the `multi-registry` module (`cli/src/multi-registry.ts`).

**Resolution strategy**: All configured registries are queried simultaneously using `Promise.allSettled()`. For **get** operations (`multiRegistryGetDossier`, `multiRegistryGetContent`), the first successful result is returned. For **list/search** operations (`multiRegistryList`, `multiRegistrySearch`), results from all successful registries are merged. In both cases, per-registry errors are collected and returned alongside the result.

```
User: dossier get org/my-dossier
    ↓
Resolve configured registries (config.ts)
    ↓
Query ALL registries in parallel (Promise.allSettled)
    ┌────────┼────────┐
    ↓        ↓        ↓
Registry A  Registry B  Registry C
    ↓        ↓        ↓
    └────────┼────────┘
    ↓
Return { result, errors }
```

**Structured error returns**: All multi-registry functions return a structured object instead of a bare value:

```typescript
// multiRegistryGetDossier returns:
{
  result: LabeledDossierInfo | null,  // First successful result, or null
  errors: Array<{ registry: string; error: string }>  // Per-registry errors
}

// multiRegistryGetContent returns:
{
  result: (DossierContentResult & { _registry: string }) | null,
  errors: Array<{ registry: string; error: string }>
}

// multiRegistryList / multiRegistrySearch return:
{
  dossiers: LabeledDossierListItem[],  // Merged results from all registries
  total: number,
  errors: Array<{ registry: string; error: string }>
}
```

This pattern ensures that:
- **Partial failures are surfaced**: If one registry is down but another succeeds, the caller gets both the result and the error details.
- **Callers can distinguish "not found" from "all registries failed"**: When `result` is `null` and `errors` is non-empty, at least one registry encountered an error. When `result` is `null` and `errors` is empty, no registries are configured.
- **Registry source is always labeled**: Each result includes a `_registry` field identifying which registry provided it.

## MCP Server (@ai-dossier/mcp-server)

**Purpose**: Integration with AI agents via Model Context Protocol

**Architecture**:
```
MCP Client (Claude, etc.)
    ↓
MCP Protocol (stdio)
    ↓
@ai-dossier/mcp-server
    ├── Resources (discover dossiers)
    ├── Tools (verify, execute)
    └── Prompts (templates)
```

**Key Features**:
- Resource discovery (list available dossiers)
- Verification tools
- Execution capabilities
- Template prompts for common workflows

## Verification Flow

### Checksum Verification

```
1. Extract body from dossier (everything after frontmatter)
2. Calculate SHA256 hash of body
3. Compare with checksum in frontmatter
4. Match → ✅ | Mismatch → ❌ BLOCK
```

### Signature Verification

```
1. Check if signature present in frontmatter
2. Determine signature type (Minisign | AWS KMS)
3. Extract public key
4. Verify signature against body
5. Check if key is trusted
6. Valid + Trusted → ✅ | Invalid → ❌ BLOCK
```

## Security Architecture

See [../../security/ARCHITECTURE.md](../../security/ARCHITECTURE.md) for detailed security architecture.

**Key Principles**:
- **Fail secure**: Default to blocking on verification failure
- **Defense in depth**: Multiple verification layers
- **Cryptographic verification**: SHA256 + optional signatures
- **Trust management**: User-controlled trusted keys

## Data Flow

### Dossier Creation

```
Author writes dossier.md
    ↓
Calculate SHA256 checksum
    ↓
(Optional) Sign with Minisign/KMS
    ↓
Add checksum + signature to frontmatter
    ↓
Publish dossier.ds.md
```

### Dossier Execution

```
User/Agent requests dossier
    ↓
Download/Read file
    ↓
Verify checksum (integrity)
    ↓
Verify signature (authenticity)
    ↓
Risk assessment
    ↓
Execute (if verified) or BLOCK
```

## Package Structure

### Monorepo (npm workspaces)

```json
{
  "workspaces": [
    "packages/*",
    "mcp-server",
    "cli"
  ]
}
```

**Build Process**:
1. Build @ai-dossier/core (TypeScript → JavaScript)
2. Publish @ai-dossier/core to npm
3. Publish @ai-dossier/cli (depends on core)
4. Publish @ai-dossier/mcp-server (depends on core)

## Technology Stack

- **Language**: TypeScript / JavaScript
- **Runtime**: Node.js ≥ 18
- **Build**: TypeScript Compiler (tsc)
- **Package Manager**: npm
- **Distribution**: npm / GitHub Packages
- **CI/CD**: GitHub Actions

## Design Decisions

Key architectural decisions are documented in [Architecture Decision Records (ADRs)](adr/).

## External Dependencies

### Production
- `@aws-sdk/client-kms` - AWS Key Management Service
- `tweetnacl` - Ed25519 cryptography
- `@modelcontextprotocol/sdk` - MCP protocol (mcp-server only)
- `zod` - Schema validation (mcp-server only)

### Development
- `typescript` - Type safety and compilation
- `@types/node` - Node.js type definitions

## Future Architecture

Planned enhancements:
- Plugin system for custom verifiers
- WebAssembly build for browser support
- Distributed dossier registry
- P2P verification networks

See [../planning/roadmap.md](../planning/roadmap.md) for details.

## Related Documentation

- [Protocol Specification](../reference/protocol.md)
- [Security Architecture](../../security/ARCHITECTURE.md)
- [Contributing Guide](../contributing/README.md)
