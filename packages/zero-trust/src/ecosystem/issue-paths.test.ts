import { describe, expect, it } from 'vitest';
import { issueEcosystem } from './issue-paths';

describe('issueEcosystem: the side every named source path belongs to (#1276)', () => {
  it.each<[string, string, string, 'node' | 'python' | undefined]>([
    ['Python-only paths', 'Crash in parser', 'See `packages/core/src/x/parse.py:12`.', 'python'],
    ['Python manifests', 'Bump pytest', 'pyproject.toml and uv.lock pin it.', 'python'],
    ['bare Python file', 'test_api.py fails', '', 'python'],
    [
      'Node-only paths',
      'Fix src/index.ts',
      'Also touches `lib/util.mjs` and package.json.',
      'node',
    ],
    ['both sides', 'Mismatch', 'saleor/core/models.py vs dashboard/src/api.tsx', undefined],
    ['nothing named', 'Duration uses wrong units', 'Convert milliseconds into seconds.', undefined],
    [
      'prose suffixes are not paths',
      'Breaks under Node.js',
      'In app/views.py, see Vue.js docs',
      'python',
    ],
    ['a path with a capitalized name', 'Fix', 'web/Components/Button.tsx', 'node'],
    ['URL path', 'Bug', 'https://github.com/o/r/blob/main/pkg/mod.py#L3', 'python'],
    ['trailing punctuation', 'Bug', 'The fix belongs in models.py.', 'python'],
    ['unrelated extensions', 'Docs', 'README.md, setup.cfg, Makefile, style.css', undefined],
  ])('%s', (_label, title, body, expected) => {
    expect(issueEcosystem(title, body)).toBe(expected);
  });

  it('reads title and body together', () => {
    expect(issueEcosystem('Fix api.py', 'and web/app.ts')).toBeUndefined();
  });

  it('is bounded and never echoes the text', () => {
    const huge = `${'a'.repeat(300)}.py ${'x '.repeat(200000)} late.ts`;
    // The over-long token is ignored, and text past the scan bound is never read.
    expect(issueEcosystem(huge)).toBeUndefined();
    expect(issueEcosystem(`ok.py ${'x '.repeat(200000)} late.ts`)).toBe('python');
  });

  it('ignores non-string input', () => {
    expect(issueEcosystem(undefined as unknown as string, 'a.py')).toBe('python');
  });
});
