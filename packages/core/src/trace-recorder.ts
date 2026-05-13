// Trace recorder for dossier execution. Opt-in: returns a no-op recorder
// unless both DOSSIER_TRACE_URL and DOSSIER_TRACE_TOKEN (or the equivalent
// opts) are provided. Fire-and-forget: network failures are swallowed so
// tracing never breaks the agent run.

export const VALID_TRACE_STATUSES = ['running', 'success', 'failed', 'cancelled'] as const;
export type TraceStatus = (typeof VALID_TRACE_STATUSES)[number];

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
  [key: string]: unknown;
}

export interface StepInput {
  step_id: string;
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface TraceRecorderOptions {
  url?: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface TraceRecorder {
  readonly enabled: boolean;
  create(input: TraceInput): Promise<void>;
  appendStep(traceId: string, step: StepInput): Promise<void>;
  complete(traceId: string, update: TraceUpdate): Promise<void>;
}

export function createTraceRecorder(opts: TraceRecorderOptions = {}): TraceRecorder {
  const url = opts.url ?? process.env.DOSSIER_TRACE_URL ?? '';
  const token = opts.token ?? process.env.DOSSIER_TRACE_TOKEN ?? '';
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  if (!url || !token || !fetchImpl) {
    return {
      enabled: false,
      create: noop,
      appendStep: noop,
      complete: noop,
    };
  }

  const base = url.replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  const send = (method: string, path: string, body: unknown): Promise<void> =>
    Promise.resolve()
      .then(() =>
        fetchImpl(`${base}${path}`, {
          method,
          headers,
          body: JSON.stringify(body),
        })
      )
      .then(() => undefined)
      .catch(() => undefined);

  return {
    enabled: true,
    create: (input) => send('POST', '/api/v1/traces', input),
    appendStep: (traceId, step) =>
      send('POST', `/api/v1/traces/${encodeURIComponent(traceId)}/steps`, step),
    complete: (traceId, update) =>
      send('PATCH', `/api/v1/traces/${encodeURIComponent(traceId)}`, update),
  };
}

async function noop(): Promise<void> {}
