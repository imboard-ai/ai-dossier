// GET    /api/v1/traces/:traceId - Get full trace (including steps)
// PATCH  /api/v1/traces/:traceId - Update trace (status, completion, etc.)
// DELETE /api/v1/traces/:traceId - Delete trace and its steps

import { authenticateRequest } from '../../../lib/auth';
import { HTTP_STATUS, MAX_CONTENT_SIZE } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import {
  badRequest,
  getRequestId,
  jsonError,
  methodNotAllowed,
  notFound,
  serverError,
} from '../../../lib/responses';
import {
  deleteTrace,
  getTrace,
  type TraceStatus,
  type TraceUpdate,
  updateTrace,
  VALID_STATUSES,
} from '../../../lib/traces';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  const traceId = pickOne(req.query.traceId);
  if (!traceId || !UUID_RE.test(traceId)) {
    return badRequest(res, 'INVALID_FIELD', 'traceId must be a UUID', requestId);
  }

  const payload = await authenticateRequest(req, res);
  if (!payload) return;
  const owner = payload.sub;

  if (req.method === 'GET') return handleGet(req, res, payload, traceId, requestId);
  if (req.method === 'PATCH') return handlePatch(req, res, owner, traceId, requestId);
  if (req.method === 'DELETE') return handleDelete(res, owner, traceId, requestId);

  return methodNotAllowed(req, res, 'GET', 'PATCH', 'DELETE');
}

async function handleGet(
  req: VercelRequest,
  res: VercelResponse,
  payload: { sub: string; orgs: string[] },
  traceId: string,
  requestId: string
) {
  const org = pickOne(req.query.org);
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
    const trace = await getTrace(payload.sub, traceId, { org });
    if (!trace) return notFound(res, 'NOT_FOUND', 'Trace not found', requestId);
    return res.status(HTTP_STATUS.OK).json(trace);
  } catch (err) {
    return serverError(res, {
      operation: 'trace.get',
      error: err,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to get trace',
      requestId,
      context: { owner: payload.sub, traceId },
    });
  }
}

async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  owner: string,
  traceId: string,
  requestId: string
) {
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

  const updates = (req.body || {}) as TraceUpdate;
  if (updates.status && !VALID_STATUSES.includes(updates.status as TraceStatus)) {
    return badRequest(
      res,
      'INVALID_FIELD',
      `status must be one of: ${VALID_STATUSES.join(', ')}`,
      requestId
    );
  }

  try {
    const updated = await updateTrace(owner, traceId, updates);
    if (!updated) return notFound(res, 'NOT_FOUND', 'Trace not found', requestId);
    return res.status(HTTP_STATUS.OK).json({
      trace_id: traceId,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return serverError(res, {
      operation: 'trace.update',
      error: err,
      code: 'UPDATE_ERROR',
      message: 'Failed to update trace',
      requestId,
      context: { owner, traceId },
    });
  }
}

async function handleDelete(
  res: VercelResponse,
  owner: string,
  traceId: string,
  requestId: string
) {
  try {
    const deleted = await deleteTrace(owner, traceId);
    if (!deleted) return notFound(res, 'NOT_FOUND', 'Trace not found', requestId);
    res.status(HTTP_STATUS.NO_CONTENT).end();
  } catch (err) {
    return serverError(res, {
      operation: 'trace.delete',
      error: err,
      code: 'DELETE_ERROR',
      message: 'Failed to delete trace',
      requestId,
      context: { owner, traceId },
    });
  }
}

function pickOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
