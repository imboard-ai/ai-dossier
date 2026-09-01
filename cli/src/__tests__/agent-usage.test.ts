/**
 * Smoke test only — `parseAgentUsage`/`parseOpenCodeUsage` moved to
 * `@ai-dossier/core` (#524) and re-export from `../helpers` for backward
 * compatibility. The exhaustive parsing suite lives at
 * `packages/core/src/__tests__/agent-usage.test.ts` now; this file only
 * confirms the re-export is wired correctly.
 */
import { describe, expect, it } from 'vitest';
import { parseAgentUsage, parseOpenCodeUsage } from '../helpers';

describe('parseAgentUsage (re-export smoke test)', () => {
  it('parses modelUsage as the source of record', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-opus-4-20250514': { inputTokens: 7, outputTokens: 3, totalCostUsd: 0.5 },
      },
    });

    expect(parseAgentUsage(stdout)).toMatchObject({
      model: 'claude-opus-4-20250514',
      input_tokens: 7,
      output_tokens: 3,
      total_cost_usd: 0.5,
    });
  });

  it('returns null for non-JSON output', () => {
    expect(parseAgentUsage('plain text output\n')).toBeNull();
  });
});

describe('parseOpenCodeUsage (re-export smoke test)', () => {
  it('parses a JSONL event stream', () => {
    const stepFinish = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 26502, output: 3 }, cost: 0.03771504 },
    });

    expect(parseOpenCodeUsage(stepFinish)).toMatchObject({
      input_tokens: 26502,
      output_tokens: 3,
      total_cost_usd: 0.03771504,
    });
  });

  it('returns null for empty stdout', () => {
    expect(parseOpenCodeUsage('')).toBeNull();
  });
});
