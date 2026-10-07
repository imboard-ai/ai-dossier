---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "spec-twin",
  "description": "Fixture used by the spec-shape adapter tests",
  "title": "Spec Twin",
  "version": "1.2.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Exercise the spec-shape adapter",
  "risk_level": "high",
  "requires_approval": true,
  "risk_factors": ["modifies_files"],
  "destructive_operations": [],
  "inputs": { "required": [], "optional": [{ "name": "count", "description": "How many", "default": 3 }] },
  "last_updated": "2026-10-07",
  "custom_flag": "true",
  "checksum": { "algorithm": "sha256", "hash": "08b7a0d22289a9550693ddf27b9e99274c1bbed5d57258173a7e9a8091eb5e3d" }
}
---

# Spec Twin

## Objective

Exercise the spec-shape adapter: this body is shared verbatim by the legacy and
spec-shaped twins, so both must parse to the same logical frontmatter.

## Actions to Perform

1. Read the frontmatter.
2. Do nothing else.
