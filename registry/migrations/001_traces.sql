-- Dossier Tracing v1.0.0 schema
-- See trace-schema.json at the repo root for the JSON contract stored in traces.data
-- All rows are owner-scoped: every query must include WHERE owner = $1

CREATE TABLE IF NOT EXISTS traces (
  id              BIGSERIAL PRIMARY KEY,
  trace_id        UUID NOT NULL UNIQUE,
  owner           TEXT NOT NULL,

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

CREATE INDEX IF NOT EXISTS traces_owner_started_at_idx ON traces (owner, started_at DESC);
CREATE INDEX IF NOT EXISTS traces_owner_status_idx     ON traces (owner, status);
CREATE INDEX IF NOT EXISTS traces_owner_title_idx      ON traces (owner, dossier_title);

CREATE TABLE IF NOT EXISTS trace_steps (
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

CREATE INDEX IF NOT EXISTS trace_steps_trace_pk_step_number_idx
  ON trace_steps (trace_pk, step_number);
