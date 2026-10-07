import { assertNoSecrets } from '../redaction';
import {
  MAX_TOOL_ARGUMENT_BYTES,
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  modelRequestBody,
  snapshotModelRequest,
  withModelDeadline,
} from './adapter';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function usage(raw: unknown): ModelUsage | null {
  if (!object(raw) || !count(raw.prompt_tokens) || !count(raw.completion_tokens)) return null;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens };
}

function parse(raw: unknown, request: ModelRequest): ModelResult {
  const reported = object(raw) ? usage(raw.usage) : null;
  const malformed = (): ModelResult => ({
    kind: 'malformed',
    reason: 'invalid_response',
    usage: reported,
  });
  if (
    !object(raw) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1 ||
    !object(raw.choices[0])
  )
    return malformed();
  const choice = raw.choices[0];
  if (!object(choice.message)) return malformed();
  const message = choice.message;
  if (
    choice.finish_reason === 'tool_calls' &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const calls: { id: string; name: string; arguments: unknown }[] = [];
    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      if (
        !object(call) ||
        typeof call.id !== 'string' ||
        !call.id ||
        ids.has(call.id) ||
        call.type !== 'function' ||
        !object(call.function) ||
        typeof call.function.name !== 'string' ||
        !request.tools.some(
          (tool) => tool.function.name === (call.function as Record<string, unknown>).name
        ) ||
        typeof call.function.arguments !== 'string' ||
        Buffer.byteLength(call.function.arguments, 'utf8') > MAX_TOOL_ARGUMENT_BYTES
      )
        return malformed();
      try {
        calls.push({
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments) as unknown,
        });
      } catch {
        return malformed();
      }
      ids.add(call.id);
    }
    return { kind: 'tool_calls', calls, usage: reported };
  }
  if (
    choice.finish_reason === 'stop' &&
    typeof message.content === 'string' &&
    message.tool_calls === undefined
  )
    return { kind: 'text', text: message.content, usage: reported };
  return malformed();
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
      const url = new URL(options.endpoint);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        typeof options.model !== 'string' ||
        !options.model ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.apiKeyEnv) ||
        typeof options.fetch !== 'function'
      )
        throw new ModelError('invalid_request');
      assertNoSecrets(options.model);
      assertNoSecrets(options.endpoint);
      this.id = options.model;
      this.url = `${url.href.replace(/\/$/u, '')}/chat/completions`;
      this.apiKeyEnv = options.apiKeyEnv;
      this.fetcher = options.fetch;
    } catch {
      throw new ModelError('invalid_request');
    }
    this.key();
  }
  private key(): string {
    const key = process.env[this.apiKeyEnv];
    if (!key?.trim()) throw new ModelError('model_unavailable');
    return key;
  }
  async complete(input: ModelRequest): Promise<ModelResult> {
    const request = snapshotModelRequest(input);
    const key = this.key();
    try {
      return await withModelDeadline(request, async (signal) => {
        for (let attempt = 0; attempt < (request.attempts ?? 1); attempt++) {
          signal.throwIfAborted();
          const response = await this.fetcher(this.url, {
            method: 'POST',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: modelRequestBody(this.id, request),
            signal,
          }).catch(() => {
            throw new ModelError('model_unavailable');
          });
          signal.throwIfAborted();
          if (!response.ok) {
            // A tee'd/injected body can keep cancellation pending forever.
            void response.body?.cancel().catch(() => {});
            if (
              attempt === 0 &&
              request.attempts === 2 &&
              (response.status === 429 || (response.status >= 500 && response.status <= 599))
            )
              continue;
            throw new ModelError('model_http', response.status);
          }
          const reader = response.body?.getReader();
          if (!reader) return { kind: 'malformed', reason: 'invalid_response', usage: null };
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const part = await reader.read();
              signal.throwIfAborted();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > MAX_RESPONSE_BYTES)
                return { kind: 'malformed', reason: 'response_too_large', usage: null };
              chunks.push(part.value);
            }
          } finally {
            void reader.cancel().catch(() => {});
          }
          let result: ModelResult;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            // Do not expose even a non-pattern credential echoed by the provider.
            if (text.includes(key))
              return { kind: 'malformed', reason: 'secret_detected', usage: null };
            const raw: unknown = JSON.parse(text);
            // Escaped keys are detected on decoded strings as well as raw text.
            const decoded = JSON.stringify(raw);
            if (decoded.includes(key) || containsKey(raw, key))
              return { kind: 'malformed', reason: 'secret_detected', usage: null };
            assertNoSecrets(decoded);
            result = parse(raw, request);
            if (containsKey(result, key))
              return { kind: 'malformed', reason: 'secret_detected', usage: null };
            assertNoSecrets(JSON.stringify(result));
          } catch {
            return { kind: 'malformed', reason: 'invalid_response', usage: null };
          }
          // A failed first attempt has unknown usage: never settle it as zero.
          return attempt > 0 ? { ...result, usage: null } : result;
        }
        throw new ModelError('model_unavailable');
      });
    } catch (error) {
      if (error instanceof ModelError) throw new ModelError(error.code, error.status);
      throw new ModelError('model_unavailable');
    }
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (object(value))
    return Object.entries(value).some(
      ([name, item]) => name.includes(key) || containsKey(item, key)
    );
  return false;
}
