import { setTimeout as delay } from 'node:timers/promises';
import { assertNoSecrets, assertSecretFree } from '../redaction';
import { isRecord } from '../state';
import {
  MAX_TOOL_ARGUMENT_BYTES,
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
  type ModelUsage,
  modelRequestBody,
  type SnapshotModelRequest,
  snapshotModelRequest,
  withModelDeadline,
} from './adapter';

export const MAX_MODEL_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_DEPTH = 256;
const RETRY_DELAY_MS = 50;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const malformed = (
  reason: 'invalid_response' | 'response_too_large' | 'secret_detected',
  usage: ModelUsage | null = null
): ModelResult => ({ kind: 'malformed', reason, usage });
function usage(raw: unknown): ModelUsage | null {
  if (!isRecord(raw) || !count(raw.prompt_tokens) || !count(raw.completion_tokens)) return null;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens };
}
function parseCall(call: unknown, names: Set<string>, ids: Set<string>): ModelToolCall | null {
  if (
    !isRecord(call) ||
    typeof call.id !== 'string' ||
    !call.id ||
    ids.has(call.id) ||
    call.type !== 'function' ||
    !isRecord(call.function)
  )
    return null;
  const fn = call.function;
  if (
    typeof fn.name !== 'string' ||
    !names.has(fn.name) ||
    typeof fn.arguments !== 'string' ||
    Buffer.byteLength(fn.arguments, 'utf8') > MAX_TOOL_ARGUMENT_BYTES
  )
    return null;
  try {
    const argumentsValue: unknown = JSON.parse(fn.arguments);
    ids.add(call.id);
    return { id: call.id, name: fn.name, arguments: argumentsValue };
  } catch {
    return null;
  }
}
function parse(raw: unknown, request: ModelRequest, reported: ModelUsage | null): ModelResult {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1 ||
    !isRecord(raw.choices[0]) ||
    !isRecord(raw.choices[0].message)
  )
    return malformed('invalid_response', reported);
  const choice = raw.choices[0];
  const message = choice.message as Record<string, unknown>;
  if (
    choice.finish_reason === 'tool_calls' &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const names = new Set(request.tools.map((tool) => tool.function.name));
    const ids = new Set<string>();
    const calls: ModelToolCall[] = [];
    for (const rawCall of message.tool_calls) {
      const call = parseCall(rawCall, names, ids);
      if (!call) return malformed('invalid_response', reported);
      calls.push(call);
    }
    return { kind: 'tool_calls', calls, usage: reported };
  }
  const noCalls =
    message.tool_calls === undefined ||
    message.tool_calls === null ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length === 0);
  if (choice.finish_reason === 'stop' && typeof message.content === 'string' && noCalls)
    return { kind: 'text', text: message.content, usage: reported };
  return malformed('invalid_response', reported);
}
function containsKey(value: unknown, key: string): boolean {
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (isRecord(value))
    return Object.entries(value).some(
      ([name, item]) => name.includes(key) || containsKey(item, key)
    );
  return false;
}
function boundedDepth(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop() as { value: unknown; depth: number };
    if (item.depth > MAX_RESPONSE_DEPTH) return false;
    const children = Array.isArray(item.value)
      ? item.value
      : isRecord(item.value)
        ? Object.values(item.value)
        : [];
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
function decode(bytes: Uint8Array, key: string, request: ModelRequest): ModelResult {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return malformed('invalid_response');
  }
  const reported = isRecord(raw) ? usage(raw.usage) : null;
  if (!boundedDepth(raw)) return malformed('invalid_response', reported);
  try {
    if (containsKey(raw, key)) return malformed('secret_detected', reported);
    assertSecretFree(raw);
  } catch {
    return malformed('secret_detected', reported);
  }
  let result: ModelResult;
  try {
    result = parse(raw, request, reported);
  } catch {
    return malformed('invalid_response', reported);
  }
  try {
    if (!boundedDepth(result)) return malformed('invalid_response', reported);
    if (containsKey(result, key)) return malformed('secret_detected', reported);
    assertSecretFree(result);
  } catch {
    return malformed('secret_detected', reported);
  }
  return result;
}
async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return Buffer.concat(chunks);
      bytes += part.value.byteLength;
      if (bytes > MAX_MODEL_RESPONSE_BYTES) return null;
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
function retryDelay(response: Response, timeoutMs: number): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return Math.min(RETRY_DELAY_MS, timeoutMs);
  const seconds = Number(raw);
  const ms =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
  // An excessive backoff cannot widen the admitted duration; refuse the retry.
  if (Number.isFinite(ms) && ms >= timeoutMs) throw new ModelError('model_http', response.status);
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : Math.min(RETRY_DELAY_MS, timeoutMs);
}
export interface OpenAICompatibleOptions {
  model: string;
  /** API base URL, e.g. https://provider.example/v1; localhost HTTP is allowed. */
  endpoint: string;
  apiKeyEnv: string;
  fetch: typeof fetch;
}
/** Contains no credential field. The key is read only at startup check and call time. */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  private readonly url: string;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Read by key() at startup and before each call (Biome misses computed env access).
  private readonly apiKeyEnv: string;
  private readonly fetcher: typeof fetch;
  constructor(options: OpenAICompatibleOptions) {
    try {
      const { model, endpoint, apiKeyEnv, fetch: fetcher } = options;
      const url = new URL(endpoint);
      if (
        url.username ||
        url.password ||
        endpoint.includes('?') ||
        endpoint.includes('#') ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        typeof model !== 'string' ||
        !model ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv) ||
        /^(?:ZTFC_|GIT_)/u.test(apiKeyEnv) ||
        ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_CLIENT_SECRET'].includes(apiKeyEnv) ||
        typeof fetcher !== 'function'
      )
        throw new ModelError('invalid_request');
      assertNoSecrets(model);
      assertNoSecrets(endpoint);
      this.id = model;
      this.url = `${url.href.replace(/\/$/u, '')}/chat/completions`;
      this.apiKeyEnv = apiKeyEnv;
      this.fetcher = fetcher;
    } catch {
      throw new ModelError('invalid_request');
    }
    this.key();
  }
  private key(): string {
    const key = process.env[this.apiKeyEnv];
    // Validate the exact header value; header normalization must not evade echo detection.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse HTTP control/whitespace bytes in credentials before header normalization.
    if (!key || key !== key.trim() || /[\u0000-\u0020\u007f]/u.test(key))
      throw new ModelError('model_unavailable');
    // Defense in depth against a controller profile accidentally selecting GitHub authority.
    if (/^(?:gh[pousr]_|github_pat_)/u.test(key)) throw new ModelError('model_unavailable');
    return key;
  }
  private async post(
    request: SnapshotModelRequest,
    key: string,
    signal: AbortSignal
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await this.fetcher(this.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: modelRequestBody(this.id, request),
      signal,
    });
    signal.throwIfAborted();
    return response;
  }
  async complete(input: ModelRequest): Promise<ModelResult> {
    const request = snapshotModelRequest(input);
    const key = this.key();
    let backoff = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        const outcome = await withModelDeadline<{ retry: number } | { result: ModelResult }>(
          request,
          async (signal) => {
            if (backoff) await delay(backoff, undefined, { signal });
            const response = await this.post(request, key, signal);
            if (!response.ok) {
              // A tee'd/injected body can keep cancellation pending forever.
              void response.body?.cancel().catch(() => {});
              if (
                attempt === 0 &&
                request.attempts === 2 &&
                (response.status === 429 || (response.status >= 500 && response.status <= 599))
              )
                return { retry: retryDelay(response, request.timeoutMs) };
              throw new ModelError('model_http', response.status);
            }
            const bytes = await readBounded(response, signal);
            return {
              result: bytes
                ? decode(bytes, key, request)
                : malformed(response.body ? 'response_too_large' : 'invalid_response'),
            };
          }
        );
        if ('retry' in outcome) {
          backoff = outcome.retry;
          continue;
        }
        return attempt > 0 ? { ...outcome.result, usage: null } : outcome.result;
      }
    } catch (error) {
      if (
        error instanceof ModelError &&
        ['model_http', 'model_timeout', 'model_aborted'].includes(error.code) &&
        (error.status === undefined ||
          (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599))
      )
        throw new ModelError(error.code, error.status);
      throw new ModelError('model_unavailable');
    }
  }
}
