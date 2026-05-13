import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTraceRecorder, type TraceInput } from '../trace-recorder';

const FIXED_TRACE: TraceInput = {
  trace_id: '00000000-0000-4000-8000-000000000001',
  dossier: { title: 'Test Dossier', version: '1.0.0' },
  started_at: '2026-05-13T10:00:00.000Z',
  status: 'running',
};

describe('createTraceRecorder', () => {
  const ORIG_URL = process.env.DOSSIER_TRACE_URL;
  const ORIG_TOKEN = process.env.DOSSIER_TRACE_TOKEN;

  beforeEach(() => {
    delete process.env.DOSSIER_TRACE_URL;
    delete process.env.DOSSIER_TRACE_TOKEN;
  });

  afterEach(() => {
    if (ORIG_URL === undefined) delete process.env.DOSSIER_TRACE_URL;
    else process.env.DOSSIER_TRACE_URL = ORIG_URL;
    if (ORIG_TOKEN === undefined) delete process.env.DOSSIER_TRACE_TOKEN;
    else process.env.DOSSIER_TRACE_TOKEN = ORIG_TOKEN;
  });

  describe('disabled (opt-in)', () => {
    it('returns disabled recorder when no url or token configured', async () => {
      const fetchSpy = vi.fn();
      const recorder = createTraceRecorder({ fetch: fetchSpy });

      expect(recorder.enabled).toBe(false);
      await recorder.create(FIXED_TRACE);
      await recorder.appendStep('id', { step_id: 's1', type: 'action' });
      await recorder.complete('id', { status: 'success' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is disabled when only url is provided', () => {
      const recorder = createTraceRecorder({ url: 'https://example.test', fetch: vi.fn() });
      expect(recorder.enabled).toBe(false);
    });

    it('is disabled when only token is provided', () => {
      const recorder = createTraceRecorder({ token: 'abc', fetch: vi.fn() });
      expect(recorder.enabled).toBe(false);
    });

    it('falls back to env vars when opts are missing', () => {
      process.env.DOSSIER_TRACE_URL = 'https://example.test';
      process.env.DOSSIER_TRACE_TOKEN = 'env-token';
      const recorder = createTraceRecorder({ fetch: vi.fn() });
      expect(recorder.enabled).toBe(true);
    });
  });

  describe('enabled requests', () => {
    const url = 'https://registry.test';
    const token = 'jwt-token';

    function makeRecorder(fetchImpl: ReturnType<typeof vi.fn>) {
      return createTraceRecorder({ url, token, fetch: fetchImpl });
    }

    it('POSTs create to /api/v1/traces with bearer auth and JSON body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      const recorder = makeRecorder(fetchSpy);

      await recorder.create(FIXED_TRACE);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe('https://registry.test/api/v1/traces');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'content-type': 'application/json',
        authorization: 'Bearer jwt-token',
      });
      expect(JSON.parse(init.body)).toEqual(FIXED_TRACE);
    });

    it('POSTs appendStep to /api/v1/traces/:id/steps with the step body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      const recorder = makeRecorder(fetchSpy);

      await recorder.appendStep('trace-abc', {
        step_id: 's1',
        type: 'action',
        timestamp: '2026-05-13T10:00:01.000Z',
      });

      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe('https://registry.test/api/v1/traces/trace-abc/steps');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        step_id: 's1',
        type: 'action',
        timestamp: '2026-05-13T10:00:01.000Z',
      });
    });

    it('PATCHes complete to /api/v1/traces/:id', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const recorder = makeRecorder(fetchSpy);

      await recorder.complete('trace-abc', {
        status: 'success',
        completed_at: '2026-05-13T10:01:00.000Z',
        duration_ms: 60000,
      });

      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe('https://registry.test/api/v1/traces/trace-abc');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({
        status: 'success',
        completed_at: '2026-05-13T10:01:00.000Z',
        duration_ms: 60000,
      });
    });

    it('URL-encodes the trace id', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const recorder = makeRecorder(fetchSpy);

      await recorder.appendStep('weird/id with spaces', { step_id: 's1', type: 'action' });

      const [calledUrl] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe(
        'https://registry.test/api/v1/traces/weird%2Fid%20with%20spaces/steps'
      );
    });

    it('strips trailing slashes from the configured url', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      const recorder = createTraceRecorder({
        url: 'https://registry.test///',
        token,
        fetch: fetchSpy,
      });

      await recorder.create(FIXED_TRACE);
      const [calledUrl] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe('https://registry.test/api/v1/traces');
    });
  });

  describe('fire-and-forget failure handling', () => {
    const url = 'https://registry.test';
    const token = 'jwt-token';

    it('does not throw when fetch rejects (network error)', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const recorder = createTraceRecorder({ url, token, fetch: fetchSpy });

      await expect(recorder.create(FIXED_TRACE)).resolves.toBeUndefined();
      await expect(
        recorder.appendStep('id', { step_id: 's1', type: 'action' })
      ).resolves.toBeUndefined();
      await expect(recorder.complete('id', { status: 'failed' })).resolves.toBeUndefined();
    });

    it('does not throw when fetch resolves with non-2xx (server error)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{"error":"boom"}', { status: 500 }));
      const recorder = createTraceRecorder({ url, token, fetch: fetchSpy });

      await expect(recorder.create(FIXED_TRACE)).resolves.toBeUndefined();
    });

    it('does not throw when fetch throws synchronously', async () => {
      const fetchSpy = vi.fn(() => {
        throw new Error('sync boom');
      });
      const recorder = createTraceRecorder({ url, token, fetch: fetchSpy });

      await expect(recorder.create(FIXED_TRACE)).resolves.toBeUndefined();
    });
  });
});
