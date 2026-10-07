/** Controller-side model transport. All returned proposals remain untrusted data. */
export interface ModelTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Trusted controller authorization; metering reserves BOTH attempts before use. Default 1. */
  attempts?: 1 | 2;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelResult = (
  | { kind: 'tool_calls'; calls: { id: string; name: string; arguments: unknown }[] }
  | { kind: 'text'; text: string }
  | { kind: 'malformed'; reason: string }
) & { usage: ModelUsage | null };

export interface ModelAdapter {
  /** Pricing resource ID (the configured model name), never a credential. */
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

export class ModelError extends Error {
  constructor(
    readonly code:
      | 'model_unavailable'
      | 'model_timeout'
      | 'model_aborted'
      | 'invalid_request'
      | 'model_http',
    readonly status?: number
  ) {
    super(status === undefined ? code : `${code}:${status}`);
    this.name = 'ModelError';
  }
}

/** Detach the exact JSON data being estimated/sent; signal is never serialized. */
export function snapshotModelRequest(request: ModelRequest): ModelRequest {
  try {
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 2_147_483_647 ||
      (request.attempts !== undefined && request.attempts !== 1 && request.attempts !== 2) ||
      typeof request.system !== 'string' ||
      !Array.isArray(request.messages) ||
      !Array.isArray(request.tools)
    ) {
      throw new ModelError('invalid_request');
    }
    const data = JSON.parse(
      JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })
    ) as Pick<ModelRequest, 'system' | 'messages' | 'tools'>;
    return {
      ...data,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
      attempts: request.attempts ?? 1,
      signal: request.signal,
    };
  } catch {
    throw new ModelError('invalid_request');
  }
}

/** Wire data is shared with metering so tool schemas and model overhead are counted. */
export function modelRequestBody(id: string, request: ModelRequest): string {
  return JSON.stringify({
    model: id,
    messages: [{ role: 'system', content: request.system }, ...request.messages],
    tools: request.tools,
    max_tokens: request.maxOutputTokens,
    stream: false,
  });
}

/** Bounds injected adapters too, even if they ignore their AbortSignal. */
export async function withModelDeadline<T>(
  request: ModelRequest,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    : AbortSignal.timeout(request.timeoutMs);
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () =>
      reject(new ModelError(request.signal?.aborted ? 'model_aborted' : 'model_timeout'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try {
    if (signal.aborted) return await aborted;
    return await Promise.race([operation(signal), aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
