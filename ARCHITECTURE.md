# Dossier Architecture

This document provides a high-level overview of the Dossier project architecture.

## Quick Overview

Dossier is a lightweight automation standard built on three principles:
1. **Human-readable**: Markdown files that both humans and AI can understand
2. **Cryptographically verifiable**: SHA256 checksums + optional signatures
3. **Security-first**: Verify before execution

## System Components

```mermaid
graph TB
    subgraph Ecosystem["Dossier Ecosystem"]
        Core["@ai-dossier/core\nVerification library"]
        CLI["@ai-dossier/cli\nCommand-line tool"]
        MCP["@ai-dossier/mcp-server\nAI agent support"]
        Registry["@ai-dossier/registry\nRegistry API"]
    end

    Core --> CLI
    Core --> MCP
    CLI --> Registry

    style Core fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    style CLI fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    style MCP fill:#fff3e0,stroke:#ef6c00,color:#e65100
    style Registry fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
```

### Core Library (`@ai-dossier/core`)
Shared verification and parsing logic used by all tools. Handles:
- Dossier parsing (JSON frontmatter + Markdown body)
- SHA256 checksum verification
- Signature verification (Minisign, AWS KMS)

### CLI Tool (`@ai-dossier/cli`)
Command-line verification tool for end users:
```bash
ai-dossier verify <file-or-url>
```

### MCP Server (`@ai-dossier/mcp-server`)
Model Context Protocol integration for AI agents like Claude Code.

### Registry (`@ai-dossier/registry`)
Vercel serverless API for discovering, publishing, and managing dossiers. Uses GitHub OAuth + JWT for authentication and jsDelivr CDN for content delivery.

### Multi-Registry Resolution (CLI)
The CLI supports multiple configured registries and queries them in parallel using `Promise.allSettled()`. All multi-registry functions (`multiRegistryGetDossier`, `multiRegistryGetContent`, `multiRegistryList`, `multiRegistrySearch`) return structured results that include both the data and per-registry error details:

```typescript
{ result: T | null, errors: Array<{ registry: string; error: string }> }
```

This allows partial failures to be surfaced without blocking successful results from other registries. See `docs/architecture/overview.md` for architectural details and `cli/src/multi-registry.ts` for implementation.

### Multi-Registry Failure Modes

All failures are captured per-registry via `Promise.allSettled()` and included in the `errors` array alongside successful results. Key behaviors:

- **Partial failure**: Unreachable or erroring registries don't block results from healthy ones. The CLI succeeds if at least one registry responds.
- **Total failure**: When all registries fail, `get`/`run`/`pull` exit 1; `list`/`search` exit 0 with empty results and per-registry warnings.
- **Auth errors** (401/403): Treated as per-registry errors. Other registries are still queried.
- **No registries configured**: CLI falls back to the hardcoded public registry transparently.

For per-command exit codes and user-facing error output, see [cli/README.md — Exit Codes](cli/README.md#exit-codes).

## File Format

Dossiers are Markdown files with JSON frontmatter using the `---dossier` delimiter:

```markdown
---dossier
{
  "title": "Example Dossier",
  "version": "1.0.0",
  "checksum": {
    "algorithm": "sha256",
    "hash": "e3b0c44298fc1c149afbf4c8996fb924..."
  }
}
---

# Instructions

Your automation steps here...
```

## Verification Flow

```mermaid
flowchart TD
    A["Download / Read Dossier"] --> B["Parse frontmatter + body"]
    B --> C["Verify checksum\n(integrity)"]
    C --> D["Verify signature\n(authenticity)"]
    D --> E["Risk assessment"]
    E -->|"safe"| F["Execute"]
    E -->|"blocked"| G["BLOCK"]

    style A fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    style F fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    style G fill:#ffebee,stroke:#c62828,color:#b71c1c
```

## Security Model

- **Integrity**: SHA256 checksums detect tampering
- **Authenticity**: Optional cryptographic signatures verify author
- **Trust**: User-controlled trusted key management
- **Fail-secure**: Block execution on any verification failure

See [security/ARCHITECTURE.md](security/ARCHITECTURE.md) for details.

## Technology Stack

- **Language**: TypeScript/JavaScript
- **Runtime**: Node.js ≥ 20
- **Cryptography**:
  - SHA-256 for checksums
  - Ed25519 (Minisign) for signatures
  - ECDSA (AWS KMS) for enterprise signing

## Repository Structure

```
dossier/
├── packages/
│   └── core/              # @ai-dossier/core
├── cli/                   # @ai-dossier/cli
├── mcp-server/           # @ai-dossier/mcp-server
├── registry/             # @ai-dossier/registry (Vercel serverless API)
├── examples/             # Example dossiers
├── security/             # Security documentation
├── docs/                 # Detailed documentation
│   ├── architecture/     # Architecture docs
│   ├── guides/           # How-to guides
│   └── reference/        # Technical specs
└── ...
```

## Detailed Documentation

For comprehensive architecture documentation, see:

- **[Architecture Overview](docs/architecture/overview.md)** - Detailed system architecture
- **[Architecture Decision Records](docs/architecture/adr/)** - Key design decisions
- **[Security Architecture](security/ARCHITECTURE.md)** - Security design and threat model
- **[Protocol Specification](docs/reference/protocol.md)** - Dossier file format specification

## Design Principles

1. **Simplicity**: Minimal dependencies, clear abstractions
2. **Security**: Cryptographic verification by default
3. **Extensibility**: Plugin architecture for custom verifiers
4. **Standards-based**: Follow OSS best practices
5. **Developer experience**: Clear APIs, comprehensive docs

## For Contributors

- **Understanding the codebase**: Start with [docs/architecture/overview.md](docs/architecture/overview.md)
- **Making changes**: Create an ADR in [docs/architecture/adr/](docs/architecture/adr/)
- **Development setup**: See [docs/contributing/](docs/contributing/)
- **Security**: Review [security/](security/) before security-related changes

## Questions?

- **Documentation**: [docs/](docs/)
- **Issues**: https://github.com/imboard-ai/ai-dossier/issues
- **Discussions**: https://github.com/imboard-ai/ai-dossier/discussions

---

**License**: [AGPL-3.0](LICENSE) | **Maintained by**: Imboard AI
