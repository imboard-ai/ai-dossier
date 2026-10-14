import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../../budget';
import type { ModelRequest } from '../../model/adapter';
import { OpenAICompatibleAdapter } from '../../model/openai-compatible';
import { runConfigInput, validateRunConfig } from '../config';
import { contributionIdOf } from '../ids';
import { RunStore } from '../run-store';
import { createController } from '../wiring';
import { rig, TIME } from './composition-fixture';
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
    { logprobs: false, persisted: false },
    { logprobs: true, persisted: false },
    { logprobs: undefined, persisted: false },
    { logprobs: false, persisted: true },
  ])('preserves custom alias profile through execution and decision wrappers: %j', async ({
    logprobs,
    persisted,
  }) => {
    vi.stubEnv('ZT_MODEL_PROFILE_KEY', 'model-profile-only-fixture-key');
    const h = rig({ failVerification: persisted });
    const scripted = h.edges.models.planning;
    const requests: { tool: string; logprobs?: boolean }[] = [];
    const wireCaps: number[] = [];
    const failures: string[] = [];
    let controller = h.controller;
    const fetcher: typeof fetch = async (_url, init) => {
      const bytes = init?.body as string;
      const body = JSON.parse(bytes);
      expect(body).toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('max_tokens');
      wireCaps.push(body.max_completion_tokens);
      if (persisted && body.tools[0]?.function.name !== 'report_decision') {
        expect([40000, 41000, 42000]).toContain(body.max_completion_tokens);
      } else
        expect(body.max_completion_tokens).toBe(
          body.tools[0]?.function.name === 'report_decision'
            ? logprobs === undefined
              ? 8192
              : 9000
            : logprobs === undefined
              ? 32768
              : 40000
        );
      if (!model.requestProfile.logprobs) expect(body).not.toHaveProperty('logprobs');
      const contribution = contributionIdOf(controller.snapshot().runId);
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
    const modelFetch: typeof fetch = async (...args) => {
      try {
        return await fetcher(...args);
      } catch (error) {
        failures.push(String(error));
        throw error;
      }
    };
    const model = new OpenAICompatibleAdapter({
      model: 'fixture',
      endpoint: 'https://model.example/v1',
      apiKeyEnv: 'ZT_MODEL_PROFILE_KEY',
      fetch: modelFetch,
      maxTokensParameter: 'max_completion_tokens',
      logprobs,
      ...(logprobs === undefined ? {} : { decisionOutputTokens: 9000, agentOutputTokens: 40000 }),
    });
    let config = h.config;
    if (persisted) {
      const raw = structuredClone(config);
      for (const [index, phase] of (['planning', 'implementing', 'repair'] as const).entries()) {
        Object.assign(raw.modelProfile.phases[phase] ?? {}, {
          apiKeyEnv: 'ZT_MODEL_PROFILE_KEY',
          maxTokensParameter: 'max_completion_tokens',
          logprobs: false,
          decisionOutputTokens: 9000 + index * 1000,
          agentOutputTokens: 40000 + index * 1000,
        });
      }
      const store = RunStore.create(
        path.join(h.config.executionProfile.stateDir, 'profile-persistence'),
        validateRunConfig(runConfigInput(raw)),
        TIME
      );
      const runId = store.runId;
      store.close();
      const reopened = RunStore.open(
        path.join(h.config.executionProfile.stateDir, 'profile-persistence'),
        runId
      );
      config = reopened.config;
      reopened.close();
      expect(config.modelProfile.phases.repair?.agentOutputTokens).toBe(42000);
      const fingerprints = Object.values(config.modelProfile.phases).map(
        (phase) => new OpenAICompatibleAdapter({ ...phase, fetch: fetcher }).cacheIdentity
      );
      expect(new Set(fingerprints).size).toBe(3);
      // Use real production adapter construction; only the HTTP/VM/GitHub edges are fake.
      controller = createController(config, {
        ...h.edges,
        models: undefined,
        fetch: async (url, init) =>
          String(url).startsWith('https://model.example/')
            ? modelFetch(url, init)
            : h.edges.fetch(url, init),
      });
    } else Object.assign(h.edges.models, { planning: model, implementing: model, repair: model });
    const run = await h.authorize(controller.start(config), controller);
    expect(failures).toEqual([]);
    // The persisted-profile fixture intentionally fails verification to enter repair.
    expect(run.state, JSON.stringify({ run, requests })).toBe(
      persisted ? 'failed' : 'awaiting_contributor'
    );
    if (persisted) expect(run.reasonCode).toBe('execution_failed');
    expect(requests.some((r) => r.tool === 'report_decision')).toBe(true);
    expect(requests.some((r) => r.tool !== 'report_decision')).toBe(true);
    expect(
      requests
        .filter((r) => r.tool === 'report_decision')
        .every((r) => r.logprobs === (model.requestProfile.logprobs ? true : undefined))
    ).toBe(true);
    if (persisted) expect(new Set(wireCaps)).toEqual(new Set([9000, 40000, 41000, 42000]));
  }, 60000);
});
