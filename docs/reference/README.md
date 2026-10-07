# Reference Documentation

Technical specifications and reference material for the Dossier project.

## Core Specifications

- [Protocol](protocol.md) - The dossier file format and verification protocol
- [Schema](schema.md) - Dossier metadata schema and validation rules
- [Specification](specification.md) - Complete formal specification
- [Spec-Shaped Dossiers and Signature v3](spec-shape.md) - The Agent Skills frontmatter layout, value encoding, signature schemes v1/v2/v3, migration

## API & CLI Reference

- [Core API Reference](core-api.md) - `@ai-dossier/core` library API documentation
- [Capability Manifest](capabilities.md) - `.dossier/automation/manifest.yaml` spec and the `cap` command
- [CLI Reference](../../cli/README.md) - Command-line tool options and usage

## File Formats

- Dossier files (`.ds.md`) - Markdown with frontmatter in the Agent Skills (spec) layout or the legacy JSON layout
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
