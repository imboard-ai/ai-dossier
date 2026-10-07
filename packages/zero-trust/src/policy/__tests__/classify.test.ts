import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, ReceiptError } from '../../receipt/schema';
import { assertNoSecrets } from '../../redaction';
import { classifyPolicy, policyDigest } from '../classify';
import { type PolicyFile, PolicyInputError } from '../discover';
import { POLICY_RULES } from '../rules';

function policyFile(content: string, path = 'CONTRIBUTING.md'): PolicyFile {
  const bytes = Buffer.from(content);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { path, sha, content };
}

const fixtureRoot = resolve('fixtures/policy');
const fixtures = readdirSync(fixtureRoot)
  .filter((path) => path.endsWith('.json'))
  .sort()
  .map((path) => ({
    name: path,
    ...(JSON.parse(readFileSync(resolve(fixtureRoot, path), 'utf8')) as {
      files: Record<string, string>;
      expected: object;
      actor: string;
      slice: string;
      expectedOutcome: string;
    }),
  }));

describe('synthetic policy fixtures', () => {
  it('provides at least fifteen independently named synthetic cases', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    expect(new Set(POLICY_RULES.map((r) => r.id)).size).toBe(POLICY_RULES.length);
    expect(Object.isFrozen(POLICY_RULES)).toBe(true);
    expect(POLICY_RULES.every(Object.isFrozen)).toBe(true);
  });
  it.each(fixtures)('$name', ({ files, expected, actor, slice, expectedOutcome }) => {
    expect(['hostile_repository', 'upstream_maintainer']).toContain(actor);
    expect(slice).toBe('S2');
    expect(expectedOutcome.length).toBeGreaterThan(0);
    const input = Object.entries(files).map(([path, content]) => policyFile(content, path));
    const { citations, ...assessment } = classifyPolicy(input);
    expect(assessment).toEqual(expected);
    for (const citation of citations) {
      const file = input.find((f) => f.path === citation.path);
      expect(file).toBeDefined();
      expect(citation.excerpt).toBe(file?.content.split(/\r\n|\n|\r/u)[citation.line - 1]);
      expect(POLICY_RULES.some((r) => r.id === citation.ruleId)).toBe(true);
      expect(() => assertNoSecrets(citation.excerpt)).not.toThrow();
    }
  });
});

