import { describe, expect, it } from 'vitest';
import {
  parseAgentUsage,
  parseLastToolUse,
  parseOpenCodeUsage,
  SCHED_DISPATCH_EVENT,
  usageParserFor,
} from '../agent-usage';

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
      // The fixture's step reports `cache: {write: 0, read: 0}` — a real
      // reported zero, surfaced as 0 rather than null (#524 review).
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
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

  it('skips a non-JSON line mid-stream rather than discarding the run (#524 review)', () => {
    // Was: "any non-JSON line disqualifies the stream". That asserted exactly
    // the silent-null AC2 forbids — the scheduler merges stderr into the same
    // fd, so one warning line is normal, not a format mismatch.
    const stdout = [stepStart, 'plain text', stepFinish(1, 1, 0.1)].join('\n');
    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      input_tokens: 1,
      output_tokens: 1,
      total_cost_usd: 0.1,
    });
  });

  it('returns null when NO line is a valid opencode event (a genuine format mismatch)', () => {
    expect(parseOpenCodeUsage(['plain text', 'more text'].join('\n'))).toBeNull();
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

describe('parseAgentUsage — untrusted-input hardening (#524)', () => {
  it('rejects negative token/cost values rather than recording them', () => {
    const stdout = JSON.stringify({
      type: 'result',
      total_cost_usd: -5,
      usage: { input_tokens: -100, output_tokens: 20 },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: null,
      output_tokens: 20,
      total_cost_usd: null,
    });
  });

  it('rejects a negative sum from modelUsage entries', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: { 'claude-opus-4': { inputTokens: -1, outputTokens: 5 } },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({ input_tokens: null, output_tokens: 5 });
  });

  it('strips control characters from an untrusted model field and caps its length', () => {
    const stdout = JSON.stringify({
      type: 'result',
      model: `claude\x1b[31msonnet${'x'.repeat(300)}`,
    });

    const usage = parseAgentUsage(stdout);
    expect(usage?.model).not.toBeNull();
    expect(usage?.model?.includes('\x1b')).toBe(false);
    expect(usage?.model?.length).toBeLessThanOrEqual(200);
  });
});

/**
 * #524 root cause: `claude -p --output-format json` buffers the whole session
 * and writes one object at exit, so a dispatch killed while still running
 * (the scheduler's external-advance branch) left a 0-byte log and no tokens —
 * six of the eleven batch-pilot units. The scheduler dispatches with
 * `stream-json` now; these cases pin the parsing that makes that recoverable.
 */
describe('parseAgentUsage — stream-json (sched dispatch format, #524)', () => {
  const preamble = JSON.stringify({
    type: SCHED_DISPATCH_EVENT,
    ts: '2026-09-01T10:00:00.000Z',
    cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
  });

  const assistant = (input: number, output: number, model = 'claude-sonnet-4-5') =>
    JSON.stringify({
      type: 'assistant',
      message: {
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    });

  const resultEvent = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 999, output_tokens: 999 },
    modelUsage: {
      'claude-sonnet-4-5': {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
        totalCostUsd: 1.25,
      },
    },
  });

  it('reads the final result event and still lets modelUsage beat the top-level usage block', () => {
    const log = [preamble, assistant(1, 2), resultEvent].join('\n');

    expect(parseAgentUsage(log)).toMatchObject({
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_tokens: 30,
      cache_read_tokens: 40,
      total_cost_usd: 1.25,
      model: 'claude-sonnet-4-5',
    });
  });

  it('sums per-turn assistant usage when the run was KILLED before emitting a result event', () => {
    // The 6-of-11 case: ground truth said done, the agent was killed, no
    // result event was ever written. Tokens spent so far must still be
    // recorded rather than reported as null.
    const log = [preamble, assistant(5, 50), assistant(7, 70)].join('\n');

    expect(parseAgentUsage(log)).toMatchObject({
      input_tokens: 12,
      output_tokens: 120,
      cache_creation_tokens: 20,
      cache_read_tokens: 40,
      // Per-turn events carry no cost — never fabricated from token counts.
      total_cost_usd: null,
      model: 'claude-sonnet-4-5',
    });
  });

  it('takes the LAST result event, so a prior dispatch in the same append-mode log cannot win', () => {
    const earlier = JSON.stringify({
      type: 'result',
      modelUsage: { 'claude-haiku-4-5': { inputTokens: 1, outputTokens: 1 } },
    });
    expect(parseAgentUsage([earlier, preamble, resultEvent].join('\n'))).toMatchObject({
      input_tokens: 100,
      output_tokens: 200,
    });
  });

  it('survives a truncated final line from an agent killed mid-write', () => {
    const log = [preamble, assistant(5, 50), '{"type":"assist'].join('\n');
    expect(parseAgentUsage(log)).toMatchObject({ input_tokens: 5, output_tokens: 50 });
  });

  it('returns null for a log holding only the sched preamble (the agent wrote nothing)', () => {
    expect(parseAgentUsage(preamble)).toBeNull();
    expect(parseOpenCodeUsage(preamble)).toBeNull();
  });

  it('joins models when a stream ran several, without a result event', () => {
    const log = [
      preamble,
      assistant(1, 2, 'claude-opus-4'),
      assistant(3, 4, 'claude-haiku-4'),
    ].join('\n');
    expect(parseAgentUsage(log)?.model).toBe('claude-opus-4,claude-haiku-4');
  });
});

