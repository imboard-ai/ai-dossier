# Reference Documentation

Technical specifications and reference material for the Dossier project.

## Core Specifications

- [Protocol](protocol.md) - The dossier file format and verification protocol
- [Schema](schema.md) - Dossier metadata schema and validation rules
- [Specification](specification.md) - Complete formal specification

## API & CLI Reference

- [Core API Reference](core-api.md) - `@ai-dossier/core` library API documentation
- [Capability Manifest](capabilities.md) - `.dossier/automation/manifest.yaml` spec and the `cap` command
- [CLI Reference](../../cli/README.md) - Command-line tool options and usage

## File Formats

- Dossier files (`.ds.md`) - Markdown with JSON frontmatter
- Working files (`.dsw.md`) - Mutable execution state
- Signature formats - Ed25519 and AWS KMS signatures
- [Plan artifacts (`plan:v1`)](plan-artifact.md) - Canonical per-issue plan comments

## Standards & Compliance

- Security standards
- Cryptographic requirements
- Version compatibility

## For Developers

- **Implementing a verifier**: See [Protocol](protocol.md)
- **Parsing dossiers**: Check the [Schema](schema.md)
- **Integration**: Review [Specification](specification.md)