describe('classification and digest boundaries', () => {
  it.each([
    'AI-generated contributions are not   allowed.',
    'AI contributions are not\taccepted.',
    'LLM contributions are never allowed.',
    'We never accept AI contributions.',
    'We do not normally accept AI contributions.',
  ])('never grants negated AI permission: %s', (content) => {
    expect(['banned', 'unclear']).toContain(classifyPolicy([policyFile(content)]).ai);
  });
  it.each([
    '.',
    ';',
    ', but',
    '\n',
  ])('detects independent same-line AI caveats separated by %s', (separator) => {
    expect(
      classifyPolicy([
        policyFile(`AI is welcome${separator} AI rules depend on committee judgment.`),
      ]).ai
    ).toBe('unclear');
  });
  it('does not swallow a second AI assertion inside one matching gap', () => {
    expect(
      classifyPolicy([policyFile('AI is welcome and AI contributions must have written consent.')])
        .ai
    ).toBe('unclear');
  });
  it('never treats negated direct-PR permission as assignment silence', () => {
    expect(classifyPolicy([policyFile('Do not feel free to open a PR.')])).toMatchObject({
      directPr: 'unclear',
      assignment: 'unclear',
    });
  });
  it('recognizes assigned-issue requirements and keeps unknown assignment prose uncertain', () => {
    expect(
      classifyPolicy([
        policyFile('Direct PRs are welcome.\nYou must get an issue assigned before contributing.'),
      ]).assignment
    ).toBe('required');
    expect(
      classifyPolicy([
        policyFile('Direct PRs are welcome.\nAssignment depends on committee approval.'),
      ]).assignment
    ).toBe('unclear');
    expect(
      classifyPolicy([
        policyFile('It is false that assignment is optional. Direct PRs are welcome.'),
      ]).assignment
    ).toBe('unclear');
  });
  it.each([
    'No baseline failures are permitted.',
    'Baseline failures are allowed.\nBaseline failures are not allowed.',
    'Baseline failures are allowed only in examples.',
  ])('refuses negated, conditional or conflicting baseline permissions: %s', (content) => {
    expect(classifyPolicy([policyFile(content)]).baselineFailuresPermitted).toBe(false);
  });
  it('does not grant baseline permission across a conflicting second file', () => {
    expect(
      classifyPolicy([
        policyFile('Baseline failures are allowed.'),
        policyFile('Baseline failures are forbidden.', 'AI_POLICY.md'),
      ]).baselineFailuresPermitted
    ).toBe(false);
  });
  it('keeps the outer README contribution scope across nested matching headings', () => {
    const a = classifyPolicy([
      policyFile(
        '## Contributing\nAI is welcome.\n### Contribution workflow\nRun tests.\n### Restrictions\nAI contributions are banned.\n## Usage\nAI is welcome.',
        'README.md'
      ),
    ]);
    expect(a.ai).toBe('unclear');
    expect(a.citations.find((c) => c.ruleId === 'ai-ban-1')?.line).toBe(6);
  });
  it('continues classification when the first opposing statement follows the citation cap', () => {
    const text =
      'AI is banned.\nDo not use AI.\nAssignment is required.\nAssignment is optional.\nDirect PRs are welcome.\nDiscuss changes before PRs.\nDraft PRs are required.\nNo extra sections.\nBaseline failures are allowed.';
    const files = Array.from({ length: 15 }, (_, n) =>
      policyFile(text, `.github/PULL_REQUEST_TEMPLATE/${String(n).padStart(2, '0')}.md`)
    );
    files.push(policyFile('AI is welcome.', '.github/PULL_REQUEST_TEMPLATE/zzz.md'));
    const a = classifyPolicy(files);
    expect(a.citations).toHaveLength(128);
    expect(a.ai).toBe('unclear');
    expect(classifyPolicy([...files].reverse())).toEqual(a);
    expect(policyDigest(a, [...files].reverse())).toBe(policyDigest(a, files));
  });
  it('digests accepted snapshots at worst-case escaped citation size', () => {
    const text = [
      'AI is banned.',
      'AI requires approval.',
      'AI disclosure required.',
      'Assignment is required.',
      'Assignment is optional.',
      'Direct PRs are welcome.',
      'Discuss changes before PRs.',
      'Draft PRs are required.',
      'No extra sections.',
      'Baseline failures are allowed.',
    ]
      .map((line) => `${line} ${'\u0001'.repeat(200)}`)
      .join('\n');
    const files = Array.from({ length: 20 }, (_, n) =>
      policyFile(text, `.github/PULL_REQUEST_TEMPLATE/${n}.md`)
    );
    const a = classifyPolicy(files);
    expect(a.citations).toHaveLength(128);
    expect(policyDigest(a, files)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => canonicalJson('x', 0)).toThrow(ReceiptError);
    expect(() => canonicalJson('x', 1024 * 1024 + 1)).toThrow(ReceiptError);
  });
  it('cites the scenario 1 ban at its original line', () => {
    const a = classifyPolicy([policyFile('# Contributions\n\nLLM contributions are banned.')]);
    expect(a.ai).toBe('banned');
    expect(a.citations).toContainEqual({
      path: 'CONTRIBUTING.md',
      line: 3,
      ruleId: 'ai-ban-1',
      excerpt: 'LLM contributions are banned.',
    });
  });
  it('is case insensitive and preserves CRLF line numbers', () => {
    expect(classifyPolicy([policyFile('\r\nAi-GENERATED contributions are BANNED.')]).ai).toBe(
      'banned'
    );
    expect(
      classifyPolicy([policyFile('\r\nAi-GENERATED contributions are BANNED.')]).citations[0].line
    ).toBe(2);
  });
  it('redacts entire secret-bearing lines, even when the secret follows the excerpt cap', () => {
    const secret = ['ghp', '_syntheticOnly'].join('');
    const a = classifyPolicy([policyFile(`AI is banned. ${'x'.repeat(220)} ${secret}`)]);
    expect(a.citations[0].excerpt).toBe('[redacted]');
    expect(JSON.stringify(a)).not.toContain(secret);
    const long = classifyPolicy([policyFile(`AI is banned. ${'x'.repeat(220)}`)]);
    expect(long.citations[0].excerpt.length).toBe(200);
  });
  it('binds sorted assessment keys, citations and all file blob identities', () => {
    const files = [policyFile('AI is banned.'), policyFile('AI is welcome.', 'AI_POLICY.md')];
    const a = classifyPolicy(files);
    expect(classifyPolicy([...files].reverse())).toEqual(a);
    const digest = policyDigest(a, files);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      policyDigest({ ...a, citations: [...a.citations].reverse() }, [...files].reverse())
    ).toBe(digest);
    expect(policyDigest({ ...a, draftRequired: true }, files)).not.toBe(digest);
    expect(policyDigest(a, [{ ...files[0], sha: 'a'.repeat(40) }, files[1]])).not.toBe(digest);
  });
  it('restricts README to contribution sections including nested and setext headings', () => {
    const input =
      'AI is welcome.\nContributing\n------------\nAI is banned.\n### Details\nAssignment is required.\n## Usage\nAI is welcome.';
    const a = classifyPolicy([policyFile(input, 'README.md')]);
    expect(a.ai).toBe('banned');
    expect(a.assignment).toBe('required');
    expect(a.citations.find((c) => c.ruleId === 'ai-ban-1')?.line).toBe(4);
    expect(
      classifyPolicy([
        policyFile('Contributing\n============\nDirect PRs are welcome.', 'README.md'),
      ]).directPr
    ).toBe('welcomed');
    expect(
      classifyPolicy([policyFile('```\n## Contributing\nAI is welcome.\n```', 'README.md')]).ai
    ).toBe('silent');
  });
  it('does not let an unrecognized AI caveat become permissive', () => {
    expect(
      classifyPolicy([policyFile('AI is welcome.\nAI rules depend on approval by committee.')]).ai
    ).toBe('unclear');
    expect(classifyPolicy([policyFile('# AI Policy\nAI is welcome.')]).ai).toBe('welcomed');
    expect(classifyPolicy([])).toMatchObject({
      ai: 'silent',
      assignment: 'unclear',
      directPr: 'unclear',
      baselineFailuresPermitted: false,
    });
  });
  it('bounds citations without skipping later conflicts or digesting raw secrets', () => {
    const paths = Array.from({ length: 20 }, (_, n) => `.github/PULL_REQUEST_TEMPLATE/${n}.md`);
    const text =
      'AI is banned.\nAI requires approval.\nAI disclosure required.\nAssignment is required.\nAssignment is optional.\nDirect PRs are welcome.\nDiscuss changes before PRs.\nDraft PRs are required.\nNo extra sections.\nBaseline failures are allowed.';
    const files = paths.map((path) => policyFile(text, path));
    const a = classifyPolicy(files);
    expect(a.citations.length).toBe(128);
    expect(a.ai).toBe('unclear');
    expect(policyDigest(a, files)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each([
    [policyFile('safe', '../CONTRIBUTING.md')],
    [{ ...policyFile('safe'), sha: 'bad' }],
    [policyFile('\ud800')],
    [policyFile('x'.repeat(256 * 1024 + 1))],
    [policyFile('a'), policyFile('b')],
    Array.from({ length: 35 }, (_, n) => policyFile('', `.github/PULL_REQUEST_TEMPLATE/${n}.md`)),
    Array.from({ length: 5 }, (_, n) =>
      policyFile('x'.repeat(256 * 1024), `.github/PULL_REQUEST_TEMPLATE/${n}.md`)
    ),
  ])('rejects invalid direct snapshots %#', (...files) => {
    expect(() => classifyPolicy(files)).toThrow(PolicyInputError);
  });
  it('keeps hostile long-line scanning bounded', () => {
    const start = Date.now();
    expect(classifyPolicy([policyFile('a.'.repeat(100000))]).ai).toBe('silent');
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
