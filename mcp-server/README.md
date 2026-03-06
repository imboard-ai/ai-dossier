# Dossier MCP Server

> **Status**: ✅ MVP Complete - Core security verification tools working, ready for testing with Claude Code

Make dossier automation truly frictionless with Model Context Protocol integration.

---

## The Problem

Currently, using dossiers requires explaining the concept and providing file contents to your LLM:

```
❌ Current Reality:
User: "Use the project-init dossier"
LLM:  "I don't know what a dossier is, and I can't access that file"

User: *Explains dossiers, copies file content, pastes it*
LLM:  "OK, now I understand. Let me execute this..."
```

This creates friction for new users and breaks the promise of natural language automation.

---

## The Solution

The **Dossier MCP Server** enables LLMs to discover, understand, and execute dossiers automatically:

```
✅ With MCP Server:
User: "Use the project-init dossier"
LLM:  *Uses MCP to read concept, find dossier, understand protocol*
LLM:  "Found project-init dossier v1.0.0. Analyzing prerequisites..."
```

---

## What It Provides

### 🛠️ Tools

- **`list_dossiers`** - Discover available dossiers
- **`read_dossier`** - Get dossier content and metadata. Returns `security_notices` when undeclared external URLs are detected in the body.
- **`get_registry`** - Understand dossier relationships
- **`validate_dossier`** - Check specification compliance
- **`verify_dossier`** - 🔒 Verify integrity and authenticity (security)

### 📚 Resources

- **`dossier://concept`** - What are dossiers?
- **`dossier://protocol`** - How to execute them (includes security protocol)
- **`dossier://specification`** - How to create them
- **`dossier://examples`** - Example dossiers
- **`dossier://security`** - 🔒 Security architecture and trust model
- **`dossier://keys`** - 🔒 Official and community public keys

### 💡 Prompts ✅ Implemented

- **`execute-dossier`** - Run a dossier following the verification → execution protocol
- **`create-dossier`** - Author a new dossier using the official meta-dossier template

---

## Installation

### Using with Claude Code

```bash
# Global installation (available across all projects)
claude mcp add dossier --scope user -- npx @ai-dossier/mcp-server

# Or project-only installation
claude mcp add dossier -- npx @ai-dossier/mcp-server
```

Verify with:
```bash
claude mcp list
```

Then try it:
```
"List available dossiers in this project"
"Execute the project-init dossier"
```

---

## Example Usage

### Discovery

```
User: "What dossiers are available in this project?"

LLM: *Uses list_dossiers tool*
     Found 5 dossiers:
     - project-init (Setup) - Initialize project structure
     - environment-setup (Setup) - Configure development environment
     - deploy-to-aws (DevOps) - Deploy to AWS with validation
     - run-tests (Development) - Execute test suite
     - cleanup (Maintenance) - Remove temporary files
```

### Execution

```
User: "Use the project-init dossier"

LLM: *Uses read_dossier tool to get content*
     *Uses dossier://protocol resource to understand execution*

     Executing: project-init dossier v1.0.0

     Prerequisites:
     ✓ Directory is writable
     ✓ Git is installed

     Context Analysis:
     - Detected: Node.js project (package.json found)
     - Framework: Express.js
     - TypeScript: Yes

     Decision: Using Node.js + TypeScript template

     Actions:
     ✓ Created .gitignore
     ✓ Created tsconfig.json
     ✓ Created README.md
     ✓ Initialized Git repository

     Validation:
     ✓ All files created successfully
     ✓ Git repository initialized

     Project initialization complete!
```

### Registry Understanding

```
User: "I want to set up a new project from scratch. What's the recommended workflow?"

LLM: *Uses get_registry tool*

     Based on your project's dossier registry, here's the recommended
     "Greenfield Project Setup" journey:

     1. project-init - Initialize basic structure
     2. environment-setup - Configure dev environment
     3. dependency-install - Install dependencies
     4. test-setup - Set up testing framework

     Would you like me to execute this journey?
```

---

## 🔒 Built-in Security

The MCP server includes comprehensive security verification for all dossiers.

### Automatic Verification

Every dossier execution through the MCP server is automatically verified:

```
User: "Execute the deploy-to-aws dossier"

LLM: *Calls verify_dossier tool*

     🔒 Security Verification:
     ✅ Integrity: Checksum verified (content not tampered with)
     ✅ Authenticity: Signed by imboard-ai-2024 (trusted)
     ⚠️  Risk Level: HIGH

     This dossier will:
     • Modify AWS infrastructure
     • Require AWS credentials
     • Execute Infrastructure as Code

     Proceed? (y/N)
```

### Security Features

**1. Integrity Verification**
- SHA256 checksums ensure dossiers haven't been modified
- Automatic verification before execution
- BLOCKS execution if checksum fails

**2. Cryptographic Signatures (Optional)**
- Dossiers can be signed with minisign
- Trust levels: VERIFIED, SIGNED_UNKNOWN, UNSIGNED, INVALID
- User controls which keys to trust

