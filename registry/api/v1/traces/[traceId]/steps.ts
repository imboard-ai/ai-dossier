// POST /api/v1/traces/:traceId/steps - Append a single execution step (real-time logging)
// GET  /api/v1/traces/:traceId/steps - List all steps for a trace

import { authenticateRequest } from '../../../../lib/auth';
import { HTTP_STATUS } from '../../../../lib/constants';
import { handleCors } from '../../../../lib/cors';
import {
  badRequest,
  getRequestId,
  jsonError,
  methodNotAllowed,
  notFound,
  serverError,
} from '../../../../lib/responses';
import { appendStep, listSteps, type StepInput } from '../../../../lib/traces';
import type { VercelRequest, VercelResponse } from '../../../../lib/types';

const MAX_STEP_SIZE = 256 * 1024;
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

  if (req.method === 'POST') return handleAppend(req, res, owner, traceId, requestId);
  if (req.method === 'GET') return handleList(req, res, payload, traceId, requestId);

  return methodNotAllowed(req, res, 'GET', 'POST');
}

async function handleAppend(
  req: VercelRequest,
  res: VercelResponse,
  owner: string,
  traceId: string,
  requestId: string
) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_STEP_SIZE) {
    return jsonError(
      res,
      HTTP_STATUS.CONTENT_TOO_LARGE,
      'CONTENT_TOO_LARGE',
      `Body exceeds ${MAX_STEP_SIZE / 1024}KB`,
      requestId
    );
  }
  const step = (req.body || {}) as Partial<StepInput>;
  if (!step.step_id) {
    return badRequest(res, 'MISSING_FIELD', 'Missing required field: step_id', requestId);
  }
  if (!step.type) {
    return badRequest(res, 'MISSING_FIELD', 'Missing required field: type', requestId);
  }

  try {
    const result = await appendStep(owner, traceId, step as StepInput);
    if (!result) return notFound(res, 'NOT_FOUND', 'Trace not found', requestId);
    return res.status(HTTP_STATUS.CREATED).json({
      trace_id: traceId,
      step_id: step.step_id,
      step_number: result.stepNumber,
    });
  } catch (err) {
    return serverError(res, {
      operation: 'trace.appendStep',
      error: err,
      code: 'APPEND_ERROR',
      message: 'Failed to append step',
      requestId,
      context: { owner, traceId },
    });
  }
}

async function handleList(
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
    const steps = await listSteps(payload.sub, traceId, { org });
    if (steps === null) return notFound(res, 'NOT_FOUND', 'Trace not found', requestId);
    return res.status(HTTP_STATUS.OK).json({ trace_id: traceId, steps });
  } catch (err) {
    return serverError(res, {
      operation: 'trace.listSteps',
      error: err,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to list steps',
      requestId,
      context: { owner: payload.sub, traceId },
    });
  }
}

function pickOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
