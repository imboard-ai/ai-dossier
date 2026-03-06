import { describe, expect, it, vi } from 'vitest';
import config from '../lib/config';

function createMockReq(method = 'GET', host = 'registry.example.com') {
  return { method, headers: { host } } as any;
}

function createMockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}

describe('docs handler', () => {
  it('should return 200 with API documentation', async () => {
    const { default: handler } = await import('../api/v1/docs');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.name).toBe('Dossier Registry API');
    expect(body.version).toBe(config.apiVersion);
    expect(body.baseUrl).toBe('https://registry.example.com');
  });

  it('should include all endpoint definitions', async () => {
    const { default: handler } = await import('../api/v1/docs');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    const body = res.json.mock.calls[0][0];
    const endpointKeys = Object.keys(body.endpoints);
    expect(endpointKeys).toContain('GET /api/v1/health');
    expect(endpointKeys).toContain('GET /api/v1/docs');
    expect(endpointKeys).toContain('GET /api/v1/me');
    expect(endpointKeys).toContain('GET /api/v1/dossiers');
    expect(endpointKeys).toContain('GET /api/v1/dossiers/{name}');
    expect(endpointKeys).toContain('GET /api/v1/search');
    expect(endpointKeys).toContain('GET /api/v1/dossiers/{name}/content');
    expect(endpointKeys).toContain('DELETE /api/v1/dossiers/{name}');
    expect(endpointKeys).toContain('POST /api/v1/dossiers');
    expect(endpointKeys).toHaveLength(9);
  });

  it('should include authentication, frontmatter, and namespaces sections', async () => {
    const { default: handler } = await import('../api/v1/docs');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.authentication).toBeDefined();
    expect(body.authentication.type).toBe('Bearer Token (JWT)');
    expect(body.frontmatter).toBeDefined();
    expect(body.frontmatter.required).toBeDefined();
    expect(body.namespaces).toBeDefined();
    expect(body.namespaces.rules).toHaveLength(2);
  });

  it('should return 405 for non-GET requests', async () => {
    const { default: handler } = await import('../api/v1/docs');
    const req = createMockReq('POST');
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('health handler', () => {
  it('should return 200 with health status using config.apiVersion', async () => {
    const { default: handler } = await import('../api/v1/health');
    const req = createMockReq();
    const res = createMockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('OK');
    expect(body.service).toBe('Dossier Registry API');
    expect(body.version).toBe(config.apiVersion);
  });
});
