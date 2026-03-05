# Dossier Orchestration Reference

**Version**: 1.0
**Status**: Stable

This document is a complete reference for the MCP orchestration tools that enable multi-dossier journey execution.

---

## Tool Reference

### `resolve_graph`

Resolves a dossier's dependency graph into an ordered execution plan. Reads `relationships` fields and builds a DAG with topological ordering.

**Input:**
```json
{ "dossier": "path/to/entry.ds.md" }
```
or
```json
{ "dossier": "registry-org/registry-name" }
```

**Output (success):**
```json
{
  "graph_id": "abc123",
  "plan": {
    "entryDossier": "setup-project",
    "totalDossiers": 3,
    "phases": [
      {
        "phase": 1,
        "dossiers": [{ "name": "setup-project", "source": "local", "condition": "required" }]
      },
      {
        "phase": 2,
        "dossiers": [{ "name": "install-deps", "source": "local", "condition": "required" }]
      }
    ],
    "conflicts": [],
    "warnings": []
  }
}
```

**Output (error):**
```json
{
  "error": {
    "type": "cycle",
    "message": "Dependency cycle detected: a -> b -> a",
    "cycle": ["a", "b", "a"]
  }
}
```

Error types: `cycle` | `resolve` | `unknown`

---

### `verify_graph`

Batch-verifies all dossiers in a resolved graph. Can also resolve + verify in one call.

**Input (from stored graph):**
```json
{ "graph_id": "abc123" }
```

**Input (inline resolve + verify):**
```json
{ "dossier": "path/to/entry.ds.md" }
```

**Output:**
```json
{
  "overall_recommendation": "ALLOW",
  "summary": "3 dossiers verified: 3 passed, 0 blocked",
  "dossiers": [
    {
      "name": "setup-project",
      "passed": true,
      "recommendation": "ALLOW",
      "stages": [
        { "stage": 1, "name": "Integrity Check", "passed": true },
        { "stage": 2, "name": "Authenticity Check", "passed": true }
      ]
    }
  ],
  "blockers": []
}
```

**Recommendations:** `ALLOW` | `WARN` | `BLOCK`
- `ALLOW` — all verifications passed, low risk
- `WARN` — unsigned dossiers or high-risk operations (user should review)
- `BLOCK` — integrity failure, do not execute

---

### `start_journey`

Creates a journey session and returns the first step's content.

**Input:**
```json
{ "graph_id": "abc123" }
```

**Output:**
```json
{
  "journey_id": "journey-uuid",
  "total_steps": 3,
  "step": {
    "index": 0,
    "dossier": "setup-project",
    "body": "# Setup Project\n\n## Steps\n...",
    "context": ""
  }
}
```

The `body` contains the dossier's instruction markdown. Execute these instructions, then call `step_complete`.

---

### `step_complete`

Marks the current step as complete or failed, advances to the next step.

**Input:**
```json
{
  "journey_id": "journey-uuid",
  "status": "completed",
  "outputs": { "project_path": "/tmp/myapp" }
}
```

**Output (more steps):**
```json
{
  "status": "running",
  "step": {
    "index": 1,
    "dossier": "install-deps",
    "body": "# Install Dependencies\n...",
    "context": "Available from previous steps: project_path=/tmp/myapp (from setup-project)"
  }
}
```

**Output (journey complete):**
```json
{
  "status": "completed",
  "summary": {
    "journey_id": "journey-uuid",
    "status": "completed",
    "total_steps": 3,
    "completed_steps": 3,
    "failed_steps": 0,
    "outputs": { "setup-project": { "project_path": "/tmp/myapp" } },
    "started_at": "2026-01-01T00:00:00.000Z",
    "completed_at": "2026-01-01T00:05:00.000Z"
  }
}
```

**Output (step failed):**
```json
{
  "status": "failed",
  "summary": { ... }
}
```

**`status` values:** `completed` | `failed`

---

### `get_journey_status`

Returns the current state of a journey without advancing it.

**Input:**
```json
{ "journey_id": "journey-uuid" }
```

**Output:**
```json
{
  "summary": {
    "journey_id": "journey-uuid",
    "status": "running",
    "total_steps": 3,
    "completed_steps": 1,
    "failed_steps": 0,
    "outputs": {}
  },
  "current_step": {
    "index": 1,
    "dossier": "install-deps",
    "status": "running",
    "context": "Available from previous steps: project_path=/tmp/myapp (from setup-project)"
  },
  "steps": [
    { "index": 0, "dossier": "setup-project", "status": "completed" },
    { "index": 1, "dossier": "install-deps", "status": "running" },
    { "index": 2, "dossier": "run-tests", "status": "pending" }
  ]
}
```

---

### `cancel_journey`

Cancels an active journey and returns a summary of what completed.

**Input:**
```json
{
  "journey_id": "journey-uuid",
  "reason": "User requested cancellation"
}
```

**Output:**
```json
{
  "summary": {
    "journey_id": "journey-uuid",
    "status": "cancelled",
    "total_steps": 3,
    "completed_steps": 1,
    "failed_steps": 0,
    "cancel_reason": "User requested cancellation"
  }
}
```

---

## Example Interaction Sequences

### Happy Path (3-step journey)

```
LLM: resolve_graph({ dossier: "examples/journey/setup-project.ds.md" })
MCP: { graph_id: "g1", plan: { totalDossiers: 3, phases: [...] } }

LLM: verify_graph({ graph_id: "g1" })
MCP: { overall_recommendation: "ALLOW", ... }

LLM: [shows user: "3-step journey, all ALLOW. Proceed?"]

LLM: start_journey({ graph_id: "g1" })
MCP: { journey_id: "j1", step: { index: 0, dossier: "setup-project", body: "..." } }

LLM: [executes step 0 body]
LLM: step_complete({ journey_id: "j1", status: "completed", outputs: { project_path: "/tmp/app" } })
MCP: { status: "running", step: { index: 1, dossier: "install-deps", context: "project_path=/tmp/app..." } }

LLM: [executes step 1 body using context]
LLM: step_complete({ journey_id: "j1", status: "completed", outputs: { deps_installed: true } })
MCP: { status: "running", step: { index: 2, dossier: "run-tests", context: "..." } }

LLM: [executes step 2 body]
LLM: step_complete({ journey_id: "j1", status: "completed" })
MCP: { status: "completed", summary: { completed_steps: 3, failed_steps: 0 } }
```

### Mid-Journey Cancellation

```
LLM: start_journey({ graph_id: "g1" })
MCP: { journey_id: "j1", step: { index: 0, ... } }

LLM: step_complete({ journey_id: "j1", status: "completed" })
MCP: { status: "running", step: { index: 1, ... } }

LLM: [user asks to stop]
LLM: cancel_journey({ journey_id: "j1", reason: "User cancelled" })
MCP: { summary: { status: "cancelled", completed_steps: 1 } }
```

---

## Error States and Recovery

| Error | Cause | Recovery |
|-------|-------|----------|
| `resolve error: cycle detected` | Circular `preceded_by` chain | Fix the dossier relationships |
| `verify_graph: BLOCK` | Checksum mismatch | Re-download or re-sign the dossier |
| `verify_graph: WARN` | Unsigned dossiers | Review content manually, confirm with user |
| `start_journey: not_found` | `graph_id` expired | Call `resolve_graph` again |
| `step_complete: invalid_state` | Journey already finished | Use `get_journey_status` to check |
| `step_complete: not_found` | Wrong `journey_id` | Use `get_journey_status` to confirm |
| Step fails during execution | Runtime error in step | Call `step_complete` with `status: "failed"` |
