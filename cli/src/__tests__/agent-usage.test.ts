import { describe, expect, it } from 'vitest';
import { parseAgentUsage } from '../helpers';

describe('parseAgentUsage', () => {
  it('parses the classic usage shape (usage + total_cost_usd + model)', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 3000,
      result: 'done',
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.0035,
      usage: {
        input_tokens: 25,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
      },
    });

    expect(parseAgentUsage(stdout)).toEqual({
      model: 'claude-sonnet-4-20250514',
      input_tokens: 25,
      output_tokens: 200,
      total_cost_usd: 0.0035,
      result_text: 'done',
    });
  });

  it('parses the older cost_usd field when total_cost_usd is absent', () => {
    const stdout = JSON.stringify({
      type: 'result',
      cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({ total_cost_usd: 0.01 });
  });

  it('sums camelCase modelUsage entries when usage is absent', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.02 },
        'claude-haiku-4-20250514': { inputTokens: 25, outputTokens: 5, totalCostUsd: 0.001 },
      },
      result: 'ok',
    });

    const usage = parseAgentUsage(stdout);
    expect(usage).toMatchObject({
      // Multiple models ran: model lists them comma-joined, tokens/cost are totals.
      model: 'claude-opus-4-20250514,claude-haiku-4-20250514',
      input_tokens: 125,
      output_tokens: 55,
      total_cost_usd: 0.021,
      result_text: 'ok',
    });
  });

  it('reports the single model as-is when only one ran', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': { inputTokens: 7, outputTokens: 3, totalCostUsd: 0.5 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      model: 'claude-opus-4-20250514',
    });
  });

  it('ignores malformed (non-object) modelUsage entries', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': 'not an object',
        'claude-haiku-4-20250514': { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      model: 'claude-haiku-4-20250514',
      input_tokens: 10,
      output_tokens: 2,
      total_cost_usd: 0.01,
    });
  });

  it('sums snake_case modelUsage entries', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': { input_tokens: 7, output_tokens: 3, total_cost_usd: 0.5 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      total_cost_usd: 0.5,
    });
  });

  it('prefers top-level usage over modelUsage', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 5, output_tokens: 6 },
      modelUsage: {
        'claude-opus-4-20250514': { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.02 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({ input_tokens: 5, output_tokens: 6 });
  });

  it('returns null fields when the JSON has no usage data (never fabricates)', () => {
    const stdout = JSON.stringify({ type: 'result', result: 'no usage here' });

    expect(parseAgentUsage(stdout)).toEqual({
      model: null,
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
      result_text: 'no usage here',
    });
  });

  it('returns null for non-JSON output', () => {
    expect(parseAgentUsage('plain text output\n')).toBeNull();
    expect(parseAgentUsage('{"broken')).toBeNull();
  });

  it('returns null for empty or undefined stdout', () => {
    expect(parseAgentUsage('')).toBeNull();
    expect(parseAgentUsage('   ')).toBeNull();
    expect(parseAgentUsage(undefined)).toBeNull();
    expect(parseAgentUsage(null)).toBeNull();
  });

  it('returns null when stdout is a JSON array or scalar', () => {
    expect(parseAgentUsage('[1,2,3]')).toBeNull();
    expect(parseAgentUsage('"a string"')).toBeNull();
    expect(parseAgentUsage('42')).toBeNull();
  });

  it('ignores non-numeric usage values instead of recording NaN', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 'many', output_tokens: null },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: null,
      output_tokens: null,
    });
  });
});
