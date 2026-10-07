---
name: spec-twin
description: Fixture used by the spec-shape adapter tests
metadata:
  dossier.dossier_schema_version: 1.0.0
  dossier.title: Spec Twin
  dossier.version: 1.2.0
  dossier.protocol_version: '"1.0"'
  dossier.status: Stable
  dossier.objective: Exercise the spec-shape adapter
  dossier.risk_level: high
  dossier.requires_approval: 'true'
  dossier.risk_factors: '["modifies_files"]'
  dossier.destructive_operations: '[]'
  dossier.inputs: '{"optional":[{"default":3,"description":"How many","name":"count"}],"required":[]}'
  dossier.last_updated: '2026-10-07'
  dossier.custom_flag: '"true"'
  dossier.checksum: '{"algorithm":"sha256","hash":"08b7a0d22289a9550693ddf27b9e99274c1bbed5d57258173a7e9a8091eb5e3d"}'
---

# Spec Twin

## Objective

Exercise the spec-shape adapter: this body is shared verbatim by the legacy and
spec-shaped twins, so both must parse to the same logical frontmatter.

## Actions to Perform

1. Read the frontmatter.
2. Do nothing else.
