# Execution Tracing

**Last Updated**: 2026-05-13
**Status**: Active — shipped in `@ai-dossier/core@1.3.3` / `@ai-dossier/mcp-server@1.3.3`

---

## 1. Purpose

When an AI agent runs a dossier on your behalf, the system can record what
happened — which steps fired, what their outputs were, how long they took,
whether they succeeded. That record is called an **execution trace**.

Tracing exists because dossiers are run on real environments by autonomous
agents, often unattended. Without traces you get:

- No way to debug a failed run after the fact ("it errored, but at which step?")
- No way to spot a regression ("v1.1 of the dossier started taking 4× longer")
- No team visibility ("did anyone in my org actually run the migration last week?")
- No audit trail for compliance ("show me every prod-touching dossier run
  in the last 90 days")

A trace turns each agent run into queryable data. You can list yours, share
them with your org, filter by status / dossier name / time range, and inspect
individual step outputs.

Tracing is **opt-in and fire-and-forget**:

- Off by default. Nothing is recorded unless you turn it on.
- Network failures never crash the agent — if the trace registry is down, the
  agent keeps running, the trace is just lost.

## 2. Architecture

### Data flow

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  Your machine                                                   │
  │                                                                 │
  │   ai-dossier run X         ┌──────────────┐                     │
  │      │                     │  Claude       │                    │
  │      ▼                     │  (or other    │                    │
  │   spawn ─────────────────> │   LLM via     │                    │
  │                            │   MCP)        │                    │
  │                            └──────┬───────┘                     │
  │                                   │ calls                       │
  │                                   ▼                             │
  │                            ┌──────────────┐                     │
  │                            │  mcp-server  │                     │
  │                            │  startJourney│                     │
  │                            │  stepComplete│                     │
  │                            └──────┬───────┘                     │
  │                                   │ emits via TraceRecorder     │
  └───────────────────────────────────┼─────────────────────────────┘
                                      ▼
                  ┌────────────────────────────────────────┐
                  │  Registry  /api/v1/traces              │
                  │  (POST create, append step, complete)  │
                  └──────────────────┬─────────────────────┘
                                     ▼
                  ┌────────────────────────────────────────┐
                  │  Neon Postgres                         │
                  │    traces (one row per journey)        │
                  │    trace_steps (one row per step)      │
                  └────────────────────────────────────────┘
```

### Components

| Component | What it does | Where it lives |
|---|---|---|
| **mcp-server** | Owns the journey state machine. Calls the recorder on every lifecycle event (start / step / complete / cancel). | `@ai-dossier/mcp-server` (npm) |
| **TraceRecorder** | Stateless HTTP client. POSTs trace events fire-and-forget. Returns a no-op recorder when not configured. | `@ai-dossier/core` (npm) — `createTraceRecorder` |
| **resolveTraceConfig** | Resolves the effective URL + token from a precedence stack. Lets users set things via env, project config, or user config — never has to know which MCP host you use. | `@ai-dossier/core` — `resolveTraceConfig` |
| **Registry trace API** | `POST /api/v1/traces`, `POST /api/v1/traces/:id/steps`, `PATCH /api/v1/traces/:id`, `DELETE /api/v1/traces/:id`, `GET ...?org=<name>` for team reads. | `registry/api/v1/traces/` |
| **CLI traces commands** | `ai-dossier traces list [--org N]`, `ai-dossier traces show <id>`. | `@ai-dossier/cli` |

### What a trace contains

Per journey, one `traces` row:

- `trace_id` (UUID — assigned by mcp-server, same as `journey_id`)
- `owner` (the JWT subject — who ran it)
- `orgs[]` (JWT orgs at write time — used for team-visible reads)
- `dossier.title` / `dossier.version` (which dossier ran)
- `agent.name` / `agent.host` (`mcp-server` + machine hostname — so two runs of
  the same dossier from different machines are distinguishable)
- `started_at` / `completed_at` / `duration_ms`
- `status` — `running | success | failed | cancelled`
- `data` (JSONB) — full payload as POSTed, for fields the schema doesn't pull
  into columns

Per step inside that journey, one `trace_steps` row:

- `step_id`, `step_number`, `timestamp`, `type`, `data` (JSONB outputs)

### Auth + visibility model

- **Writes** (create / append / update / delete): owner-scoped. The JWT subject
  must match the trace's owner.
- **Reads** (list / get / list-steps): owner-scoped by default. Pass
  `?org=<name>` to read traces from any owner in that org — but only if the
  requesting JWT has that org in its `orgs` claim.
- The registry returns **404** (not 403) on cross-owner reads when no `org` is
  supplied, to avoid leaking row existence.

### Config precedence (resolved by `mcp-server` at startup)

```
1. process.env.DOSSIER_TRACE_ENABLED / _URL / _TOKEN     (CI, deployment, shell)
2. .dossierrc.json walked up from cwd                     (per-project)
3. ~/.dossier/config.json `tracing` block                 (per-user)
4. Default registry + credentials store                   (logged-in fallback)
```

Tokens are **never written to config files** — they come from env or from
`~/.dossier/credentials.json` (managed by `ai-dossier login`). When you re-login,
the new token takes effect on the next mcp-server start with no config edits.

## 3. User Setup

### Quick path (recommended)

```bash
# 1. Make sure you're on a recent CLI
npm install -g @ai-dossier/cli@latest
ai-dossier --version   # >= 0.8.3

# 2. Log in to the registry that will receive your traces
ai-dossier login

# 3. Enable tracing via the published setup dossier
ai-dossier run imboard-ai/setup/setup-tracing

# 4. Restart your MCP host (Claude Desktop / Code) so mcp-server reloads
#    and picks up the new config.
```

That's it. From the next agent run onward, traces land in the registry.

### Inspecting your traces

```bash
# Your own runs
ai-dossier traces list

# Filter
ai-dossier traces list --status failed --dossier full-cycle-issue
ai-dossier traces list --from 2026-05-01 --to 2026-05-13

# Team / org runs (you must be a member of the org)
ai-dossier traces list --org imboard-ai

# Full detail of a single trace, including all steps and outputs
ai-dossier traces show <trace_id>

# Machine-readable
ai-dossier traces list --json
```

### Manual setup (no dossier)

If you don't want to run the setup dossier (e.g., in CI, or you prefer to edit
config by hand), set either env vars or a config file:

**Option A — env vars** (highest precedence; good for CI):

```bash
export DOSSIER_TRACE_ENABLED=true
export DOSSIER_TRACE_URL=https://dossier-registry.vercel.app
export DOSSIER_TRACE_TOKEN=<JWT from ~/.dossier/credentials.json>
```

Set these in the environment your MCP host launches `mcp-server` from. For
Claude Desktop / Code, that's typically the `env` block on the MCP server
entry in your host's settings file.

**Option B — user config file** (`~/.dossier/config.json`):

```json
{
  "tracing": {
    "enabled": true
  }
}
```

URL and token resolve automatically from your logged-in registry. To override
the URL only (token still from credentials store):

```json
{
  "tracing": {
    "enabled": true,
    "url": "https://obs.imboard.corp"
  }
}
```

**Option C — project-level** (`<repo-root>/.dossierrc.json`, checkable into
git so a team shares the same tracing target):

```json
{
  "tracing": {
    "enabled": true,
    "url": "https://obs.team.example.com"
  }
}
```

Project config wins over user config but loses to env vars.

### Disabling

```bash
# Quick disable (until restart of the MCP host)
export DOSSIER_TRACE_ENABLED=false

# Persistent disable
# Edit ~/.dossier/config.json and set tracing.enabled = false
```

## 4. Running Your Own Trace Database

The default registry is `https://dossier-registry.vercel.app` — fine for
individuals and small teams, but if your org wants traces to stay in your own
infrastructure (compliance, data residency, retention policy), you can run
your own. As long as your service implements the same REST contract, the
recorder will POST to it transparently.

### What you need to implement

The recorder makes three kinds of HTTP calls. Authenticate them however you
want (JWT, mTLS, internal mesh, etc.) — the recorder just forwards the
`Authorization: Bearer <token>` header it received.

#### `POST /api/v1/traces`

Create a new trace.

Request body:

```json
{
  "trace_id": "<uuid>",
  "dossier": { "title": "<string>", "version": "<string>" },
  "agent": { "name": "mcp-server", "host": "<hostname>" },
  "started_at": "<iso8601>",
  "status": "running"
}
```

Response: `201 Created` with `{ "trace_id": ..., "url": ... }`. Treat
duplicate `trace_id` as `409 CONFLICT`.

#### `POST /api/v1/traces/:trace_id/steps`

Append one step. Body:

```json
{
  "step_id": "<string>",
  "type": "completed",
  "timestamp": "<iso8601>",
  "dossier": "<dossier-name>",
  "index": 0,
  "outputs": { "...": "..." }
}
```

Response: `201` with `{ "step_number": <int> }`.

#### `PATCH /api/v1/traces/:trace_id`

Finalize the trace. Body:

```json
{
  "status": "success",
  "completed_at": "<iso8601>",
  "duration_ms": 12345
}
```

Response: `200` or `204`.

### Reference implementation

The official registry (`registry/`) is the reference implementation. Code
layout:

- `registry/api/v1/traces/index.ts` — list + create
- `registry/api/v1/traces/[traceId].ts` — get + update + delete
- `registry/api/v1/traces/[traceId]/steps.ts` — list steps + append step
- `registry/lib/traces.ts` — DB layer (owner-scoped writes, org-scoped reads)
- `registry/migrations/001_traces.sql` — schema
- `registry/migrations/002_traces_orgs.sql` — adds `orgs TEXT[]` column

Schema (Postgres):

```sql
CREATE TABLE traces (
  id              BIGSERIAL PRIMARY KEY,
  trace_id        UUID NOT NULL UNIQUE,
  owner           TEXT NOT NULL,
  orgs            TEXT[],
  dossier_title   TEXT NOT NULL,
  dossier_version TEXT NOT NULL,
  agent_name      TEXT,
  agent_version   TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('running','success','failed','cancelled')),
  data            JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX traces_owner_started_at_idx ON traces (owner, started_at DESC);
CREATE INDEX traces_orgs_idx              ON traces USING GIN (orgs);

CREATE TABLE trace_steps (
  id           BIGSERIAL PRIMARY KEY,
  trace_pk     BIGINT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  step_number  INTEGER NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL,
  type         TEXT NOT NULL,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trace_pk, step_number)
);
```

You don't have to use Postgres — any store that satisfies the contract works.
Some orgs proxy the recorder calls into Datadog / Loki / OpenSearch via a thin
adapter service.

### Pointing the recorder at your service

Once your service speaks the contract, configure the recorder to use it:

```bash
# Env (overrides everything):
DOSSIER_TRACE_URL=https://traces.imboard.corp
DOSSIER_TRACE_TOKEN=<your-corp-auth-token>
DOSSIER_TRACE_ENABLED=true

# Or per-project (.dossierrc.json) — checkable into git so a team shares it:
{
  "tracing": {
    "enabled": true,
    "url": "https://traces.imboard.corp"
  }
}
```

If your corp auth scheme isn't a JWT compatible with `ai-dossier login`, set
`DOSSIER_TRACE_TOKEN` from your own auth flow (e.g., a refresh script that
exchanges your corp SSO for a bearer token and writes it to env). The
recorder doesn't introspect the token — it just passes it through.

### What you give up by self-hosting

- **The CLI's `traces list` / `traces show` commands** only work against a
  service that implements the same **GET** contracts (`/api/v1/traces` list
  shape, single trace shape, `?org=` filter). If you've only implemented the
  write side, you'll need your own UI / query layer to read them.
- **Cross-registry queries** aren't a thing. The CLI reads from one registry
  at a time (via `--registry <name>`); if you split writes between the public
  registry and your private one, you'll see two separate views.

### What you don't give up

- All write-side features still work: `agent.host`, `orgs[]` ownership,
  fire-and-forget failure mode, OIDC-signed provenance attestation (npm
  publish side).
- The `setup-tracing` dossier can be forked to write to your custom URL by
  default — keeps the user-facing UX identical for your org's developers.
- You can still publish org-internal dossiers to the public registry and
  receive traces of those runs into your private logger. The two are
  independent.

---

## Related

- [Setup dossier source](../../examples/setup/setup-tracing.ds.md) — the
  published dossier that handles per-user setup
- [Registry trace API source](../../registry/api/v1/traces/) — reference
  implementation
- [Recorder source](../../packages/core/src/trace-recorder.ts) — the HTTP
  client and contract
- [Config resolver source](../../packages/core/src/trace-config.ts) — the
  precedence stack