/**
 * #524 review findings — the cost key claude actually writes, and the
 * hardening around untrusted numbers/strings.
 */
describe('parseAgentUsage — review hardening (#524)', () => {
  it('reads cost from modelUsage `costUSD`, the key claude really emits', () => {
    const stdout = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.4839,
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: 1200,
          outputTokens: 340,
          cacheCreationInputTokens: 800,
          cacheReadInputTokens: 50000,
          costUSD: 0.4839,
        },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: 1200,
      output_tokens: 340,
      total_cost_usd: 0.4839,
    });
  });

  it('falls back to the top-level cost when modelUsage reports no cost key at all', () => {
    // Tokens still come from modelUsage; only the whole-run cost falls back,
    // so this is not a per-field blend of two disagreeing token blocks.
    const stdout = JSON.stringify({
      type: 'result',
      total_cost_usd: 2.5,
      modelUsage: { 'claude-sonnet-4-5': { inputTokens: 10, outputTokens: 20 } },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      total_cost_usd: 2.5,
    });
  });

  it('parses a ONE-LINE stream event as a stream, not as a result payload', () => {
    // A dispatch killed after a single turn, or one whose preamble write
    // failed, leaves exactly one line. The old fast path reported all-null.
    const oneLine = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 50 } },
    });

    expect(parseAgentUsage(oneLine)).toMatchObject({ input_tokens: 5, output_tokens: 50 });
  });

  it('returns null for a lone system event rather than an all-null result object', () => {
    expect(parseAgentUsage(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });

  it('rejects absurd token counts and costs instead of letting them reach a cohort total', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: { m: { inputTokens: 1e308, outputTokens: 5, costUSD: 1e308 } },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      input_tokens: null,
      output_tokens: 5,
      total_cost_usd: null,
    });
  });

  it('strips C1 control characters, not just C0 and DEL', () => {
    // U+009B is the 8-bit CSI — a terminal acts on it exactly like ESC[.
    const usage = parseAgentUsage(
      JSON.stringify({ type: 'result', model: 'claude\u009b31msonnet' })
    );
    expect(usage?.model).toBe('claude31msonnet');
  });

  it('caps a pathologically long model name without materializing it whole', () => {
    const usage = parseAgentUsage(JSON.stringify({ type: 'result', model: 'x'.repeat(5_000_000) }));
    expect(usage?.model?.length).toBe(200);
  });

  it('bounds the number of model names joined into one model field', () => {
    const modelUsage: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) modelUsage[`model-${i}`] = { inputTokens: 1 };
    const usage = parseAgentUsage(JSON.stringify({ type: 'result', modelUsage }));
    expect(usage?.model?.split(',')).toHaveLength(16);
  });
});

describe('usageParserFor', () => {
  it('routes the opencode binary (any path) to parseOpenCodeUsage', () => {
    expect(usageParserFor('opencode')).toBe(parseOpenCodeUsage);
    expect(usageParserFor('/usr/local/bin/opencode')).toBe(parseOpenCodeUsage);
  });

  it('routes claude, and any unrecognized command, to parseAgentUsage', () => {
    expect(usageParserFor('claude')).toBe(parseAgentUsage);
    expect(usageParserFor('some-other-agent-cli')).toBe(parseAgentUsage);
  });
});

/**
 * #524 review: opencode DOES report cache counts, nested one level down as
 * `tokens.cache: { write, read }`. Verified against a real 310-event dispatch
 * log carrying 47,485,120 cache-read tokens that the parser previously
 * dropped on the mistaken belief they were unavailable.
 */
describe('parseOpenCodeUsage — cache tokens (#524 review)', () => {
  const step = (input: number, output: number, write: number, read: number) =>
    JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        tokens: { total: input + output, input, output, reasoning: 0, cache: { write, read } },
        cost: 0.5,
      },
    });

  it('sums tokens.cache.write / tokens.cache.read across steps', () => {
    expect(
      parseOpenCodeUsage([step(100, 10, 5, 64), step(200, 20, 7, 128)].join('\n'))
    ).toMatchObject({
      input_tokens: 300,
      output_tokens: 30,
      cache_creation_tokens: 12,
      cache_read_tokens: 192,
      total_cost_usd: 1,
    });
  });

  it('leaves cache fields null when the step genuinely omits the cache block', () => {
    const noCache = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 5, output: 6 }, cost: 0.1 },
    });
    expect(parseOpenCodeUsage(noCache)).toMatchObject({
      input_tokens: 5,
      cache_creation_tokens: null,
      cache_read_tokens: null,
    });
  });
});

