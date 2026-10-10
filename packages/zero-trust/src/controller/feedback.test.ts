import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import { createLlmDecisionProvider } from '../decision/providers/llm';
import { ScriptedModel } from '../model/__tests__/scripted-model';
import type { ModelResult } from '../model/adapter';
import { assessRevisionFeedback } from './feedback';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const feedback = {
  id: 'comment:1',
  author: 'maintainer',
  updatedAt: '2026-10-10T00:00:00Z',
  url: 'https://github.com/o/r/pull/1#issuecomment-1',
  body: 'Please cover rounding in the duration test.',
};
function deps(values: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-feedback-'));
  dirs.push(dir);
  const rates: BudgetRate[] = [
    {
      resource: 'fixture',
      currency: 'USD',
      unit: 'token',
      price: 0,
      units: 1,
      source: 'fixture',
      fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: feedback.updatedAt },
    },
  ];
  const ledger = new BudgetLedger(path.join(dir, 'ledger.json'), 'contribution');
  ledger.initialize(['fixture'], rates);
  ledger.startSession({
    id: 's2',
    ceiling: { currency: 'USD', minor: 100 },
    cleanupAllowance: 0,
    tokenLimit: 100000,
    timeLimitMs: 100000,
  });
  const model = new ScriptedModel(
    'fixture',
    values.map(
      (value): ModelResult => ({
        kind: 'tool_calls',
        calls: [
          {
            id: 'decision',
            name: 'report_decision',
            arguments: {
              value,
              citations: [{ sourceId: feedback.id, line: 1, quote: feedback.body }],
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      })
    )
  );
  return {
    provider: createLlmDecisionProvider({ adapter: model }),
    budget: { ledger, sessionId: 's2', rates },
  };
}
it.each([
  [true, true, true],
  [false, false, false],
  [true, false, false],
  ['yes', 'yes', false],
])('admits only confident typed agreement (%s, %s)', async (first, second, admitted) => {
  const result = await assessRevisionFeedback(
    [feedback],
    { title: 'Duration rounding', body: 'Fix conversion.' },
    'Add duration tests.',
    deps([first, second])
  );
  expect(result.admitted).toBe(admitted);
});
it('empty and blank feedback cannot grant revision permission', async () => {
  for (const items of [[], [{ ...feedback, body: '' }]]) {
    const result = await assessRevisionFeedback(
      items,
      { title: 'Duration', body: 'Fix.' },
      'Test.',
      deps([true, true])
    );
    expect(result.admitted).toBe(false);
  }
});
