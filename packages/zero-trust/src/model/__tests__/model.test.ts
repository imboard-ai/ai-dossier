import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger, observeModelBudget } from '../../budget';
import type { BudgetRate } from '../../budget-types';
import {
  MAX_TOOL_ARGUMENT_BYTES,
  ModelError,
  type ModelRequest,
  type ModelResult,
  modelRequestBody,
  snapshotModelRequest,
} from '../adapter';
import { BudgetExhaustedError, meteredComplete } from '../metered';
import { OpenAICompatibleAdapter } from '../openai-compatible';
import { ScriptedModel } from './scripted-model';

const KEY = 'recognizable-controller-only-key-1094';
const request: ModelRequest = {
  system: 'Trusted system',
  messages: [{ role: 'user', content: 'data, not instructions: héllo' }],
  tools: [{ type: 'function', function: { name: 'worker_exec', parameters: { type: 'object' } } }],
  maxOutputTokens: 100,
  timeoutMs: 1000,
};
const rates: BudgetRate[] = [
  {
    resource: 'model-a',
    currency: 'USD',
    unit: 'token',
    price: 2,
    units: 1,
    source: 'fixture',
    fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: '2026-10-07T00:00:00Z' },
  },
];
const textResult: ModelResult = {
  kind: 'text',
  text: 'done',
  usage: { inputTokens: 10, outputTokens: 2 },
};
const recorded = (
  message: unknown = { content: 'done' },
  finish_reason = 'stop',
  usage: unknown = { prompt_tokens: 10, completion_tokens: 2 }
) => ({ choices: [{ message, finish_reason }], usage });
const tool = (args: string = '{"command":"test"}', name = 'worker_exec', id = 'call-1') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const response = (raw: unknown) => new Response(JSON.stringify(raw));
function adapter(fetcher: typeof fetch) {
  return new OpenAICompatibleAdapter({
    model: 'model-a',
    endpoint: 'https://provider.example/v1/',
    apiKeyEnv: 'MODEL_TEST_KEY',
    fetch: fetcher,
  });
}
let directory: string;
function ledger(tokenLimit = 100_000, timeLimitMs = 100_000, prices = rates, ceiling = 1_000_000) {
  const store = new BudgetLedger(path.join(directory, 'budget.json'), 'contribution');
  store.initialize(['model-a'], prices);
  store.startSession({
    id: 's1',
    ceiling: { currency: 'USD', minor: ceiling },
    cleanupAllowance: 0,
    tokenLimit,
    timeLimitMs,
  });
  return store;
}
beforeEach(() => {
  vi.stubEnv('MODEL_TEST_KEY', KEY);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-test-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('OpenAI-compatible untrusted responses and transport', () => {
  it.each([
    null,
    [],
  ])('accepts an empty optional call list for a text-only completion %#', async (tool_calls) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(recorded({ content: 'done', tool_calls })));
    expect(await adapter(fetcher).complete({ ...request, tools: [] })).toEqual(textResult);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('tools');
  });
  it.each([
    ' ',
    '\r',
    '\n',
    '\t',
    '\u0001',
  ])('refuses padded/control-bearing key before any fetch %#', async (suffix) => {
    vi.stubEnv('MODEL_TEST_KEY', KEY + suffix);
    const fetcher = vi.fn<typeof fetch>();
    expect(() => adapter(fetcher)).toThrow('model_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'https://provider.example/v1?',
    'https://provider.example/v1#',
  ])('refuses empty query/fragment delimiter %s', (endpoint) => {
    expect(
      () =>
        new OpenAICompatibleAdapter({
          model: 'model-a',
          endpoint,
          apiKeyEnv: 'MODEL_TEST_KEY',
          fetch: vi.fn<typeof fetch>(),
        })
    ).toThrow('invalid_request');
  });
  it('grants each authorized retry its own deadline, including abortable backoff', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((done) => setTimeout(done, 70));
      return fetcher.mock.calls.length === 1
        ? new Response('', { status: 503 })
        : response(recorded());
    });
    expect(
      (
        await meteredComplete(adapter(fetcher), ledger(), 's1', rates, {
          ...request,
          timeoutMs: 160,
          attempts: 2,
        })
      ).kind
    ).toBe('text');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    '0',
    'not-a-date',
    'Wed, 07 Oct 2020 00:00:00 GMT',
  ])('bounds Retry-After header %#', async (header) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': header } }))
      .mockResolvedValueOnce(response(recorded()));
    expect((await adapter(fetcher).complete({ ...request, attempts: 2 })).kind).toBe('text');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('excessive Retry-After refuses retry and caller cancellation stops backoff', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '999' } }));
    await expect(adapter(fetcher).complete({ ...request, attempts: 2 })).rejects.toMatchObject({
      code: 'model_http',
      status: 429,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const backoffFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 503, headers: { 'Retry-After': '0.2' } }));
    const completion = adapter(backoffFetch).complete({
      ...request,
      signal: controller.signal,
      attempts: 2,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(completion).rejects.toMatchObject({ code: 'model_aborted' });
    expect(backoffFetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry a late error after timeout even when the injected fetch ignores abort', async () => {
    const keepAlive = setInterval(() => {}, 1000);
    try {
      let resolve: (value: Response) => void = () => {};
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          })
      );
      await expect(
        adapter(fetcher).complete({ ...request, attempts: 2, timeoutMs: 20 })
      ).rejects.toMatchObject({ code: 'model_timeout' });
      resolve(new Response(KEY, { status: 500 }));
      await new Promise((done) => setTimeout(done, 20));
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(keepAlive);
    }
  });
  it('rejects double-encoded key in tool arguments and sanitizes stream errors', async () => {
    const args = JSON.stringify({ value: KEY }).replace('recognizable', '\\u0072ecognizable');
    const result = await adapter(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(recorded({ tool_calls: [tool(args)] }, 'tool_calls')))
    ).complete(request);
    expect(result).toMatchObject({
      kind: 'malformed',
      reason: 'secret_detected',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error(KEY));
      },
    });
    await expect(
      adapter(vi.fn<typeof fetch>().mockResolvedValue(new Response(broken))).complete(request)
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });
  it('sends exact closed tools/output cap, no stream/redirects and call-time key only in header', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(recorded({ tool_calls: [tool()] }, 'tool_calls')));
    const model = adapter(fetcher);
    vi.stubEnv('MODEL_TEST_KEY', 'rotated-key-value');
    const result = await model.complete(request);
    expect(result).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'call-1', name: 'worker_exec', arguments: { command: 'test' } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer rotated-key-value',
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      tools: request.tools,
      max_tokens: 100,
      stream: false,
    });
    expect(JSON.stringify({ model, result, body: init.body })).not.toContain('rotated-key-value');
  });
  it('accepts text-only and a 64 KiB argument exactly', async () => {
    expect(
      await adapter(vi.fn<typeof fetch>().mockResolvedValue(response(recorded()))).complete({
        ...request,
        tools: [],
      })
    ).toEqual(textResult);
    const args = JSON.stringify('a'.repeat(MAX_TOOL_ARGUMENT_BYTES - 2));
    expect(
      (
        await adapter(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(response(recorded({ tool_calls: [tool(args)] }, 'tool_calls')))
        ).complete(request)
      ).kind
    ).toBe('tool_calls');
  });
  it.each([
    null,
    [],
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: null }] },
    recorded({ content: 'partial' }, 'length'),
    recorded({ content: 2 }),
    recorded({ tool_calls: [] }, 'tool_calls'),
    recorded({ tool_calls: [null] }, 'tool_calls'),
    recorded({ tool_calls: [tool('{bad')] }, 'tool_calls'),
    recorded({ tool_calls: [tool('{}', 'shell')] }, 'tool_calls'),
    recorded({ tool_calls: [tool('{}', 'worker_exec', '')] }, 'tool_calls'),
    recorded({ tool_calls: [tool(), tool()] }, 'tool_calls'),
    recorded({ tool_calls: [{ ...tool(), type: 'other' }] }, 'tool_calls'),
    recorded({ tool_calls: [{ ...tool(), function: null }] }, 'tool_calls'),
    recorded({ tool_calls: [{ ...tool(), function: { name: 2, arguments: '{}' } }] }, 'tool_calls'),
    recorded(
      { tool_calls: [{ ...tool(), function: { name: 'worker_exec', arguments: {} } }] },
      'tool_calls'
    ),
    recorded(
      { tool_calls: [tool(JSON.stringify('é'.repeat(MAX_TOOL_ARGUMENT_BYTES)))] },
      'tool_calls'
    ),
    { choices: [recorded().choices[0], recorded().choices[0]] },
  ])('returns malformed without throwing for hostile shape %#', async (raw) => {
    expect(
      (await adapter(vi.fn<typeof fetch>().mockResolvedValue(response(raw))).complete(request)).kind
    ).toBe('malformed');
  });
  it.each([
    null,
    {},
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1, completion_tokens: 0.5 },
  ])('missing/invalid usage is unknown %#', async (usage) => {
    expect(
      (
        await adapter(
          vi.fn<typeof fetch>().mockResolvedValue(response(recorded(undefined, 'stop', usage)))
        ).complete(request)
      ).usage
    ).toBeNull();
  });
  it('invalid JSON, UTF-8, missing body and oversized response fail closed', async () => {
    for (const body of [
      new Response('{bad'),
      new Response(new Uint8Array([255])),
      new Response(null),
      new Response('x'.repeat(1024 * 1024 + 1)),
    ]) {
      expect(
        (await adapter(vi.fn<typeof fetch>().mockResolvedValue(body)).complete(request)).kind
      ).toBe('malformed');
    }
  });
  it.each([
    429, 500, 503, 599,
  ])('one retry only when both attempts authorized: %s', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('secret body', { status }))
      .mockResolvedValueOnce(response(recorded()));
    expect((await adapter(fetcher).complete({ ...request, attempts: 2 })).usage).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    400, 401, 403, 429, 500,
  ])('HTTP errors expose status only and default never retries: %s', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(KEY, { status }));
    await expect(adapter(fetcher).complete(request)).rejects.toMatchObject({
      code: 'model_http',
      status,
      message: `model_http:${status}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('non-retry statuses, repeated errors and malformed answers cannot silently retry', async () => {
    for (const raw of [
      new Response(KEY, { status: 401 }),
      new Response(KEY, { status: 500 }),
      response({}),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => raw.clone());
      await adapter(fetcher)
        .complete({ ...request, attempts: 2 })
        .catch(() => {});
      expect(fetcher.mock.calls.length).toBe(raw.status === 500 ? 2 : 1);
    }
  });
  it('missing key refuses startup/call and invalid endpoint/model/key-env refuse without echo', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubEnv('MODEL_TEST_KEY', '');
    expect(() => adapter(fetch)).toThrow('model_unavailable');
    vi.stubEnv('MODEL_TEST_KEY', KEY);
    const model = adapter(fetch);
    vi.stubEnv('MODEL_TEST_KEY', '');
    await expect(model.complete(request)).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    for (const endpoint of [
      'bad',
      'http://remote.example',
      'https://user:password@provider.example',
      'https://provider.example/?key=value',
      'https://provider.example/#key',
    ]) {
      expect(
        () =>
          new OpenAICompatibleAdapter({
            model: 'model-a',
            endpoint,
            apiKeyEnv: 'MODEL_TEST_KEY',
            fetch,
          })
      ).toThrow('invalid_request');
    }
    expect(
      () =>
        new OpenAICompatibleAdapter({
          model: '',
          endpoint: 'https://provider.example',
          apiKeyEnv: 'BAD-NAME',
          fetch,
        })
    ).toThrow('invalid_request');
    vi.stubEnv('MODEL_TEST_KEY', KEY);
    expect(
      new OpenAICompatibleAdapter({
        model: 'model-a',
        endpoint: 'http://localhost:8000/v1',
        apiKeyEnv: 'MODEL_TEST_KEY',
        fetch,
      }).id
    ).toBe('model-a');
  });
  it('scans every returned/error/log/journal sink for recognizable or JSON-escaped key', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const outputs: unknown[] = [];
    const store = ledger();
    for (const raw of [
      recorded({ content: KEY }),
      recorded({ tool_calls: [tool(JSON.stringify({ value: KEY }))] }, 'tool_calls'),
      recorded({ content: 'sk-proj-synthetic-secret' }),
    ]) {
      outputs.push(
        await meteredComplete(
          adapter(vi.fn<typeof fetch>().mockResolvedValue(response(raw))),
          store,
          's1',
          rates,
          request
        )
      );
    }
    const escaped = JSON.stringify(recorded({ content: KEY })).replace(
      'recognizable',
      '\\u0072ecognizable'
    );
    outputs.push(
      await adapter(vi.fn<typeof fetch>().mockResolvedValue(new Response(escaped))).complete(
        request
      )
    );
    try {
      await meteredComplete(
        adapter(vi.fn<typeof fetch>().mockRejectedValue(new Error(KEY))),
        store,
        's1',
        rates,
        request
      );
    } catch (error) {
      outputs.push(String(error), JSON.stringify(error));
    }
    outputs.push(fs.readFileSync(store.file, 'utf8'), ...logs.flatMap((log) => log.mock.calls));
    expect(JSON.stringify(outputs)).not.toContain(KEY);
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
    expect(outputs[0]).toMatchObject({
      kind: 'malformed',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });
  it('aborts hanging fetch and hanging body within the deadline', async () => {
    // Keep the event loop alive while AbortSignal.timeout's unref timer is pending.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      for (const hangingBody of [false, true]) {
        let signal: AbortSignal | undefined;
        const fetcher: typeof fetch = async (_url, init) => {
          signal = init?.signal as AbortSignal;
          return hangingBody
            ? new Response(new ReadableStream())
            : await new Promise<Response>(() => {});
        };
        await expect(
          adapter(fetcher).complete({ ...request, timeoutMs: 20 })
        ).rejects.toMatchObject({ code: 'model_timeout' });
        expect(signal?.aborted).toBe(true);
      }
    } finally {
      clearInterval(keepAlive);
    }
  });
  it('pre-aborted signal issues no HTTP call', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).complete({ ...request, signal: AbortSignal.abort(KEY) })
    ).rejects.toMatchObject({ code: 'model_aborted' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('real budget ledger metering', () => {
  it('refuses already-aborted calls without creating unknown reservations', async () => {
    const store = ledger();
    const model = new ScriptedModel('model-a', [textResult]);
    await expect(
      meteredComplete(model, store, 's1', rates, { ...request, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'model_aborted' });
    expect(store.snapshot().reservations).toEqual([]);
    expect(model.requests).toEqual([]);
  });
  it('unrepresentable usage retains full hold and is returned as unknown, not a ledger config error', async () => {
    const store = ledger();
    const model = new ScriptedModel('model-a', [
      { ...textResult, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 5 } },
    ]);
    expect((await meteredComplete(model, store, 's1', rates, request)).usage).toBeNull();
    expect(store.snapshot().reservations[0]?.status).toBe('reserved');
  });
  it('observation pricing shares exact FX/rounding and validates zero/overflow/wrong units', () => {
    const input = {
      currency: 'USD',
      resource: 'model-a',
      inputTokens: 1,
      outputTokens: 0,
      timeMs: 0,
    };
    expect(observeModelBudget(input, rates)).toMatchObject({ tokens: 1, money: { minor: 2 } });
    expect(observeModelBudget({ ...input, inputTokens: 0 }, rates)).toMatchObject({
      tokens: 0,
      money: { minor: 0 },
    });
    const fraction = rates.map((rate) => ({ ...rate, price: 1, units: 3 }));
    expect(observeModelBudget(input, fraction).money.minor).toBe(1);
    expect(() =>
      observeModelBudget(
        input,
        rates.map((rate) => ({ ...rate, unit: 'millisecond' }))
      )
    ).toThrow('pricing unit');
    expect(() => observeModelBudget({ ...input, currency: 'EUR' }, rates)).toThrow('pricing unit');
    expect(() =>
      observeModelBudget({ ...input, inputTokens: Number.MAX_SAFE_INTEGER }, rates)
    ).toThrow('overflow');
  });
  it('durably reserves serialized UTF-8 upper bound before the call and settles observed usage', async () => {
    const store = ledger();
    const complete = vi.fn(async () => {
      const row = store.snapshot().reservations[0];
      expect(row?.status).toBe('reserved');
      expect(row?.estimate.tokens).toBe(
        Buffer.byteLength(modelRequestBody('model-a', request), 'utf8') + 100
      );
      expect(row?.purpose).toBe('work');
      return textResult;
    });
    expect(await meteredComplete({ id: 'model-a', complete }, store, 's1', rates, request)).toEqual(
      textResult
    );
    expect(store.snapshot().reservations[0]).toMatchObject({
      status: 'settled',
      observed: { tokens: 12, money: { minor: 24 }, source: 'model_usage' },
    });
  });
  it('records zero usage, retains unknown holds and exposes no adapter error', async () => {
    const store = ledger();
    const scripted = new ScriptedModel('model-a', [
      { ...textResult, usage: { inputTokens: 0, outputTokens: 0 } },
      { ...textResult, usage: null },
    ]);
    await meteredComplete(scripted, store, 's1', rates, request);
    await meteredComplete(scripted, store, 's1', rates, request);
    await expect(meteredComplete(scripted, store, 's1', rates, request)).rejects.toMatchObject({
      code: 'model_unavailable',
    });
    expect(scripted.requests).toHaveLength(3);
    expect(store.snapshot().reservations.map((row) => row.status)).toEqual([
      'settled',
      'reserved',
      'reserved',
    ]);
    expect(store.snapshot().reservations[0]?.observed).toMatchObject({
      tokens: 0,
      money: { minor: 0 },
    });
  });
  it('refused money reservation never calls provider', async () => {
    const store = ledger(100_000, 100_000, rates, 1);
    const model = new ScriptedModel('model-a', [textResult]);
    await expect(meteredComplete(model, store, 's1', rates, request)).rejects.toBeInstanceOf(
      BudgetExhaustedError
    );
    expect(model.requests).toEqual([]);
    expect(store.snapshot().reservations).toEqual([]);
  });
  it.each([
    'tokens',
    'time',
  ])('zero-priced model still enforces %s ceilings and both attempts', async (dimension) => {
    const free = rates.map((rate) => ({ ...rate, price: 0 }));
    const store = ledger(
      dimension === 'tokens' ? 1 : 100_000,
      dimension === 'time' ? 1500 : 100_000,
      free
    );
    const model = new ScriptedModel('model-a', [textResult]);
    await expect(
      meteredComplete(model, store, 's1', free, { ...request, attempts: 2 })
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(model.requests).toEqual([]);
  });
  it('two-attempt estimate covers retries and retry settlement stays unknown', async () => {
    const store = ledger();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(response(recorded()));
    await meteredComplete(adapter(fetcher), store, 's1', rates, { ...request, attempts: 2 });
    const row = store.snapshot().reservations[0];
    expect(row?.estimate.tokens).toBe(
      2 * (Buffer.byteLength(modelRequestBody('model-a', request)) + 100)
    );
    expect(row?.estimate.timeMs).toBe(2000);
    expect(row?.status).toBe('reserved');
  });
  it('timeout and caller abort conservatively retain full reservation, including non-cooperative adapters', async () => {
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const store = ledger();
      let signal: AbortSignal | undefined;
      const model = {
        id: 'model-a',
        complete: vi.fn(async (req: ModelRequest) => {
          signal = req.signal;
          return await new Promise<ModelResult>(() => {});
        }),
      };
      await expect(
        meteredComplete(model, store, 's1', rates, { ...request, timeoutMs: 20 })
      ).rejects.toMatchObject({ code: 'model_timeout' });
      expect(signal?.aborted).toBe(true);
      await expect(
        meteredComplete(model, store, 's1', rates, { ...request, signal: AbortSignal.abort() })
      ).rejects.toMatchObject({ code: 'model_aborted' });
      expect(model.complete).toHaveBeenCalledTimes(1);
      expect(
        store
          .snapshot()
          .reservations.every(
            (row) =>
              row.status === 'reserved' && row.estimate.tokens > 0 && row.observed === undefined
          )
      ).toBe(true);
    } finally {
      clearInterval(keepAlive);
    }
  });
  it('ledger corruption/unknown session/invalid rate are not exhaustion and call no provider', async () => {
    const store = ledger();
    const model = new ScriptedModel('model-a', [textResult]);
    await expect(meteredComplete(model, store, 'missing', rates, request)).rejects.toMatchObject({
      code: 'unknown_session',
    });
    await expect(meteredComplete(model, store, 's1', [], request)).rejects.toMatchObject({
      code: 'missing_rate',
    });
    const reserve = vi.spyOn(store, 'reserve').mockImplementation(() => {
      throw new Error('persistence failed');
    });
    await expect(meteredComplete(model, store, 's1', rates, request)).rejects.toThrow(
      'persistence failed'
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(model.requests).toEqual([]);
  });
  it('invalid adapter usage retains full hold', async () => {
    const store = ledger();
    const model = new ScriptedModel('model-a', [
      { ...textResult, usage: { inputTokens: -1, outputTokens: 2 } },
    ]);
    await meteredComplete(model, store, 's1', rates, request);
    expect(store.snapshot().reservations[0]?.status).toBe('reserved');
  });
});

describe('request snapshot', () => {
  it.each([
    { maxOutputTokens: 0 },
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
    { attempts: 3 },
    { system: null },
    { messages: null },
    { tools: null },
  ])('rejects invalid bounds/shape %#', (patch) => {
    expect(() => snapshotModelRequest({ ...request, ...patch } as ModelRequest)).toThrow(
      ModelError
    );
  });
  it('rejects cyclic data and detaches mutable caller data', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() =>
      snapshotModelRequest({ ...request, tools: cyclic as ModelRequest['tools'] })
    ).toThrow(ModelError);
    const snapshot = snapshotModelRequest(request);
    expect(snapshot.messages).not.toBe(request.messages);
    expect(snapshot.tools).not.toBe(request.tools);
  });
});
