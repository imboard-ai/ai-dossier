---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Issue Workflows Guide",
  "version": "1.1.0",
  "status": "Stable",
  "objective": "Reference guide for the issue workflow family — explains when to use each workflow, how they compose from shared sub-dossiers, and available flags",
  "category": [
    "documentation"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "guide",
    "reference"
  ],
  "risk_level": "low",
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "issue-workflows-guide",
  "checksum": {
    "algorithm": "sha256",
    "hash": "9cf43454feadb5dddca5b699ca7903bdbf1427487ea46573497217958ca97dac"
  }
}
---

# Issue Workflows Guide

Reference guide for the issue workflow family. The single-issue skills share the same sub-dossiers — improving any sub-dossier improves all workflows. `fleet-cycle` sits one level above and orchestrates many `full-cycle-issue` runs at once.

## Quick Reference

| Trigger phrase | Skill | What happens | When to use |
|---|---|---|---|
| `guided cycle issue 42` | `guided-cycle-issue` | Gate → setup → plan → **discuss** → implement → **[visual review]** → review → ship → rich report | Default for most issues. You want input on the plan or to review FE changes. |
| `full cycle issue 42` | `full-cycle-issue` | Gate → setup → plan → implement → review → ship → rich report (all autonomous) | Confident fire-and-forget. Simple/clear issues. |
| `start issue 42` | `start-issue` | Gate → setup → plan → **stop** | You want full manual control after planning. |
| `fleet cycle issues 1..9` | `fleet-cycle` | Resolve set → dependency DAG → wave plan → dispatch `full-cycle-issue` per issue across background agents (parallel where safe, serial where dependent) → aggregate report | A **list or range** of issues. Runs independent ones in parallel, dependent ones in order. |

## Single Issue vs. Fleet

The first three skills take **one** issue to a merged PR. `fleet-cycle` is the batch layer: give it `1,2,3` or `1..9`, and it builds a dependency-aware **wave plan** and dispatches a `full-cycle-issue` run per issue across background agents. It serializes issues that collide on files, blocks a failed issue's dependents, and presents the plan before auto-running. See `imboard-ai/git/fleet-cycle`.

## Flags

All three skills support:
- `--base <branch>`: Override the target branch (default: parsed from issue body `merges into \`<branch>\``, or `main`)

`guided-cycle-issue` also supports:
- `--review`: Force visual review checkpoint after implementation
- `--no-review`: Skip visual review (even if FE files were changed)

## How They Compose

```
                    gate-issue
                        │
                 setup-issue-workflow
                        │
                    plan-issue
                        │
            ┌───────────┼───────────┐
            │           │           │
       start-issue   guided     full-cycle
       (stops here)  (discuss)  (continues)
                        │           │
                 implement-issue ───┘
                        │
                 [visual review?]     ← guided only, auto-detect FE
                        │
                  review-issue
                        │
                   ship-issue
                        │
                  report-issue
```

## Sub-Dossier Reference

| Name | Registry Path | What it does | Used by |
|---|---|---|---|
| `gate-issue` | `imboard-ai/git/gate-issue` | Safety check: hard blocks (closed, decomposed, epic, deps), soft warnings, base branch extraction | all three |
| `setup-issue-workflow` | `imboard-ai/git/setup-issue-workflow` | Branch + worktree (pool or cold) + warmup + claim issue label | all three |
| `plan-issue` | `imboard-ai/git/plan-issue` | Read issue + comments + explore code → write rich `PLANNING-{N}-{slug}.md` | all three |
| `implement-issue` | `imboard-ai/git/implement-issue` | Implement per plan + test + lint auto-fix | guided, full-cycle |
| `review-issue` | `imboard-ai/git/review-issue` | 5 parallel review agents (DRY, Security, Supportability, Maintainability, Docs) + fix findings | guided, full-cycle |
| `ship-issue` | `imboard-ai/git/ship-issue` | Commit → push → PR → CI wait → merge → teardown | guided, full-cycle |
| `report-issue` | `imboard-ai/git/report-issue` | Rich summary: what changed, user implications, dev/ops implications → conversation + PR comment | guided, full-cycle |

## Shared Parameter: `base_branch`

All sub-dossiers receive a `base_branch` parameter. This enables epic sub-issues: an issue that merges into `epic/settings-redesign` instead of `main` will correctly branch from, test against, PR into, and merge into the epic branch.

- **Source**: Parsed from issue body (`merges into \`<branch>\``), or explicit `--base` flag
- **Default**: `main`
- **Flow**: gate extracts → setup branches from → plan explores on → implement tests against → ship PRs into → report mentions

## Visual Review Checkpoint (guided-cycle only)

After implementation, the guided-cycle skill checks if visual review is needed:
1. **Force flag** (`--review` / `--no-review`): always wins
2. **Auto-detect**: If any `.tsx`, `.jsx`, `.css`, `.scss`, `.vue`, `.svelte` files were changed → review required
3. At the checkpoint: agent presents changes, user iterates until satisfied

## Rich Report Format

The `report-issue` sub-dossier produces:
- **What Changed**: 1-3 sentence summary
- **User-Facing Implications**: new screens, changed behaviors, breaking changes
- **Dev/Ops Implications**: new env vars, commands, schema changes, dependencies
- **Review Results**: fixed findings, escalated issues, clean categories
- Posted to both conversation and PR comment
