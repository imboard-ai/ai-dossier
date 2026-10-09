import { expect, it } from 'vitest';
import { parsePortfolio } from './portfolio';

it('projects only actual disclosure and citations', () => {
  expect(
    parsePortfolio(
      {
        runId: 'run',
        disclosure: 'LLM assisted',
        policyCitations: [
          {
            path: 'POLICY.md',
            line: 2,
            ruleId: 'disclose',
            excerpt: 'Disclose assistance.',
            internal: 'omitted',
          },
        ],
      },
      'run'
    )
  ).toEqual({
    disclosure: 'LLM assisted',
    policyCitations: [
      { path: 'POLICY.md', line: 2, ruleId: 'disclose', excerpt: 'Disclose assistance.' },
    ],
  });
});
it.each([
  {},
  { runId: 'run', disclosure: 'text' },
  { runId: 'run', policyCitations: [] },
  { runId: 'foreign', disclosure: 'text', policyCitations: [] },
  { runId: 'run', disclosure: 'text', policyCitations: [{}] },
])('present malformed portfolio never falls back to missing/null', (raw) => {
  expect(() => parsePortfolio(raw, 'run')).toThrow();
});
