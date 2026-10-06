# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) for significant architectural decisions in the Dossier project.

## What is an ADR?

An Architecture Decision Record captures an important architectural decision made along with its context and consequences.

## ADR Format

Each ADR follows this structure:

```markdown
# ADR-NNNN: Title

## Status
[Proposed | Accepted | Deprecated | Superseded by ADR-XXXX]

## Context
What is the issue that we're seeing that is motivating this decision or change?

## Decision
What is the change that we're proposing and/or doing?

## Consequences
What becomes easier or more difficult to do because of this change?
```

## Creating a New ADR

1. Copy the template: `cp ../../../rfcs/0000-template.md NNNN-your-decision.md`
2. Use the next available number (NNNN)
3. Write a descriptive title (use kebab-case)
4. Fill in all sections
5. Submit as part of your PR

## Index of ADRs

*No ADRs yet - this is a new addition to the project structure.*

Feature-scoped decision records live next to their feature's PRD instead, under
`docs/features/<feature>/decisions/`, for example
[zero-trust-full-cycle/decisions](../../features/zero-trust-full-cycle/decisions/).

## Examples of Good ADR Topics

- Choice of programming language or framework
- Database selection
- Authentication/authorization approach
- API design patterns
- Build and deployment strategies
- Cryptographic algorithms and key management

## Resources

- [ADR GitHub Organization](https://adr.github.io/)
- [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [Why Write ADRs](https://github.blog/2020-08-13-why-write-adrs/)
