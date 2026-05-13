// GET  /api/v1/traces - List the authenticated user's traces (with filters)
// POST /api/v1/traces - Create a new execution trace

import { authenticateRequest } from '../../../lib/auth';
import { HTTP_STATUS, MAX_CONTENT_SIZE } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import createLogger from '../../../lib/logger';
import {
  badRequest,
  getRequestId,
  jsonError,
  methodNotAllowed,
  serverError,
} from '../../../lib/responses';
import {
  createTrace,
  listTraces,
  type TraceInput,
  type TraceStatus,
  VALID_STATUSES,
} from '../../../lib/traces';
import type { JwtPayload, VercelRequest, VercelResponse } from '../../../lib/types';

const log = createLogger('traces/index');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  const payload = await authenticateRequest(req, res);
  if (!payload) return;

  if (req.method === 'GET') return handleList(req, res, payload, requestId);
  if (req.method === 'POST') return handleCreate(req, res, payload, requestId);

  return methodNotAllowed(req, res, 'GET', 'POST');
}

async function handleList(
  req: VercelRequest,
  res: VercelResponse,
  payload: JwtPayload,
  requestId: string
) {
  const q = req.query as Record<string, string | string[] | undefined>;
  const dossier = pickOne(q.dossier);
  const status = pickOne(q.status);
  const from = pickOne(q.from);
  const to = pickOne(q.to);
  const limit = pickOne(q.limit);
  const offset = pickOne(q.offset);
  const org = pickOne(q.org);

  if (status && !VALID_STATUSES.includes(status as TraceStatus)) {
    return badRequest(
      res,
      'INVALID_FIELD',
      `status must be one of: ${VALID_STATUSES.join(', ')}`,
      requestId
    );
  }

  if (org && !payload.orgs.includes(org)) {
    return jsonError(
      res,
      HTTP_STATUS.FORBIDDEN,
      'FORBIDDEN',
      `You are not a member of org '${org}'`,
      requestId
    );
  }

  try {
    const result = await listTraces(payload.sub, {
      dossier,
      status: status as TraceStatus | undefined,
      from,
      to,
      limit,
      offset,
      org,
    });
    const nextOffset = result.offset + result.limit;
    const hasMore = nextOffset < result.total;
    return res.status(HTTP_STATUS.OK).json({
      traces: result.rows.map((t) => ({
        trace_id: t.trace_id,
        dossier: { title: t.dossier_title, version: t.dossier_version },
        agent: t.agent_name ? { name: t.agent_name, version: t.agent_version } : undefined,
        started_at: toIso(t.started_at),
        completed_at: toIso(t.completed_at),
        status: t.status,
        duration_ms: t.duration_ms,
      })),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        next: hasMore ? `/api/v1/traces?offset=${nextOffset}&limit=${result.limit}` : null,
      },
    });
  } catch (err) {
    return serverError(res, {
      operation: 'trace.list',
      error: err,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to list traces',
      requestId,
    });
  }
}

export type CreateValidationSuccess = { ok: true; data: TraceInput };
export type CreateValidationFailure = { ok: false; code: string; message: string };
export type CreateValidationResult = CreateValidationSuccess | CreateValidationFailure;

/** Pure validation: returns a discriminated union instead of writing to `res`. */
export function validateCreatePayload(body: unknown): CreateValidationResult {
  const trace = body as Partial<TraceInput> | null | undefined;
  if (!trace || typeof trace !== 'object') {
    return { ok: false, code: 'MISSING_FIELD', message: 'Request body must be a JSON object' };
  }
  if (!trace.trace_id) {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: trace_id' };
  }
  if (typeof trace.trace_id !== 'string' || !UUID_RE.test(trace.trace_id)) {
    return { ok: false, code: 'INVALID_FIELD', message: 'trace_id must be a UUID' };
  }
  if (!trace.dossier || typeof trace.dossier !== 'object') {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: dossier' };
  }
  if (!trace.dossier.title) {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: dossier.title' };
  }
  if (!trace.dossier.version) {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: dossier.version' };
  }
  if (!trace.started_at) {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: started_at' };
  }
  if (Number.isNaN(Date.parse(trace.started_at))) {
    return { ok: false, code: 'INVALID_FIELD', message: 'started_at must be ISO-8601' };
  }
  if (!trace.status) {
    return { ok: false, code: 'MISSING_FIELD', message: 'Missing required field: status' };
  }
  if (!VALID_STATUSES.includes(trace.status as TraceStatus)) {
    return {
      ok: false,
      code: 'INVALID_FIELD',
      message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
    };
  }
  return { ok: true, data: trace as TraceInput };
}

async function handleCreate(
  req: VercelRequest,
  res: VercelResponse,
  payload: JwtPayload,
  requestId: string
) {
  const owner = payload.sub;
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_CONTENT_SIZE) {
    return jsonError(
      res,
      HTTP_STATUS.CONTENT_TOO_LARGE,
      'CONTENT_TOO_LARGE',
      `Body exceeds ${MAX_CONTENT_SIZE / 1024}KB`,
      requestId
    );
  }

  const validated = validateCreatePayload(req.body);
  if (!validated.ok) {
    return badRequest(res, validated.code, validated.message, requestId);
  }

  try {
    const result = await createTrace(owner, payload.orgs, validated.data);
    log.info('Trace created', { requestId, owner, traceId: result.traceId });
    return res.status(HTTP_STATUS.CREATED).json({
      trace_id: result.traceId,
      created_at: toIso(result.createdAt),
      url: `/api/v1/traces/${result.traceId}`,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return jsonError(res, 409, 'CONFLICT', 'Trace already exists', requestId);
    }
    return serverError(res, {
      operation: 'trace.create',
      error: err,
      code: 'CREATE_ERROR',
      message: 'Failed to create trace',
      requestId,
      context: { owner, traceId: validated.data.trace_id },
    });
  }
}

function pickOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
