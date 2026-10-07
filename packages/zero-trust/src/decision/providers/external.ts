import { createHash } from 'node:crypto';
import {
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
} from '../../model/adapter';
import {
  assertModelKeyEnv,
  containsModelKey,
  modelEndpoint,
  readBoundedModelBody,
  readModelKey,
} from '../../model/transport';
import { assertNoSecrets, assertSecretFree } from '../../redaction';
import { isRecord } from '../../state';
import type { DecisionInput, DecisionProvider, TypedQuestion } from '../types';

export interface ExternalDecisionOptions {
  /** Omitted configuration is disabled; decisions escalate without reserving budget. */
  endpoint?: string;
  apiKeyEnv?: string;
  model?: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  /** One token-equivalent per byte: conservative output bound, explicit rates required. */
  maxOutputTokens?: number;
}
const MAX_EXTERNAL_BYTES = 64 * 1024;
const DEFAULT_EXTERNAL_OUTPUT_TOKENS = MAX_EXTERNAL_BYTES;

/** Generic/Jev-style endpoint contract: {question, inputs} -> {value, probability, citations?}.
 * No retries, redirects, raw errors, logging, or provider fallback. */
export function createExternalDecisionProvider(options: ExternalDecisionOptions): DecisionProvider {
  const {
    endpoint,
    apiKeyEnv,
    model = 'external-decision',
    fetch: fetcher,
    timeoutMs = 30_000,
    maxOutputTokens = DEFAULT_EXTERNAL_OUTPUT_TOKENS,
  } = options;
  let url: string | undefined;
  try {
    assertNoSecrets(model);
    if (!model || typeof fetcher !== 'function') throw new Error();
    if (endpoint !== undefined || apiKeyEnv !== undefined) {
      if (!endpoint || !apiKeyEnv) throw new Error();
      assertModelKeyEnv(apiKeyEnv);
      url = modelEndpoint(endpoint).href;
    }
  } catch {
    throw new ModelError('invalid_request');
  }
  const key = () => {
    if (!url || !apiKeyEnv) throw new ModelError('model_unavailable');
    return readModelKey(apiKeyEnv, true);
  };
  const adapter: ModelAdapter = Object.freeze({
    id: model,
    async complete(request: ModelRequest): Promise<ModelResult> {
      const credential = key(); // Re-read at dispatch as well as pre-admission.
      try {
        const body = request.messages[0].content;
        if (typeof body !== 'string') throw new ModelError('invalid_request');
        const response = await fetcher(url as string, {
          method: 'POST',
          redirect: 'error',
          signal: request.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
          body,
        });
        request.signal?.throwIfAborted();
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ModelError('model_http', response.status);
        }
        const bytes = await readBoundedModelBody(response, request.signal, MAX_EXTERNAL_BYTES);
        if (!bytes) throw new ModelError('model_unavailable');
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        assertSecretFree(raw);
        if (
          containsModelKey(raw, credential) ||
          !isRecord(raw) ||
          Object.keys(raw).some((k) => !['value', 'probability', 'citations'].includes(k))
        )
          throw new ModelError('model_unavailable');
        // Observed local byte-equivalents are NOT claimed to be provider-reported tokens.
        // The ledger still charges max(estimate, observed); success closes the resume fence.
        return {
          kind: 'tool_calls',
          calls: [
            {
              id: 'external-answer',
              name: 'report_decision',
              arguments: {
                value: raw.value,
                confidence: raw.probability,
                citations: raw.citations ?? [],
              },
            },
          ],
          usage: { inputTokens: Buffer.byteLength(body, 'utf8'), outputTokens: bytes.byteLength },
        };
      } catch (error) {
        if (error instanceof ModelError) throw new ModelError(error.code, error.status);
        throw new ModelError('model_unavailable');
      }
    },
  });
  return Object.freeze({
    id: url
      ? `external:${createHash('sha256').update(url).digest('hex')}`
      : 'external:unconfigured',
    model,
    confidenceKind: 'external' as const,
    adapter,
    request(question: TypedQuestion, inputs: readonly DecisionInput[]) {
      key(); // Disabled/keyless means no network, no billable reservation.
      return {
        system: '', // External wire is only this body; no system prompt is sent.
        messages: [{ role: 'user' as const, content: JSON.stringify({ question, inputs }) }],
        tools: [],
        maxOutputTokens,
        timeoutMs,
        attempts: 1 as const,
      };
    },
    decode(result: ModelResult): unknown {
      return result.kind === 'tool_calls' && result.calls.length === 1
        ? result.calls[0].arguments
        : null;
    },
  });
}
