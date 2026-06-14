# Dossier Documentation

Welcome to the Dossier project documentation. A dossier is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in. Think npm or Docker Hub, but for AI skills: signed, versioned, shareable.

## Quick Navigation

### 🚀 [Getting Started](getting-started/)
New to Dossier? Start here to learn how to install and use the tools.

### 📚 [Guides](guides/)
Task-oriented guides for common workflows like creating dossiers, signing them, and publishing packages.

### 🎓 [Tutorials](tutorials/)
Step-by-step learning experiences to help you master Dossier.

### 📖 [Reference](reference/)
Technical specifications, protocol documentation, schemas, and API references.

### 💡 [Explanation](explanation/)
Conceptual documentation that helps you understand how and why Dossier works the way it does.

### 🏗️ [Architecture](architecture/)
System architecture, design decisions, and architecture decision records (ADRs).

### 🤝 [Contributing](contributing/)
Developer documentation for contributors including development setup, workflows, and guidelines.

### 📋 [Planning](planning/)
Project roadmaps, planning documents, and development notes.

---

## What is Dossier?

A dossier is a skill that adds what a plain skill (like a Claude Code `SKILL.md`) lacks:
- **Trust** - SHA256 checksums + cryptographic signatures, verified before execution
- **Versioning** - semantic versions you can pin
- **Distribution** - a registry that makes skills discoverable and installable
- **Portability** - human-readable Markdown that runs on any LLM tool

A **trigger skill** bridges the two: a thin `SKILL.md` that invokes a versioned, signed dossier (`ai-dossier run <registry-path>`).

## Key Components

- **Protocol** - The dossier file format and verification standard
- **CLI** - Author, verify, publish, and run dossiers; the skill bridge (`install-skill` / `skill-export`)
- **MCP Server** - Model Context Protocol integration for AI agents
- **Core Library** - Shared verification and parsing logic

## Documentation Structure

This documentation follows the [Diataxis framework](https://diataxis.fr/):
- **Tutorials**: Learning-oriented lessons for beginners
- **How-to Guides**: Task-oriented recipes for specific problems
- **Reference**: Information-oriented technical descriptions
- **Explanation**: Understanding-oriented discussions of key topics

## Quick Links

- [Main README](../README.md)
- [Security Policy](../SECURITY.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Project Architecture](../ARCHITECTURE.md)
- [Changelog](../CHANGELOG.md)

## Get Help

- **Issues**: https://github.com/imboard-ai/ai-dossier/issues
- **Discussions**: https://github.com/imboard-ai/ai-dossier/discussions
- **Security**: security@imboard.ai

---

**License**: [AGPL-3.0](LICENSE) | **Maintained by**: Imboard AI