**3. Risk Assessment**
- Every dossier declares risk level (low/medium/high/critical)
- Specific risk factors (modifies_files, requires_credentials, etc.)
- Detailed destructive operations list
- Automatic approval requests for high-risk operations

**4. Trust Model**
- Decentralized (like Docker Hub)
- Official dossiers signed by Imboard AI
- Community dossiers signed by their authors
- Users choose which keys to trust in `~/.dossier/trusted-keys.txt`

### Verification Responses

The `verify_dossier` tool returns:

- **ALLOW**: Verified signature from trusted source + low risk → Execute confidently
- **WARN**: Unsigned/unknown signer OR high risk → Request user approval
- **BLOCK**: Checksum failed OR signature invalid → DO NOT EXECUTE

### Resources

- `dossier://security` - Full security architecture documentation
- `dossier://keys` - Official and community public keys
- `dossier://protocol` - Includes security verification steps

Learn more: [Security Architecture](../security/ARCHITECTURE.md)

---

## For Developers

### Project Structure

```
dossier-mcp-server/
├── src/
│   ├── index.ts              # Server entry point
│   ├── tools/                # Tool implementations
│   ├── resources/            # Resource providers
│   ├── prompts/              # Prompt templates
│   ├── parsers/              # Dossier parsing logic
│   └── types/                # TypeScript definitions
├── tests/                    # Test suite
├── examples/                 # Usage examples
└── docs/                     # Additional documentation
```

### Development Setup

```bash
# Clone and install
git clone https://github.com/imboard-ai/ai-dossier.git
cd ai-dossier/mcp-server
npm install

# Build
npm run build

# Test
npm test

# Run locally
npm start
```

### Contributing

See [SPECIFICATION.md](./SPECIFICATION.md) for detailed API design.

Contributions welcome! This is a critical piece of infrastructure for making dossiers truly frictionless.

**Priority areas**:
- [ ] Core tool implementations
- [ ] Resource providers
- [ ] Dossier parser
- [ ] Validation logic
- [ ] Test coverage
- [ ] Documentation

---

## Roadmap

### Phase 1: MVP (v1.0.0) - ✅ COMPLETED
- [x] Basic tools (list_dossiers, read_dossier) ✅
- [x] Core resources (concept, protocol, security) ✅
- [x] **Security verification** (`verify_dossier` tool) ✅
- [x] Checksum verification (SHA256) ✅
- [x] Signature verification (minisign) ✅
- [x] Trust management (trusted-keys.txt) ✅
- [x] Risk assessment and recommendations ✅
- [x] TypeScript implementation ✅
- [x] MCP SDK integration ✅
- [x] Structured logging ✅
- [x] Working locally with Claude Code ✅

### Phase 2: Testing & Publishing (v1.1.0) - 🚧 NEXT
- [x] MCP Prompts (execute-dossier, create-dossier) ✅
- [ ] Integration testing with Claude Code
- [ ] Test with all example dossiers
- [ ] NPM package preparation
- [ ] CLI entry point for global install
- [ ] Advanced validation (`validate_dossier` tool)
- [ ] Registry relationship parsing (`get_registry` tool)
- [ ] Comprehensive test suite
- [ ] Documentation improvements

### Phase 3: Ecosystem (v1.2.0) - Target: Future
- [ ] NPM package published
- [ ] Journey map support
- [ ] suggest-dossier prompt (LLM-based discovery)
- [ ] VS Code extension
- [ ] Web documentation
- [ ] Community templates
- [ ] Video tutorials

---

## Why This Matters

The Dossier MCP Server is the key to making dossiers **truly universal and frictionless**.

**Without MCP**:
- Users must manually explain dossiers
- Copy-pasting file contents is tedious
- No standardized discovery
- Limited to file-access-capable tools

**With MCP**:
- LLMs understand dossiers automatically
- Discovery is programmatic
- Works with any MCP-compatible tool
- Execution follows standard protocol
- Registry relationships are understood

This transforms dossiers from "interesting idea" to "production-ready automation standard".

---

## Technical Details

- **Protocol**: MCP 1.0
- **Language**: TypeScript
- **Runtime**: Node.js 18+
- **Dependencies**: @modelcontextprotocol/sdk
- **License**: AGPL-3.0

---

## Links

- [Full Specification](./SPECIFICATION.md)
- [Dossier Standard](../README.md)
- [Examples](../examples/)
- [Contributing Guidelines](./CONTRIBUTING.md)

---

## Status

**Current Phase**: MVP Complete ✅

**What's Working**:
- ✅ Security verification (checksum + signature)
- ✅ Dossier listing and reading
- ✅ MCP protocol integration
- ✅ Resource serving (protocol, security, concept)
- ✅ Structured logging and error handling
- ✅ **MCP Prompts** (execute-dossier, create-dossier)

**Next Steps**:
1. NPM package preparation
2. Advanced validation tool
3. Registry support
4. Publish to NPM

**Contributors Welcome!** This is a community-driven effort to make LLM automation truly accessible.

---

**Questions or ideas?** Open an issue or start a discussion!
