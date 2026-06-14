# Explanation & Concepts

Understanding-oriented documentation that explains how and why Dossier works. A dossier is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in; these docs explain what that adds and why it matters.

## Core Concepts

- [Isn't a dossier just a skill?](faq.md#isnt-a-dossier-just-a-skill) - How dossiers relate to skills, and the trigger-skill pattern
- [Security Model](security-model.md) - Understanding Dossier's security approach
- [FAQ](faq.md) - Frequently asked questions

## Key Topics

### Security & Trust
- Why cryptographic verification matters
- Checksum vs. signature verification
- Trust models and key management
- Threat mitigation strategies

### Architecture & Design
- Why Markdown for automation
- The role of frontmatter metadata
- Immutable vs. mutable state
- Design philosophy and principles

### Use Cases
- DevOps automation
- Data science workflows
- Security auditing
- Documentation as code

## Philosophy

Dossier takes a skill and adds what makes it safe to share:
- **Trust**: cryptographic signatures + checksums, verified before execution
- **Versioning**: semantic versions you can pin and upgrade deliberately
- **Distribution**: a registry that makes skills discoverable and installable
- **Portability**: human-readable Markdown that runs on any LLM tool — vendor-neutral
- **Open standard**: community-driven, no heavy infrastructure

## Related Reading

- [Protocol Reference](../reference/protocol.md) - Technical details
- [Architecture Overview](../architecture/README.md) - System design
- [Security Documentation](../../security/) - In-depth security analysis
