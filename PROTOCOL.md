# Dossier Execution Protocol

**Version**: 2.0
**Status**: Stable

---

## Overview

This protocol defines how to execute dossiers safely and effectively, including both single-dossier and multi-dossier journey execution.

---

## Single-Dossier Execution

Use this flow when a dossier has **no `relationships` fields** (or only `suggested` relationships):

1. **VERIFY** — Run `verify_dossier` to check integrity and signature
   - If verification fails → STOP and report the issue
   - If signature is untrusted → ask user whether to proceed

2. **READ** — Use `read_dossier` to get the dossier content

3. **EXECUTE** — Follow the dossier body instructions
   - Respect `risk_level` warnings
   - Ask for confirmation before destructive operations
   - Report progress as you complete each step

4. **REPORT** — Summarize what was accomplished

---

## Multi-Dossier Journey Execution

Use this flow when a dossier has **`relationships.preceded_by` or `relationships.followed_by`** entries with `condition: "required"`.

### Decision Tree

```
Does the dossier have relationships.preceded_by or followed_by (required)?
├── YES → Use journey execution (resolve_graph → verify_graph → start_journey → step_complete)
└── NO  → Use single-dossier execution (verify_dossier → read_dossier)
```

### Journey Flow

```
1. resolve_graph({ dossier: "path/to/entry.ds.md" })
   → Returns: { graph_id, plan: { phases, totalDossiers, conflicts } }

2. verify_graph({ graph_id })
   → Returns: { overall_recommendation, dossiers: [...], blockers }
   → If BLOCK → STOP, report integrity failure
   → If WARN  → Present warning to user, ask to proceed
   → If ALLOW → Continue

3. [Present journey plan to user]:
   "This will execute N steps: step1 → step2 → step3
    Overall risk: [risk_level]. Proceed?"

4. start_journey({ graph_id })
   → Returns: { journey_id, step: { index, dossier, body, context }, total_steps }

5. [Execute step body, collect outputs]
   step_complete({ journey_id, status: "completed", outputs: { key: "value" } })
   → If status: "running" → repeat step 5 with new step
   → If status: "completed" → journey done, show summary
   → If status: "failed"   → step failed, show summary

6. [On failure]: Diagnose the issue and decide whether to retry or cancel
   cancel_journey({ journey_id, reason: "..." })
```

### Output Mapping

When `step_complete` advances to the next step, it injects a `context` string containing outputs from all previous steps:

```
Available from previous steps: project_path=/tmp/myapp (from setup-project), deps_installed=true (from install-deps)
```

Use these values when executing the current step. They represent outputs declared in each dossier's `outputs` section.

### Checking Journey State

Use `get_journey_status({ journey_id })` at any point to inspect:
- `summary.status` — current journey status
- `steps` — per-step status (pending/running/completed/failed)
- `current_step` — index and dossier of the running step

---

## External Reference Handling

A dossier's checksum covers the body text (URLs are tamper-evident), but the **content at those URLs is NOT covered** by the signature or checksum. This means a signed dossier can reference external resources that bypass the trust chain.

### Frontmatter Fields

- **`content_scope`**: `"self-contained"` (no external fetches) or `"references-external"` (contains external URLs)
- **`external_references`**: Array declaring each external URL with `type`, `trust_level`, and `required` status

### Agent Behavior

| Scenario | Action |
|----------|--------|
| URL declared in `external_references` | Proceed — author has acknowledged the dependency |
| URL declared with `type: "script"` and `trust_level: "unknown"` | Require explicit user approval before fetching or executing |
| URL NOT declared in `external_references` | Warn user — URL is not in the trust chain |
| `content_scope` is `"self-contained"` but body has URLs | Treat as configuration error — warn and flag |
| `read_dossier` returns `security_notices` | Display notices to user before executing body |

### Detection

The linter rule `external-references-declared` (default severity: `error`) scans the body for URLs and cross-references them against declared `external_references`. Placeholder URLs (`example.com`, `localhost`, `${VAR}`) are automatically excluded. URLs from `tools_required[].install_url`, `homepage`, `repository`, and `authors[].url` are auto-exempt.

---

## Risk Level Handling

| Risk Level | Required Action |
|------------|-----------------|
| `low`      | Proceed directly |
| `medium`   | Inform user, proceed |
| `high`     | Explicit user confirmation required |
| `critical` | Strong warning + explicit confirmation |

For journeys, use the **aggregate risk** from `verify_graph` to determine the overall risk level before starting.

---

## Error Handling

| Situation | Action |
|-----------|--------|
| `verify_dossier` fails | Stop, report checksum/signature failure |
| `verify_graph` returns BLOCK | Stop, list blockers |
| `verify_graph` returns WARN | Inform user, ask to proceed |
| `step_complete` returns failed | Show summary, ask user to diagnose |
| `resolve_graph` returns cycle error | Report the cycle path, ask user to fix |
| Journey not found | Check journey_id is correct |
