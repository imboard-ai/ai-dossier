import { vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '../../lib/types';

type MockReqOverrides = Partial<{
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}>;

export function createMockReq(
  overrides: MockReqOverrides = {}
): Pick<VercelRequest, 'method' | 'query' | 'headers' | 'body'> {
  return {
    method: overrides.method ?? 'GET',
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
    body: overrides.body ?? undefined,
  };
}

export function createMockRes() {
  let statusCode = 0;
  let body: unknown = '';
  const headers: Record<string, string> = {};

  const chainable = {
    json: (b: unknown) => {
      body = b;
    },
    send: (b: string) => {
      body = b;
    },
    end: () => {},
  };

  const res: Pick<VercelResponse, 'status' | 'setHeader'> & {
    redirect: (url: string) => void;
  } = {
    status: (code: number) => {
      statusCode = code;
      return chainable;
    },
    setHeader: (key: string, value: string | number | readonly string[]) => {
      headers[key as string] = String(value);
      return res as VercelResponse;
    },
    redirect: () => {},
  };

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
    headers,
  };
}

type ViMockRes = VercelResponse & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

export function createViMockRes(): ViMockRes {
  const res = {} as ViMockRes;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}
