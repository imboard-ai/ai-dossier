// Handler-level tests for the trace API routes.
// lib/traces is fully mocked so no DB is required.
// lib/auth is exercised end-to-end with a mocked jsonwebtoken + config.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockReq, createMockRes } from './helpers/mocks';

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: () => 'mock-token',
    verify: () => ({ sub: 'alice', email: null, orgs: [] }),
  },
}));

vi.mock('../lib/config', () => ({
  default: {
    auth: { jwt: { secret: 'test-secret' } },
  },
}));

vi.mock('../lib/traces', () => ({
  VALID_STATUSES: ['running', 'success', 'failed', 'cancelled'],
  createTrace: vi.fn(),
  getTrace: vi.fn(),
  listTraces: vi.fn(),
  updateTrace: vi.fn(),
  deleteTrace: vi.fn(),
  appendStep: vi.fn(),
  listSteps: vi.fn(),
}));

import traceIdHandler from '../api/v1/traces/[traceId]';
import stepsHandler from '../api/v1/traces/[traceId]/steps';
import tracesHandler from '../api/v1/traces/index';
import * as traces from '../lib/traces';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';
const OTHER_UUID = '99999999-8888-7777-6666-555555555555';
const OWNER = 'alice';

function authedHeaders(): Record<string, string> {
  return { authorization: 'Bearer test-token' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth gate (shared across routes)', () => {
  it('returns 401 MISSING_TOKEN when Authorization header is absent', async () => {
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(createMockReq({ method: 'POST', body: {} }) as never, res as never);
    expect(getStatus()).toBe(401);
    expect(getBody()).toMatchObject({ error: { code: 'MISSING_TOKEN' } });
  });

  it('returns 401 INVALID_TOKEN when the JWT verify throws', async () => {
    const jwt = await import('jsonwebtoken');
    const original = jwt.default.verify;
    (jwt.default.verify as unknown) = () => {
      const err = new Error('bad signature');
      err.name = 'JsonWebTokenError';
      throw err;
    };
    try {
      const { res, getStatus, getBody } = createMockRes();
      await tracesHandler(
        createMockReq({ method: 'POST', body: {}, headers: authedHeaders() }) as never,
        res as never
      );
      expect(getStatus()).toBe(401);
      expect(getBody()).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    } finally {
      (jwt.default.verify as unknown) = original;
    }
  });

  it('returns 401 TOKEN_EXPIRED when the JWT verify throws TokenExpiredError', async () => {
    const jwt = await import('jsonwebtoken');
    const original = jwt.default.verify;
    (jwt.default.verify as unknown) = () => {
      const err = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    };
    try {
      const { res, getStatus, getBody } = createMockRes();
      await tracesHandler(
        createMockReq({ method: 'POST', body: {}, headers: authedHeaders() }) as never,
        res as never
      );
      expect(getStatus()).toBe(401);
      expect(getBody()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
    } finally {
      (jwt.default.verify as unknown) = original;
    }
  });
});

// ---- POST /api/v1/traces ----

describe('POST /api/v1/traces', () => {
  const validBody = () => ({
    trace_id: VALID_UUID,
    dossier: { title: 'Setup React', version: '1.0.0' },
    started_at: '2026-05-12T10:00:00Z',
    status: 'running' as const,
  });

  it('rejects missing trace_id with 400 MISSING_FIELD', async () => {
    const body = validBody() as Partial<ReturnType<typeof validBody>>;
    delete body.trace_id;
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({ method: 'POST', body, headers: authedHeaders() }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({ error: { code: 'MISSING_FIELD' } });
  });

  it('rejects non-UUID trace_id with 400 INVALID_FIELD', async () => {
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({
        method: 'POST',
        body: { ...validBody(), trace_id: 'not-a-uuid' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({ error: { code: 'INVALID_FIELD' } });
  });

  it('rejects missing dossier.title with 400 MISSING_FIELD', async () => {
    const body = validBody() as { dossier: { title?: string; version: string } };
    body.dossier = { version: '1.0.0' };
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({ method: 'POST', body, headers: authedHeaders() }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect((getBody() as { error: { message: string } }).error.message).toMatch(/dossier\.title/);
  });

  it('rejects invalid status with 400 INVALID_FIELD', async () => {
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({
        method: 'POST',
        body: { ...validBody(), status: 'frobnicated' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect(getBody()).toMatchObject({ error: { code: 'INVALID_FIELD' } });
  });

  it('creates and returns 201 on the happy path', async () => {
    (traces.createTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: '1',
      traceId: VALID_UUID,
      createdAt: new Date('2026-05-12T10:00:01Z'),
    });
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({ method: 'POST', body: validBody(), headers: authedHeaders() }) as never,
      res as never
    );
    expect(getStatus()).toBe(201);
    expect(getBody()).toMatchObject({
      trace_id: VALID_UUID,
      url: `/api/v1/traces/${VALID_UUID}`,
    });
    expect(traces.createTrace).toHaveBeenCalledWith(
      OWNER,
      expect.any(Array),
      expect.objectContaining({ trace_id: VALID_UUID })
    );
  });

  it('maps Postgres unique-violation (23505) to 409 CONFLICT', async () => {
    (traces.createTrace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505' })
    );
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({ method: 'POST', body: validBody(), headers: authedHeaders() }) as never,
      res as never
    );
    expect(getStatus()).toBe(409);
    expect(getBody()).toMatchObject({ error: { code: 'CONFLICT' } });
  });
});

// ---- GET /api/v1/traces ----

describe('GET /api/v1/traces', () => {
  it('returns mapped traces and pagination', async () => {
    (traces.listTraces as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          trace_id: VALID_UUID,
          dossier_title: 'X',
          dossier_version: '1.0.0',
          agent_name: 'Claude',
          agent_version: '4.7',
          started_at: new Date('2026-05-12T10:00:00Z'),
          completed_at: null,
          status: 'running',
          duration_ms: null,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const { res, getStatus, getBody } = createMockRes();
    await tracesHandler(
      createMockReq({ method: 'GET', headers: authedHeaders() }) as never,
      res as never
    );
    expect(getStatus()).toBe(200);
    const body = getBody() as {
      traces: Array<{ dossier: unknown; agent: unknown }>;
      pagination: unknown;
    };
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].dossier).toEqual({ title: 'X', version: '1.0.0' });
    expect(body.traces[0].agent).toEqual({ name: 'Claude', version: '4.7' });
    expect(body.pagination).toEqual({ total: 1, limit: 50, offset: 0, next: null });
  });

  it('rejects invalid status filter with 400', async () => {
    const { res, getStatus } = createMockRes();
    await tracesHandler(
      createMockReq({
        method: 'GET',
        query: { status: 'bogus' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect(traces.listTraces).not.toHaveBeenCalled();
  });
});

// ---- GET / PATCH / DELETE /api/v1/traces/:traceId ----

describe('GET /api/v1/traces/:traceId', () => {
  it('rejects non-UUID path param with 400', async () => {
    const { res, getStatus } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'GET',
        query: { traceId: 'nope' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
  });

  it('returns 404 when trace not found / cross-owner', async () => {
    (traces.getTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { res, getStatus, getBody } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'GET',
        query: { traceId: OTHER_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(404);
    expect(getBody()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(traces.getTrace).toHaveBeenCalledWith(OWNER, OTHER_UUID, { org: undefined });
  });

  it('returns the full trace on happy path', async () => {
    const fullTrace = {
      trace_id: VALID_UUID,
      status: 'success',
      steps: [{ step_id: 's1', type: 'action' }],
    };
    (traces.getTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fullTrace);
    const { res, getStatus, getBody } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'GET',
        query: { traceId: VALID_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual(fullTrace);
  });
});

describe('PATCH /api/v1/traces/:traceId', () => {
  it('rejects invalid status with 400', async () => {
    const { res, getStatus } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'PATCH',
        query: { traceId: VALID_UUID },
        body: { status: 'frobnicated' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
  });

  it('returns 404 when trace missing', async () => {
    (traces.updateTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { res, getStatus } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'PATCH',
        query: { traceId: VALID_UUID },
        body: { status: 'success' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(404);
  });

  it('returns 200 on success and forwards owner + updates', async () => {
    (traces.updateTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    const { res, getStatus, getBody } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'PATCH',
        query: { traceId: VALID_UUID },
        body: { status: 'success', completed_at: '2026-05-12T10:01:00Z' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(200);
    expect(getBody()).toMatchObject({ trace_id: VALID_UUID });
    expect(traces.updateTrace).toHaveBeenCalledWith(
      OWNER,
      VALID_UUID,
      expect.objectContaining({ status: 'success' })
    );
  });
});

describe('DELETE /api/v1/traces/:traceId', () => {
  it('returns 404 when trace missing or owned by another user', async () => {
    (traces.deleteTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { res, getStatus } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'DELETE',
        query: { traceId: VALID_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(404);
  });

  it('returns 204 on success', async () => {
    (traces.deleteTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    const { res, getStatus } = createMockRes();
    await traceIdHandler(
      createMockReq({
        method: 'DELETE',
        query: { traceId: VALID_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(204);
  });
});

// ---- POST / GET /api/v1/traces/:traceId/steps ----

describe('POST /api/v1/traces/:traceId/steps', () => {
  it('rejects missing step_id with 400', async () => {
    const { res, getStatus, getBody } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'POST',
        query: { traceId: VALID_UUID },
        body: { type: 'action' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect((getBody() as { error: { message: string } }).error.message).toMatch(/step_id/);
  });

  it('rejects missing type with 400', async () => {
    const { res, getStatus, getBody } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'POST',
        query: { traceId: VALID_UUID },
        body: { step_id: 's1' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(400);
    expect((getBody() as { error: { message: string } }).error.message).toMatch(/type/);
  });

  it('returns 404 when trace missing / cross-owner', async () => {
    (traces.appendStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { res, getStatus } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'POST',
        query: { traceId: VALID_UUID },
        body: { step_id: 's1', type: 'action' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(404);
  });

  it('returns 201 with assigned step_number on success', async () => {
    (traces.appendStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ stepNumber: 7 });
    const { res, getStatus, getBody } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'POST',
        query: { traceId: VALID_UUID },
        body: { step_id: 's1', type: 'action' },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(201);
    expect(getBody()).toEqual({ trace_id: VALID_UUID, step_id: 's1', step_number: 7 });
    expect(traces.appendStep).toHaveBeenCalledWith(
      OWNER,
      VALID_UUID,
      expect.objectContaining({ step_id: 's1' })
    );
  });
});

describe('GET /api/v1/traces/:traceId/steps', () => {
  it('returns 404 when trace missing', async () => {
    (traces.listSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { res, getStatus } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'GET',
        query: { traceId: VALID_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(404);
  });

  it('returns step array on success', async () => {
    (traces.listSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { step_id: 's1' },
      { step_id: 's2' },
    ]);
    const { res, getStatus, getBody } = createMockRes();
    await stepsHandler(
      createMockReq({
        method: 'GET',
        query: { traceId: VALID_UUID },
        headers: authedHeaders(),
      }) as never,
      res as never
    );
    expect(getStatus()).toBe(200);
    expect((getBody() as { steps: unknown[] }).steps).toHaveLength(2);
  });
});

// ---- pure validation helper ----

describe('validateCreatePayload (pure)', () => {
  it('accepts a well-formed trace', async () => {
    const { validateCreatePayload } = await import('../api/v1/traces/index');
    const result = validateCreatePayload({
      trace_id: VALID_UUID,
      dossier: { title: 'X', version: '1.0.0' },
      started_at: '2026-05-12T10:00:00Z',
      status: 'running',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects null body', async () => {
    const { validateCreatePayload } = await import('../api/v1/traces/index');
    const result = validateCreatePayload(null);
    expect(result.ok).toBe(false);
  });
});

// ---- Org-scoped reads ----

describe('Org-scoped reads', () => {
  async function withOrgs<T>(orgs: string[], fn: () => Promise<T>): Promise<T> {
    const jwt = await import('jsonwebtoken');
    const original = jwt.default.verify;
    (jwt.default.verify as unknown) = () => ({ sub: OWNER, email: null, orgs });
    try {
      return await fn();
    } finally {
      (jwt.default.verify as unknown) = original;
    }
  }

  it('createTrace receives JWT orgs and writes them through', async () => {
    await withOrgs(['imboard-ai', 'other-org'], async () => {
      (traces.createTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: '1',
        traceId: VALID_UUID,
        createdAt: new Date('2026-05-13T10:00:01Z'),
      });
      const { res, getStatus } = createMockRes();
      await tracesHandler(
        createMockReq({
          method: 'POST',
          body: {
            trace_id: VALID_UUID,
            dossier: { title: 'X', version: '1.0.0' },
            started_at: '2026-05-13T10:00:00Z',
            status: 'running',
          },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(201);
      expect(traces.createTrace).toHaveBeenCalledWith(
        OWNER,
        ['imboard-ai', 'other-org'],
        expect.objectContaining({ trace_id: VALID_UUID })
      );
    });
  });

  it('GET /api/v1/traces?org=imboard-ai threads the org through listTraces', async () => {
    await withOrgs(['imboard-ai'], async () => {
      (traces.listTraces as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
      const { res, getStatus } = createMockRes();
      await tracesHandler(
        createMockReq({
          method: 'GET',
          query: { org: 'imboard-ai' },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(200);
      expect(traces.listTraces).toHaveBeenCalledWith(
        OWNER,
        expect.objectContaining({ org: 'imboard-ai' })
      );
    });
  });

  it('GET /api/v1/traces?org=X returns 403 when X is not in JWT orgs', async () => {
    await withOrgs(['imboard-ai'], async () => {
      const { res, getStatus, getBody } = createMockRes();
      await tracesHandler(
        createMockReq({
          method: 'GET',
          query: { org: 'other-org' },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(403);
      expect(getBody()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(traces.listTraces).not.toHaveBeenCalled();
    });
  });

  it('GET /api/v1/traces/:id?org=imboard-ai threads the org through getTrace', async () => {
    await withOrgs(['imboard-ai'], async () => {
      (traces.getTrace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        trace_id: VALID_UUID,
        status: 'success',
        steps: [],
      });
      const { res, getStatus } = createMockRes();
      await traceIdHandler(
        createMockReq({
          method: 'GET',
          query: { traceId: VALID_UUID, org: 'imboard-ai' },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(200);
      expect(traces.getTrace).toHaveBeenCalledWith(OWNER, VALID_UUID, { org: 'imboard-ai' });
    });
  });

  it('GET /api/v1/traces/:id?org=X returns 403 when X is not in JWT orgs', async () => {
    await withOrgs(['imboard-ai'], async () => {
      const { res, getStatus, getBody } = createMockRes();
      await traceIdHandler(
        createMockReq({
          method: 'GET',
          query: { traceId: VALID_UUID, org: 'other-org' },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(403);
      expect(getBody()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(traces.getTrace).not.toHaveBeenCalled();
    });
  });

  it('GET /api/v1/traces/:id/steps?org=X returns 403 when X is not in JWT orgs', async () => {
    await withOrgs(['imboard-ai'], async () => {
      const { res, getStatus, getBody } = createMockRes();
      await stepsHandler(
        createMockReq({
          method: 'GET',
          query: { traceId: VALID_UUID, org: 'other-org' },
          headers: authedHeaders(),
        }) as never,
        res as never
      );
      expect(getStatus()).toBe(403);
      expect(getBody()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(traces.listSteps).not.toHaveBeenCalled();
    });
  });
});
