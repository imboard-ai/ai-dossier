# Reference Documentation

Technical specifications and reference material for the Dossier project.

## Core Specifications

- [Protocol](protocol.md) - The dossier file format and verification protocol
- [Schema](schema.md) - Dossier metadata schema and validation rules
- [Specification](specification.md) - Complete formal specification

## API & CLI Reference

- [CLI Reference](cli.md) *(coming soon)* - Command-line tool options and usage
- [API Reference](api.md) - `@ai-dossier/core` programmatic API documentation

## File Formats

- Dossier files (`.ds.md`) - Markdown with YAML frontmatter
- Working files (`.dsw.md`) - Mutable execution state
- Signature formats - Minisign and AWS KMS signatures

## Standards & Compliance

- Security standards
- Cryptographic requirements
- Version compatibility

## For Developers

- **Implementing a verifier**: See [Protocol](protocol.md)
- **Parsing dossiers**: Check the [Schema](schema.md)
- **Integration**: Review [Specification](specification.md)
