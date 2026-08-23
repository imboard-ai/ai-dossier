# Dossier Examples

This directory contains **minimal test fixtures** used by the project's test suite.

For a full collection of example dossiers — covering DevOps, databases, data science, security, development workflows, and more — browse the **[Dossier Registry](https://registry.dossier.dev)**.

## Contents

| Path | Purpose |
|------|---------|
| `test/hello-world.ds.md` | Minimal dossier for Ed25519 signature verification tests |
| `setup/scaffold-typescript-project.ds.md` | Scaffold a TypeScript project with CI, testing, linting |
| `guides/context-engineering-best-practices.ds.md` | Reference guide for writing effective AI agent context files |
| `validation/` | Standalone validation scripts (Node.js, Python) for checking dossiers against the JSON schema |
| `git/` | Snapshot of the `imboard-ai/git/*` issue-workflow family (`gate`, `setup`, `plan`, `implement`, `review`, `ship`, `report`, `full-cycle-issue`, `fleet-cycle`, `git-sync`, guide). The registry is the source of truth; these are copies of the latest published versions |
| `authoring/` | Example of creating a new dossier and its companion skill |

## Finding dossiers

```bash
# Search the public registry
dossier search deploy

# List all published dossiers
dossier list
```

Or browse the registry API directly at `https://registry.dossier.dev/api/dossiers`.
