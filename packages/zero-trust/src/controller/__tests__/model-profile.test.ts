import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../budget';
import type { ModelRequest } from '../../model/adapter';
import { OpenAICompatibleAdapter } from '../../model/openai-compatible';
import { contributionIdOf } from '../ids';
import { rig } from './composition-fixture';
import { compositionHooks } from './composition-hooks';

compositionHooks();
describe('composed model profiles (#1186)', () => {
  it('trusted controller and decision wrappers preserve same-call rejection provenance', async () => {
    vi.stubEnv('ZT_MODEL_PROFILE_KEY', 'model-profile-only-fixture-key');
    const h = rig();
    const model = new OpenAICompatibleAdapter({
      model: 'fixture',
      endpoint: 'https://api.openai.com/v1',
      apiKeyEnv: 'ZT_MODEL_PROFILE_KEY',
      fetch: async () =>
        new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 }),
    });
    Object.assign(h.edges.models, { planning: model, implementing: model, repair: model });
    const run = await h.authorize(h.controller.start(h.config));
    expect(run.state).toBe('gating');
    const contribution = contributionIdOf(run.runId);
    if (!contribution) throw new Error('Expected fixture contribution ID');
    const ledger = new BudgetLedger(
      path.join(h.config.executionProfile.stateDir, 'runs', contribution, 'budget', 'ledger.json'),
      contribution
    );
    expect(ledger.snapshot().reservations.length).toBeGreaterThan(0);
    expect(ledger.snapshot().reservations.every((r) => r.status === 'released')).toBe(true);
  });
  it.each([
    false,
    true,
    undefined,
  ])('preserves custom alias profile through execution and decision wrappers: logprobs=%s', async (logprobs) => {
    vi.stubEnv('ZT_MODEL_PROFILE_KEY', 'model-profile-only-fixture-key');
    const h = rig();
    const scripted = h.edges.models.planning;
    const requests: { tool: string; logprobs?: boolean }[] = [];
    const failures: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const bytes = init?.body as string;
      const body = JSON.parse(bytes);
      expect(body).toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('max_tokens');
      expect(body.max_completion_tokens).toBe(
        body.tools[0]?.function.name === 'report_decision'
          ? logprobs === undefined
            ? 8192
            : 9000
          : logprobs === undefined
            ? 32768
            : 40000
      );
      if (!logprobs) expect(body).not.toHaveProperty('logprobs');
      const contribution = contributionIdOf(h.controller.snapshot().runId);
      if (!contribution) throw new Error('Expected fixture contribution ID');
      const ledger = new BudgetLedger(
        path.join(
          h.config.executionProfile.stateDir,
          'runs',
          contribution,
          'budget',
          'ledger.json'
        ),
        contribution
      );
      const pending = ledger.snapshot().reservations.filter((r) => r.status === 'reserved');
      expect(pending.at(-1)?.estimate.tokens).toBe(
        Buffer.byteLength(bytes) + body.max_completion_tokens
      );
      const request: ModelRequest = {
        system: body.messages[0].content,
        messages: body.messages.slice(1),
        tools: body.tools ?? [],
        maxOutputTokens: body.max_completion_tokens,
        timeoutMs: 1000,
        logprobs: body.logprobs,
      };
      requests.push({ tool: request.tools[0]?.function.name, logprobs: request.logprobs });
      const result = await scripted.complete(request);
      if (result.kind !== 'tool_calls') throw new Error('Expected fixture tool call');
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: result.calls.map((call) => {
                  const { kind, ...arguments_ } = call.arguments as Record<string, unknown>;
                  return {
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name === 'propose_action' ? kind : call.name,
                      arguments: JSON.stringify(
                        call.name === 'propose_action' ? arguments_ : call.arguments
                      ),
                    },
                  };
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    };
    const model = new OpenAICompatibleAdapter({
      model: 'fixture',
      endpoint: 'https://model.example/v1',
      apiKeyEnv: 'ZT_MODEL_PROFILE_KEY',
      fetch: async (...args) => {
        try {
          return await fetcher(...args);
        } catch (error) {
          failures.push(String(error));
          throw error;
        }
      },
      maxTokensParameter: 'max_completion_tokens',
      logprobs,
      ...(logprobs === undefined ? {} : { decisionOutputTokens: 9000, agentOutputTokens: 40000 }),
    });
    Object.assign(h.edges.models, { planning: model, implementing: model, repair: model });
    const run = await h.authorize(h.controller.start(h.config));
    expect(failures).toEqual([]);
    expect(run.state, JSON.stringify({ run, requests })).toBe('awaiting_contributor');
    expect(requests.some((r) => r.tool === 'report_decision')).toBe(true);
    expect(requests.some((r) => r.tool !== 'report_decision')).toBe(true);
    expect(
      requests
        .filter((r) => r.tool === 'report_decision')
        .every((r) => r.logprobs === (logprobs ? true : undefined))
    ).toBe(true);
  }, 60000);
});
