import { describe, expect, it } from 'vitest';
import { parseAgentUsage, parseOpenCodeUsage } from '../agent-usage';

describe('parseAgentUsage', () => {
  it('parses the classic usage shape (usage + total_cost_usd + model) when no modelUsage is present', () => {
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
      cache_creation_tokens: 100,
      cache_read_tokens: 1000,
      total_cost_usd: 0.0035,
      result_text: 'done',
    });
  });

  it('parses the older cost_usd field when total_cost_usd is absent and there is no modelUsage', () => {
    const stdout = JSON.stringify({
      type: 'result',
      cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({ total_cost_usd: 0.01 });
  });

  it('sums camelCase modelUsage entries', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 8,
          cacheReadInputTokens: 40,
          totalCostUsd: 0.02,
        },
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
      cache_creation_tokens: 8,
      cache_read_tokens: 40,
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
        'claude-opus-4-20250514': {
          input_tokens: 7,
          output_tokens: 3,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 9,
          total_cost_usd: 0.5,
        },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_tokens: 2,
      cache_read_tokens: 9,
      total_cost_usd: 0.5,
    });
  });

  // The bug this module exists to close (#524): the pilot found `usage` and
  // `modelUsage` can disagree enough to fabricate a ~43% "saving" when one
  // run reads from one block and another reads from the other. `modelUsage`
  // must win outright whenever it is present — never a per-field blend.
  it('sources from modelUsage — not top-level usage — when both are present and disagree', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 5, output_tokens: 6 },
      total_cost_usd: 0.001,
      modelUsage: {
        'claude-opus-4-20250514': { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.02 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.02,
    });
  });

  it('falls back to the usage block only when modelUsage is entirely absent', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 5, output_tokens: 6 },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({ input_tokens: 5, output_tokens: 6 });
  });

  it('returns null fields when the JSON has no usage data (never fabricates)', () => {
    const stdout = JSON.stringify({ type: 'result', result: 'no usage here' });

    expect(parseAgentUsage(stdout)).toEqual({
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_tokens: null,
      cache_read_tokens: null,
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

describe('parseOpenCodeUsage', () => {
  // Events captured from a real `echo prompt | opencode run --format json` run
  // (trimmed to the fields the parser reads).
  const event = (obj: Record<string, unknown>) => JSON.stringify(obj);

  const textEvent = (text: string) =>
    event({
      type: 'text',
      timestamp: 1787999439397,
      sessionID: 'ses_test',
      part: { id: 'prt_1', type: 'text', text, time: { start: 1, end: 2 } },
    });

  const stepFinish = (input: number, output: number, cost: number) =>
    event({
      type: 'step_finish',
      timestamp: 1787999439536,
      sessionID: 'ses_test',
      part: {
        id: 'prt_2',
        type: 'step-finish',
        reason: 'stop',
        tokens: {
          total: input + output,
          input,
          output,
          reasoning: 0,
          cache: { write: 0, read: 0 },
        },
        cost,
      },
    });

  const stepStart = event({
    type: 'step_start',
    timestamp: 1787999439396,
    sessionID: 'ses_test',
    part: { id: 'prt_0', type: 'step-start' },
  });

  it('parses text, tokens and cost from a JSONL event stream', () => {
    const stdout = [stepStart, textEvent('OK'), stepFinish(26502, 3, 0.03771504)].join('\n');

    expect(parseOpenCodeUsage(stdout)).toEqual({
      model: null, // opencode events carry no model id — caller falls back to --model
      input_tokens: 26502,
      output_tokens: 3,
      cache_creation_tokens: null, // opencode does not report cache tokens separately
      cache_read_tokens: null,
      total_cost_usd: 0.03771504,
      result_text: 'OK',
    });
  });

  it('concatenates text parts in order and sums tokens/cost across steps', () => {
    const stdout = [
      stepStart,
      textEvent('first '),
      stepFinish(100, 10, 0.01),
      textEvent('second'),
      stepFinish(50, 5, 0.02),
    ].join('\n');

    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      model: null,
      input_tokens: 150,
      output_tokens: 15,
      total_cost_usd: 0.03,
      result_text: 'first second',
    });
  });

  it('tolerates blank lines between events', () => {
    const stdout = `\n${textEvent('OK')}\n\n${stepFinish(1, 2, 0.5)}\n\n`;

    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      input_tokens: 1,
      output_tokens: 2,
      total_cost_usd: 0.5,
    });
  });

  it('reports null usage fields when no step_finish reported numbers', () => {
    const stdout = [stepStart, textEvent('no usage')].join('\n');

    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      model: null,
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
      result_text: 'no usage',
    });
  });

  it('reports null result_text when no text parts arrived', () => {
    const stdout = [stepStart, stepFinish(1, 1, 0.1)].join('\n');

    expect(parseOpenCodeUsage(stdout)).toMatchObject({ result_text: null });
  });

  it('returns null when any line is not JSON (not an opencode event stream)', () => {
    const stdout = [stepStart, 'plain text', stepFinish(1, 1, 0.1)].join('\n');
    expect(parseOpenCodeUsage(stdout)).toBeNull();
  });

  it('returns null for empty or undefined stdout', () => {
    expect(parseOpenCodeUsage('')).toBeNull();
    expect(parseOpenCodeUsage('   ')).toBeNull();
    expect(parseOpenCodeUsage(undefined)).toBeNull();
    expect(parseOpenCodeUsage(null)).toBeNull();
  });

  it('ignores non-numeric token/cost values instead of recording NaN', () => {
    const stdout = [
      event({
        type: 'step_finish',
        part: { type: 'step-finish', tokens: { input: 'many', output: null }, cost: 'cheap' },
      }),
    ].join('\n');

    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
    });
  });
});
