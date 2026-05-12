// Trace query helpers. Every function is owner-scoped: callers MUST pass the
// JWT subject as `owner` and never read rows where owner != JWT subject.
//
// The full trace blob (conforming to the Dossier execution trace schema
// authored on the schema-implementation branch) lives in traces.data (JSONB).
// The columns alongside it are extracted at write time for fast filtering and
// indexing.

import { sql } from './db';

export const VALID_STATUSES = ['running', 'success', 'failed', 'cancelled'] as const;
export type TraceStatus = (typeof VALID_STATUSES)[number];

export interface TraceInput {
  trace_id: string;
  dossier: { title: string; version: string; [key: string]: unknown };
  agent?: { name?: string; version?: string; [key: string]: unknown };
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  status: TraceStatus;
  [key: string]: unknown;
}

export interface TraceUpdate {
  status?: TraceStatus;
  completed_at?: string;
  duration_ms?: number;
  steps?: StepInput[];
  [key: string]: unknown;
}

export interface StepInput {
  step_id: string;
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface TraceListFilters {
  dossier?: string | null;
  status?: TraceStatus | null;
  from?: string | null;
  to?: string | null;
  limit?: string | number;
  offset?: string | number;
}

export interface TraceListRow {
  trace_id: string;
  dossier_title: string;
  dossier_version: string;
  agent_name: string | null;
  agent_version: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  status: TraceStatus;
  duration_ms: number | null;
}

export interface CreateResult {
  id: string;
  traceId: string;
  createdAt: Date | string;
}

export async function createTrace(owner: string, trace: TraceInput): Promise<CreateResult> {
  const startedAt = new Date(trace.started_at);
  const completedAt = trace.completed_at ? new Date(trace.completed_at) : null;
  const rows = (await sql`
    INSERT INTO traces (
      trace_id, owner,
      dossier_title, dossier_version, agent_name, agent_version,
      started_at, completed_at, duration_ms, status,
      data
    ) VALUES (
      ${trace.trace_id}, ${owner},
      ${trace.dossier.title}, ${trace.dossier.version},
      ${trace.agent?.name ?? null}, ${trace.agent?.version ?? null},
      ${startedAt}, ${completedAt}, ${trace.duration_ms ?? null}, ${trace.status},
      ${JSON.stringify(trace)}::jsonb
    )
    RETURNING id, trace_id, created_at
  `) as Array<{ id: string; trace_id: string; created_at: Date }>;
  const row = rows[0];
  return { id: row.id, traceId: row.trace_id, createdAt: row.created_at };
}

export async function getTrace(
  owner: string,
  traceId: string
): Promise<Record<string, unknown> | null> {
  const traces = (await sql`
    SELECT id, data
    FROM traces
    WHERE trace_id = ${traceId} AND owner = ${owner}
    LIMIT 1
  `) as Array<{ id: string; data: Record<string, unknown> }>;
  if (traces.length === 0) return null;

  const tracePk = traces[0].id;
  const steps = (await sql`
    SELECT data
    FROM trace_steps
    WHERE trace_pk = ${tracePk}
    ORDER BY step_number ASC
  `) as Array<{ data: Record<string, unknown> }>;

  return { ...traces[0].data, steps: steps.map((s) => s.data) };
}

export interface ListResult {
  rows: TraceListRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function listTraces(
  owner: string,
  filters: TraceListFilters = {}
): Promise<ListResult> {
  const { dossier = null, status = null, from = null, to = null } = filters;
  const limit = Math.min(Number.parseInt(String(filters.limit ?? '50'), 10) || 50, 200);
  const offset = Number.parseInt(String(filters.offset ?? '0'), 10) || 0;

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const rows = (await sql`
    SELECT trace_id, dossier_title, dossier_version, agent_name, agent_version,
           started_at, completed_at, status, duration_ms
    FROM traces
    WHERE owner = ${owner}
      AND (${dossier}::text  IS NULL OR dossier_title = ${dossier})
      AND (${status}::text   IS NULL OR status        = ${status})
      AND (${fromDate}::timestamptz IS NULL OR started_at >= ${fromDate})
      AND (${toDate}::timestamptz   IS NULL OR started_at <= ${toDate})
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as TraceListRow[];

  const countRows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM traces
    WHERE owner = ${owner}
      AND (${dossier}::text  IS NULL OR dossier_title = ${dossier})
      AND (${status}::text   IS NULL OR status        = ${status})
      AND (${fromDate}::timestamptz IS NULL OR started_at >= ${fromDate})
      AND (${toDate}::timestamptz   IS NULL OR started_at <= ${toDate})
  `) as Array<{ count: number }>;

  return { rows, total: countRows[0].count, limit, offset };
}

/**
 * Apply PATCH updates to a trace, scoped to owner.
 * Merges `updates` into traces.data (JSONB) and refreshes extracted columns.
 * Bulk-appended steps in `updates.steps` are written to trace_steps and stripped
 * from the merged data blob (steps are the source of truth in their own table).
 *
 * @returns false if no row matched (trace missing or wrong owner)
 */
export async function updateTrace(
  owner: string,
  traceId: string,
  updates: TraceUpdate
): Promise<boolean> {
  const existing = (await sql`
    SELECT id, data
    FROM traces
    WHERE trace_id = ${traceId} AND owner = ${owner}
    LIMIT 1
  `) as Array<{ id: string; data: Record<string, unknown> }>;
  if (existing.length === 0) return false;

  const tracePk = existing[0].id;
  const bulkSteps = Array.isArray(updates.steps) ? updates.steps : null;

  // Strip `steps` from the JSONB blob — steps are the source of truth in their own table.
  const { steps: _steps, ...dataUpdates } = updates;
  const mergedData = { ...existing[0].data, ...dataUpdates };

  const completedAt = updates.completed_at ? new Date(updates.completed_at) : null;
  await sql`
    UPDATE traces
    SET
      status       = COALESCE(${updates.status ?? null}, status),
      completed_at = COALESCE(${completedAt}, completed_at),
      duration_ms  = COALESCE(${updates.duration_ms ?? null}, duration_ms),
      data         = ${JSON.stringify(mergedData)}::jsonb,
      updated_at   = NOW()
    WHERE id = ${tracePk}
  `;

  if (bulkSteps && bulkSteps.length > 0) {
    const last = (await sql`
      SELECT COALESCE(MAX(step_number), 0)::int AS max
      FROM trace_steps
      WHERE trace_pk = ${tracePk}
    `) as Array<{ max: number }>;
    let next = last[0].max;
    for (const step of bulkSteps) {
      next += 1;
      const ts = step.timestamp ? new Date(step.timestamp) : new Date();
      await sql`
        INSERT INTO trace_steps (trace_pk, step_id, step_number, timestamp, type, data)
        VALUES (${tracePk}, ${step.step_id}, ${next}, ${ts}, ${step.type}, ${JSON.stringify(step)}::jsonb)
      `;
    }
  }

  return true;
}

export async function deleteTrace(owner: string, traceId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM traces
    WHERE trace_id = ${traceId} AND owner = ${owner}
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * @returns null if trace not found / not owned by `owner`
 */
export async function appendStep(
  owner: string,
  traceId: string,
  step: StepInput
): Promise<{ stepNumber: number } | null> {
  const traces = (await sql`
    SELECT id FROM traces
    WHERE trace_id = ${traceId} AND owner = ${owner}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (traces.length === 0) return null;
  const tracePk = traces[0].id;

  const last = (await sql`
    SELECT COALESCE(MAX(step_number), 0)::int AS max
    FROM trace_steps
    WHERE trace_pk = ${tracePk}
  `) as Array<{ max: number }>;
  const stepNumber = last[0].max + 1;
  const ts = step.timestamp ? new Date(step.timestamp) : new Date();

  await sql`
    INSERT INTO trace_steps (trace_pk, step_id, step_number, timestamp, type, data)
    VALUES (${tracePk}, ${step.step_id}, ${stepNumber}, ${ts}, ${step.type}, ${JSON.stringify(step)}::jsonb)
  `;

  return { stepNumber };
}

/**
 * @returns null if trace not found / not owned by `owner`
 */
export async function listSteps(
  owner: string,
  traceId: string
): Promise<Record<string, unknown>[] | null> {
  const traces = (await sql`
    SELECT id FROM traces
    WHERE trace_id = ${traceId} AND owner = ${owner}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (traces.length === 0) return null;
  const tracePk = traces[0].id;

  const rows = (await sql`
    SELECT data
    FROM trace_steps
    WHERE trace_pk = ${tracePk}
    ORDER BY step_number ASC
  `) as Array<{ data: Record<string, unknown> }>;
  return rows.map((r) => r.data);
}