/**
 * #524 review: `createSpawnDeps` merges stderr into the dispatch log's fd, so
 * opencode's ANSI-coloured warnings land between JSON events. One such line
 * used to null out an entire run's tokens and cost.
 */
describe('parseOpenCodeUsage - stderr interleaved with the event stream (#524 review)', () => {
  const step = (input: number, output: number) =>
    JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        tokens: { input, output, cache: { write: 0, read: 100 } },
        cost: 1.5,
      },
    });
  // The real shape observed in two dispatch logs on the pilot host.
  const stderrWarning =
    '\u001b[93m\u001b[1m! \u001b[0mpermission requested: external_directory (/tmp); auto-rejecting';

  it('skips a non-JSON stderr line instead of discarding the whole run', () => {
    const stdout = [step(1000, 100), stderrWarning, step(2000, 200)].join('\n');

    expect(parseOpenCodeUsage(stdout)).toMatchObject({
      input_tokens: 3000,
      output_tokens: 300,
      cache_read_tokens: 200,
      total_cost_usd: 3,
    });
  });

  it('still returns null when the output holds no opencode event at all', () => {
    // Format-mismatch detection must survive the change above.
    expect(parseOpenCodeUsage([stderrWarning, 'not json either'].join('\n'))).toBeNull();
  });
});

/**
 * #591 — attributes an unverified exit (`agent-exited-unverified` /
 * `unverified-exit-at-strongest-tier`) to the last tool the agent called, without
 * opening the transcript.
 */
describe('parseLastToolUse', () => {
  const assistantWithTools = (...toolNames: string[]) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking...' },
          ...toolNames.map((name) => ({ type: 'tool_use', id: 't1', name, input: {} })),
        ],
      },
    });

  const assistantTextOnly = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'no tools this turn' }] },
  });

  it('returns null for null/undefined/empty input', () => {
    expect(parseLastToolUse(null)).toBeNull();
    expect(parseLastToolUse(undefined)).toBeNull();
    expect(parseLastToolUse('')).toBeNull();
    expect(parseLastToolUse('   ')).toBeNull();
  });

  it('returns the only tool_use name in a single-turn stream', () => {
    const stdout = assistantWithTools('Bash');
    expect(parseLastToolUse(stdout)).toBe('Bash');
  });

  it('returns the LAST tool_use across multiple turns, not the first', () => {
    const stdout = [assistantWithTools('Bash'), assistantWithTools('Monitor')].join('\n');
    expect(parseLastToolUse(stdout)).toBe('Monitor');
  });

  it('a later turn with no tool_use does not erase an earlier one', () => {
    const stdout = [assistantWithTools('Monitor'), assistantTextOnly].join('\n');
    expect(parseLastToolUse(stdout)).toBe('Monitor');
  });

  it('returns the last of several tool_use blocks within the SAME turn', () => {
    const stdout = assistantWithTools('Read', 'Bash', 'Monitor');
    expect(parseLastToolUse(stdout)).toBe('Monitor');
  });

  it('returns null when no tool_use block appears anywhere', () => {
    const stdout = [assistantTextOnly, assistantTextOnly].join('\n');
    expect(parseLastToolUse(stdout)).toBeNull();
  });

  it('strips control characters from an adversarial tool name (#591 — CWE-117/150 parity with sanitizeModel)', () => {
    const adversarial = `Monitor${String.fromCharCode(0x1b)}[2K${String.fromCharCode(0x0d)}<forged line>`;
    const stdout = assistantWithTools(adversarial);
    expect(parseLastToolUse(stdout)).toBe('Monitor[2K<forged line>');
  });

  it('caps an unbounded tool name at MAX_TOOL_NAME_LENGTH (100 chars)', () => {
    const stdout = assistantWithTools('x'.repeat(500));
    expect(parseLastToolUse(stdout)).toHaveLength(100);
  });

  it('skips the SCHED_DISPATCH_EVENT preamble and unparseable lines, like parseAgentUsage', () => {
    const preamble = JSON.stringify({ type: SCHED_DISPATCH_EVENT, ts: '2026-09-02T10:00:00Z' });
    const stdout = [preamble, 'not json', assistantWithTools('Monitor'), ''].join('\n');
    expect(parseLastToolUse(stdout)).toBe('Monitor');
  });

  it('ignores non-assistant events (e.g. the terminal result event)', () => {
    const resultEvent = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
    const stdout = [assistantWithTools('Monitor'), resultEvent].join('\n');
    expect(parseLastToolUse(stdout)).toBe('Monitor');
  });
});
