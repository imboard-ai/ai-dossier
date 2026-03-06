# Dossier Architecture

This document provides a high-level overview of the Dossier project architecture.

## Quick Overview

Dossier is a lightweight automation standard built on three principles:
1. **Human-readable**: Markdown files that both humans and AI can understand
2. **Cryptographically verifiable**: SHA256 checksums + optional signatures
3. **Security-first**: Verify before execution

## System Components

```
┌─────────────────────────────────────────┐
│         Dossier Ecosystem                │
├─────────────────────────────────────────┤
│  @ai-dossier/cli      │  Command-line tool │
│  @ai-dossier/core     │  Verification lib  │
│  @ai-dossier/mcp      │  AI agent support  │
│  @ai-dossier/registry │  Registry API      │
└─────────────────────────────────────────┘
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

```
Download/Read Dossier
    ↓
Parse frontmatter + body
    ↓
Verify checksum (integrity)
    ↓
Verify signature (authenticity)
    ↓
Risk assessment
    ↓
Execute or BLOCK
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
