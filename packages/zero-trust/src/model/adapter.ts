/** Controller-side model transport. All returned proposals remain untrusted data. */
export interface ModelTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface ModelToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ModelToolCallWire[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Trusted controller authorization; metering reserves BOTH attempts before use. Default 1. */
  attempts?: 1 | 2;
  /** Optional token likelihood evidence; never a model's self assessment. */
  logprobs?: boolean;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export type MalformedReason = 'invalid_response' | 'response_too_large' | 'secret_detected';
export type ModelResult = (
  | { kind: 'tool_calls'; calls: ModelToolCall[] }
  | { kind: 'text'; text: string }
  | { kind: 'malformed'; reason: MalformedReason }
) & { usage: ModelUsage | null; tokenLogprobs?: readonly number[] };

export interface ModelAdapter {
  /** Pricing resource ID (the configured model name), never a credential. */
  readonly id: string;
  /** Optional non-secret endpoint/profile fingerprint, never a credential. */
  readonly cacheIdentity?: string;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
/** Node timer ceiling; the entire admitted attempt budget must fit it. */
export const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;
export type SnapshotModelRequest = ModelRequest & { attempts: 1 | 2 };

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
export function snapshotModelRequest(request: ModelRequest): SnapshotModelRequest {
  try {
    const {
      maxOutputTokens,
      timeoutMs,
      attempts = 1,
      system,
      messages,
      tools,
      signal,
      logprobs,
    } = request;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs * attempts > MAX_MODEL_TIMEOUT_MS ||
      (attempts !== 1 && attempts !== 2) ||
      typeof system !== 'string' ||
      !Array.isArray(messages) ||
      !Array.isArray(tools) ||
      (logprobs !== undefined && typeof logprobs !== 'boolean')
    ) {
      throw new ModelError('invalid_request');
    }
    const data = JSON.parse(JSON.stringify({ system, messages, tools })) as Pick<
      ModelRequest,
      'system' | 'messages' | 'tools'
    >;
    return {
      ...data,
      maxOutputTokens,
      timeoutMs,
      attempts,
      signal,
      ...(logprobs === undefined ? {} : { logprobs }),
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
    ...(request.tools.length ? { tools: request.tools } : {}),
    max_tokens: request.maxOutputTokens,
    stream: false,
    ...(request.logprobs === undefined ? {} : { logprobs: request.logprobs }),
  });
}

/** Bounds injected adapters too, even if they ignore their AbortSignal. */
export async function withModelDeadline<T>(
  request: ModelRequest,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const controller = new AbortController();
  const signal = controller.signal;
  const onTimeout = () => controller.abort(new ModelError('model_timeout'));
  const onCaller = () =>
    controller.abort(
      new ModelError(
        request.signal?.reason instanceof ModelError &&
          request.signal.reason.code === 'model_timeout'
          ? 'model_timeout'
          : 'model_aborted'
      )
    );
  timeout.addEventListener('abort', onTimeout, { once: true });
  request.signal?.addEventListener('abort', onCaller, { once: true });
  if (request.signal?.aborted) onCaller();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try {
    if (signal.aborted) return await aborted;
    return await Promise.race([operation(signal), aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
    timeout.removeEventListener('abort', onTimeout);
    request.signal?.removeEventListener('abort', onCaller);
  }
}
