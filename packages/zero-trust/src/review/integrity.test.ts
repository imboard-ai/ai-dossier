import { describe, expect, it } from 'vitest';
import {
  createManifest,
  parentPaths,
  type SourceEntry,
  type SourceManifest,
  sha256,
} from '../canonical/export';
import { parseJunitReport } from '../ecosystem/report';
import { type IntegrityCode, type ReviewCandidateInput, reviewCandidate } from '../index';

function manifest(files: Record<string, string | Buffer>, executable?: string) {
  const entries = new Map<string, SourceEntry>();
  for (const [path, content] of Object.entries(files)) {
    for (const parent of parentPaths(path))
      entries.set(parent, { path: parent, mode: '040000', bytes: '', sha256: sha256('') });
    const bytes = Buffer.from(content);
    entries.set(path, {
      path,
      mode: path === executable ? '100755' : '100644',
      bytes: bytes.toString('base64'),
      sha256: sha256(bytes),
    });
  }
  return createManifest([...entries.values()]);
}
const success = parseJunitReport(
  Buffer.from(
    '<testsuites><testsuite><testcase name="one"/><testcase name="two"/></testsuite></testsuites>'
  )
);
function input(before: Record<string, string | Buffer> = {}, after = before): ReviewCandidateInput {
  return {
    baseManifest: manifest(before),
    candidateManifest: manifest(after),
    baseDiscovery: success,
    candidateDiscovery: success,
  };
}
function codes(value: ReviewCandidateInput): IntegrityCode[] {
  return reviewCandidate(value).findings.map((finding) => finding.code);
}
const testPaths = [
  'test/a.ts',
  'tests/a.ts',
  '__tests__/a.ts',
  'nested/tests/a.ts',
  'a.test.ts',
  'a.spec.js',
  'test_a.py',
  'a_test.py',
  'test_.py',
  'nested/test_.py',
  'a.test.',
  'nested/a.spec.',
];
const markers = [
  'it.skip(',
  'describe.skip(',
  'test.skip(',
  'xit(',
  'xdescribe(',
  'test.only(',
  'it.todo(',
  '@pytest.mark.skip',
  '@pytest.mark.xfail',
  'pytest.skip(',
  '@unittest.skip',
  'unittest.skipIf',
  'unittest.skipUnless',
];
const configs = [
  'package.json',
  'package-lock.json',
  'pyproject.toml',
  'uv.lock',
  'requirements.txt',
  'requirements-dev.txt',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'pytest.ini',
  'conftest.py',
  'jest.config.js',
  'vitest.config.ts',
  'jest.config.',
  'nested/vitest.config.',
  '.mocharc.yml',
  'Makefile',
  '.github/workflows/test.yml',
  'Dockerfile',
  '.devcontainer/config.json',
  '.gitattributes',
];

describe('deterministic candidate scope/test integrity', () => {
  it('AC3: one source repair and one new regression test passes (negative for every code)', () => {
    const value = input(
      { 'src/add.ts': 'return a - b;\n' },
      { 'src/add.ts': 'return a + b;\n', 'tests/add.test.ts': 'expect(add(1, 2)).toBe(3);\n' }
    );
    expect(reviewCandidate(value)).toEqual({ verdict: 'pass', findings: [] });
  });
  it('AC2 / PRD scenario 15 / developer / S3: correct target plus dishonest tests hands off despite success', () => {
    const value = input(
      {
        'add.ts': 'return a - b;\n',
        'add.test.ts': 'it("adds", () => {\nexpect(add(1,2)).toBe(3);\n});\n',
      },
      { 'add.ts': 'return a + b;\n', 'add.test.ts': 'it.skip("adds", () => {\n});\n' }
    );
    expect(value.baseDiscovery?.failures).toBe(0);
    expect(value.candidateDiscovery?.failures).toBe(0);
    expect(reviewCandidate(value)).toEqual({
      verdict: 'hand_off',
      findings: [
        {
          code: 'test_disabled',
          path: 'add.test.ts',
          detail: 'Test disabling, focus or todo marker added.',
        },
        {
          code: 'assertions_reduced',
          path: 'add.test.ts',
          detail: 'Test assertion count decreased.',
        },
      ],
    });
  });
  it.each(testPaths)('removed or renamed test %s is detected', (path) => {
    expect(codes(input({ [path]: 'expect(1);' }, {}))).toContain('test_deleted');
    expect(codes(input({ [path]: 'expect(1);' }, { 'renamed.ts': 'expect(1);' }))).toContain(
      'test_deleted'
    );
    expect(codes(input({ [path]: 'expect(1);' }, { [path]: 'expect(2);' }))).not.toContain(
      'test_deleted'
    );
  });
  it.each(markers)('added marker %s is detected; unchanged or removed marker is not', (marker) => {
    const path = 'tests/case.py';
    expect(codes(input({}, { [path]: `${marker}\n` }))).toContain('test_disabled');
    expect(
      codes(input({ [path]: `${marker}\nold\n` }, { [path]: `${marker}\nnew\n` }))
    ).not.toContain('test_disabled');
    expect(codes(input({ [path]: `${marker}\n` }, { [path]: 'active\n' }))).not.toContain(
      'test_disabled'
    );
  });
  it.each([
    'test_.py',
    'nested/test_.py',
    'a.test.',
    'nested/a.spec.',
  ])('empty wildcard test boundary %s covers disabling and assertion reduction', (path) => {
    expect(codes(input({ [path]: 'expect(1);\n' }, { [path]: 'it.skip("case");\n' }))).toEqual([
      'test_disabled',
      'assertions_reduced',
    ]);
    expect(codes(input({ [path]: 'expect(1);\n' }, { [path]: 'expect(2);\n' }))).toEqual([]);
  });
  it('whitespace-separated marker tokens and focused describes are flagged', () => {
    expect(
      codes(
        input({ 'a.test.ts': 'it.skip(\nnext\nit\n(\n' }, { 'a.test.ts': 'next\nit\n.skip\n(\n' })
      )
    ).toContain('test_disabled');
    expect(codes(input({}, { 'test_case.py': '@pytest.mark.skipif(True)\n' }))).toContain(
      'test_disabled'
    );
    expect(codes(input({}, { 'a.test.ts': 'describe . only (\nit . skip (\n' }))).toContain(
      'test_disabled'
    );
    expect(codes(input({ 'a.test.ts': 'it\n(\n' }, { 'a.test.ts': 'it\n.skip\n(\n' }))).toContain(
      'test_disabled'
    );
  });
  it('marker overlap checks distinguish unchanged markers from later additions', () => {
    expect(
      codes(input({ 'a.test.ts': 'it.skip(\nold\n' }, { 'a.test.ts': 'it.skip(\nnew\n' }))
    ).not.toContain('test_disabled');
    expect(
      codes(input({ 'a.test.ts': 'old\nit.skip(\n' }, { 'a.test.ts': 'new\nit.skip(\n' }))
    ).not.toContain('test_disabled');
    expect(
      codes(input({ 'a.test.ts': 'it.skip(\nold\n' }, { 'a.test.ts': 'it.skip(\nnew\nit.skip(\n' }))
    ).toContain('test_disabled');
    expect(codes(input({ 'a.test.ts': 'old\n' }, { 'a.test.ts': 'new\nit.skip(\n' }))).toContain(
      'test_disabled'
    );
  });
  it.each([
    '.active\n',
    ';\n',
    '|| (() => {})\n',
    '&& it\n',
  ])('deletion junction %j introducing skip is flagged, even without additions', (removed) => {
    const before = `it\n${removed}.skip\n("case", () => { expect(true); });\n`;
    const after = 'it\n.skip\n("case", () => { expect(true); });\n';
    expect(codes(input({ 'a.test.ts': before }, { 'a.test.ts': after }))).toContain(
      'test_disabled'
    );
    // Removing another marker must not cancel the new one.
    expect(
      codes(input({ 'a.test.ts': `it.skip("old");\n${before}` }, { 'a.test.ts': after }))
    ).toContain('test_disabled');
    // Moving the intervening line elsewhere also creates new adjacency.
    expect(codes(input({ 'a.test.ts': before }, { 'a.test.ts': `${after}${removed}` }))).toContain(
      'test_disabled'
    );
  });
  it('deletions outside an unchanged marker do not report test disabling', () => {
    const marker = 'it\n.skip\n("case");\n';
    expect(
      codes(input({ 'a.test.ts': `old\n${marker}tail\n` }, { 'a.test.ts': marker }))
    ).not.toContain('test_disabled');
    expect(
      codes(input({ 'a.test.ts': `${marker}old\nnext\n` }, { 'a.test.ts': `${marker}next\n` }))
    ).not.toContain('test_disabled');
  });
  it.each([
    'it',
    'test',
    'describe',
    'customRunner',
  ])('deletion/rearrangement activating %s.only retains receiver evidence', (receiver) => {
    const path = 'focus.test.js';
    const before = `${receiver}\n|| (() => {})\n.only("case", () => expect(true));\n`;
    const after = `${receiver}\n.only("case", () => expect(true));\n`;
    expect(codes(input({ [path]: before }, { [path]: after }))).toContain('test_disabled');
    expect(codes(input({ [path]: before }, { [path]: `${after}|| (() => {})\n` }))).toContain(
      'test_disabled'
    );
    expect(codes(input({ [path]: `${after}old\n` }, { [path]: `${after}new\n` }))).not.toContain(
      'test_disabled'
    );
  });
  it.each([
    ' ',
    '\t',
    '\\\n',
    ' \\\r\n  ',
    '\\\r',
  ])('Python lexical gap %j in disabling markers is detected', (gap) => {
    for (const marker of [
      `@${gap}unittest${gap}.${gap}skip("reason")`,
      `@${gap}pytest${gap}.${gap}mark${gap}.${gap}skip(reason="reason")`,
      `@${gap}pytest${gap}.${gap}mark${gap}.${gap}skipif(True)`,
      `@${gap}pytest${gap}.${gap}mark${gap}.${gap}xfail()`,
      `pytest${gap}.${gap}skip("reason")`,
      `unittest${gap}.${gap}skipIf(True, "reason")`,
      `unittest${gap}.${gap}skipUnless(False, "reason")`,
    ]) {
      const path = 'test_.py';
      expect(
        codes(input({ [path]: 'assert True\n' }, { [path]: `${marker}\nassert True\n` }))
      ).toContain('test_disabled');
      expect(
        codes(
          input({ [path]: `${marker}\nassert True\n` }, { [path]: `${marker}\nassert False\n` })
        )
      ).not.toContain('test_disabled');
      expect(
        codes(input({ [path]: `${marker}\nassert True\n` }, { [path]: 'assert True\n' }))
      ).not.toContain('test_disabled');
    }
  });
  it.each([
    '(self # implicit continuation\n .assertTrue)(True)\n',
    '(self) .assertEqual(1, 1)\n',
    'self\\\n.assertEqual(1, 1)\n',
    'self \\\r\n .assertTrue(True)\n',
    'self\\\r.assertTrue(False)\r',
  ])('continued Python assertion %j is counted on both sides', (assertion) => {
    const path = 'test_.py';
    expect(codes(input({ [path]: assertion }, { [path]: 'pass\n' }))).toContain(
      'assertions_reduced'
    );
    expect(codes(input({ [path]: assertion }, { [path]: `${assertion}pass\n` }))).not.toContain(
      'assertions_reduced'
    );
    expect(codes(input({ [path]: assertion }, { [path]: assertion.repeat(2) }))).not.toContain(
      'assertions_reduced'
    );
  });
  it.each([
    'expect(1);\n',
    'assert value\n',
    'self.assertEqual(1, 1)\n',
  ])('assertion reduction %j and negative controls', (assertion) => {
    expect(
      codes(input({ 'a_test.py': assertion.repeat(2) }, { 'a_test.py': assertion }))
    ).toContain('assertions_reduced');
    expect(
      codes(input({ 'a_test.py': assertion }, { 'a_test.py': assertion.repeat(2) }))
    ).not.toContain('assertions_reduced');
    expect(
      codes(input({ 'a_test.py': assertion }, { 'a_test.py': `${assertion}text\n` }))
    ).not.toContain('assertions_reduced');
  });
  it('ordinary source assertions/skip text are not treated as test integrity', () => {
    expect(codes(input({ 'src/a.ts': 'expect(1);\n' }, { 'src/a.ts': 'it.skip(\n' }))).toEqual([]);
  });
  it.each([
    '/* lexical comment */',
    '// lexical comment\n',
  ])('JavaScript lexical gap %j preserves disabling and assertion evidence', (gap) => {
    const path = 'a.test.js';
    for (const marker of [`it${gap}.skip(`, `it.${gap}skip(`, `it.skip${gap}(`]) {
      expect(codes(input({}, { [path]: marker }))).toContain('test_disabled');
      expect(
        codes(input({ [path]: `${marker}\nold\n` }, { [path]: `${marker}\nnew\n` }))
      ).not.toContain('test_disabled');
      expect(codes(input({ [path]: marker }, { [path]: 'it("active");' }))).not.toContain(
        'test_disabled'
      );
    }
    expect(codes(input({ [path]: `expect${gap}(true);\n` }, { [path]: 'pass\n' }))).toContain(
      'assertions_reduced'
    );
  });
  it('long adversarial comments are screened with bounded lexical work', () => {
    const content = `# ${'it # expect # self # '.repeat(32000)}\n`;
    const value = input({}, { 'test_perf.py': content });
    expect(reviewCandidate(value)).toEqual({ verdict: 'pass', findings: [] });
    expect(
      codes(input({ 'test_perf.py': content }, { 'test_perf.py': `${content}it.skip("case");\n` }))
    ).toContain('test_disabled');
  });
  it.each([
    '@(unittest # implicit continuation\n .skip)("reason")',
    '@((unittest).skip)("reason")',
    '@(pytest # implicit continuation\n .mark # next token\n .skip)(reason="reason")',
    '@((pytest).mark.xfail)(reason="reason")',
  ])('grouped Python decorator %j is screened without losing raw offsets', (marker) => {
    const path = 'test_case.py';
    expect(
      codes(input({ [path]: 'assert True\n' }, { [path]: `${marker}\nassert True\n` }))
    ).toContain('test_disabled');
    expect(
      codes(input({ [path]: `${marker}\nassert True\n` }, { [path]: `${marker}\nassert False\n` }))
    ).not.toContain('test_disabled');
    expect(
      codes(input({ [path]: `${marker}\nassert True\n` }, { [path]: 'assert True\n' }))
    ).not.toContain('test_disabled');
    const before = marker.replace(' # implicit continuation\n', '\nremoved\n');
    if (before !== marker)
      expect(codes(input({ [path]: before }, { [path]: marker }))).toContain('test_disabled');
  });
  it.each([
    'suites',
    'tests',
  ] as const)('reduced %s discoveries hand off; equal/increased counts do not', (key) => {
    const value = { ...input(), baseDiscovery: { suites: 2, tests: 3, failures: 0, skipped: 0 } };
    expect(
      codes({
        ...value,
        candidateDiscovery: { ...value.baseDiscovery, [key]: value.baseDiscovery[key] - 1 },
      })
    ).toContain('discovery_reduced');
    expect(codes({ ...value, candidateDiscovery: value.baseDiscovery })).not.toContain(
      'discovery_reduced'
    );
    expect(
      codes({
        ...value,
        candidateDiscovery: { ...value.baseDiscovery, [key]: value.baseDiscovery[key] + 1 },
      })
    ).not.toContain('discovery_reduced');
  });
  it.each([
    'baseDiscovery',
    'candidateDiscovery',
  ] as const)('AC4 unknown %s always hands off', (side) => {
    for (const raw of [
      null,
      undefined,
      {},
      { suites: null, tests: 2 },
      { ...success, tests: NaN },
      { ...success, suites: -1 },
      { ...success, tests: 1.5 },
      { ...success, tests: Number.MAX_SAFE_INTEGER + 1 },
      { ...success, suites: 3 },
      { ...success, skipped: 3 },
      { ...success, failures: 2, skipped: 1 },
      { ...success, suites: 0 },
    ]) {
      const result = reviewCandidate({ ...input(), [side]: raw } as ReviewCandidateInput);
      expect(result.verdict).toBe('hand_off');
      expect(result.findings.map((finding) => finding.code)).toContain('discovery_unknown');
    }
  });
  it('known zero counts are valid, unlike null discovery', () => {
    const zero = { suites: 0, tests: 0, failures: 0, skipped: 0 };
    expect(codes({ ...input(), baseDiscovery: zero, candidateDiscovery: zero })).toEqual([]);
  });
  it.each(
    configs
  )('protected %s changes at any depth: additions/deletions/mode changes', (path) => {
    for (const name of [path, `nested/${path}`]) {
      expect(codes(input({}, { [name]: 'config\n' }))).toContain('config_changed');
      expect(codes(input({ [name]: 'config\n' }, {}))).toContain('config_changed');
      const value = input({ [name]: 'config\n' });
      expect(
        codes({ ...value, candidateManifest: manifest({ [name]: 'config\n' }, name) })
      ).toContain('config_changed');
      expect(codes(value)).not.toContain('config_changed');
    }
  });
  it('lookalike configuration names remain ordinary source', () => {
    expect(
      codes(
        input(
          {},
          {
            'Makefile.md': 'text',
            'package.json.md': 'text',
            'my.github/file.ts': 'text',
            'jest.config': 'text',
          }
        )
      )
    ).toEqual([]);
  });
  it.each([
    'dist/a.js',
    'build/a.js',
    'nested/dist/a.js',
    'a.min.js',
    'a.js.map',
  ])('generated %s: add/delete versus unchanged', (path) => {
    expect(codes(input({}, { [path]: 'bytes' }))).toContain('generated_or_binary');
    expect(codes(input({ [path]: 'bytes' }, {}))).toContain('generated_or_binary');
    expect(codes(input({ [path]: 'bytes' }))).not.toContain('generated_or_binary');
  });
  it('invalid UTF-8 and oversized changed/deleted files hand off; exact 1 MiB and real Unicode do not', () => {
    for (const value of [Buffer.from([0xff]), 'a'.repeat(1024 * 1024 + 1)]) {
      expect(codes(input({}, { asset: value }))).toContain('generated_or_binary');
      expect(codes(input({ asset: value }, {}))).toContain('generated_or_binary');
    }
    expect(codes(input({}, { asset: 'a'.repeat(1024 * 1024) }))).not.toContain(
      'generated_or_binary'
    );
    expect(codes(input({}, { asset: 'héllo 世界\n' }))).not.toContain('generated_or_binary');
  });
  it.each(['ai-dossier', 'imboard'])('added promotional %s outside tests only', (word) => {
    expect(codes(input({}, { 'src/a.ts': word }))).toContain('promotional');
    expect(codes(input({}, { 'a.test.ts': word }))).not.toContain('promotional');
    expect(
      codes(input({ 'src/a.ts': `${word}\nold\n` }, { 'src/a.ts': `${word}\nnew\n` }))
    ).not.toContain('promotional');
    expect(codes(input({ 'src/a.ts': word }, { 'src/a.ts': 'plain' }))).not.toContain(
      'promotional'
    );
  });
  it('file limits: strict greater-than, defaults, deletions and executable changes', () => {
    const files = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`src/${i}.ts`, 'line\n'])
    );
    const value = input({}, files);
    expect(codes(value)).toContain('patch_too_large');
    expect(codes({ ...value, limits: { maxFiles: 21 } })).not.toContain('patch_too_large');
    expect(codes(input(files, {}))).toContain('patch_too_large');
    const mode = {
      ...input({ 'a.ts': 'same' }),
      candidateManifest: manifest({ 'a.ts': 'same' }, 'a.ts'),
      limits: { maxFiles: 0 },
    };
    expect(codes(mode)).toContain('patch_too_large');
    expect(codes({ ...mode, limits: { maxFiles: 1, maxChangedLines: 0 } })).not.toContain(
      'patch_too_large'
    );
  });
  it.each([
    ['old\n', 'new\n', 2],
    ['', 'a\nb\n', 2],
    ['a\nb\n', '', 2],
    ['a\nb\nc\n', 'a\nx\nc\n', 2],
    ['a\nb\n', 'b\na\n', 2],
    ['a\na\nb\n', 'a\nb\nb\n', 2],
    ['a', 'a\n', 2],
    ['', '\n', 1],
    ['a\nb\nc\n', 'x\nb\ny\n', 4],
  ])('line accounting never undercounts %j → %j', (before, after, count) => {
    const value = input({ 'a.ts': before }, { 'a.ts': after });
    expect(codes({ ...value, limits: { maxChangedLines: count - 1 } })).toContain(
      'patch_too_large'
    );
    expect(codes({ ...value, limits: { maxChangedLines: count } })).not.toContain(
      'patch_too_large'
    );
  });
  it('bounds aggregate diff work across multiple allowed files without under-counting', () => {
    const before = `old\n${'shared\n'.repeat(990)}old-end\n`;
    const after = `new\n${'shared\n'.repeat(990)}new-end\n`;
    const single = input({ 'a.ts': before }, { 'a.ts': after });
    expect(codes({ ...single, limits: { maxChangedLines: 4 } })).toEqual([]);
    const multiple = input({ 'a.ts': before, 'b.ts': before }, { 'a.ts': after, 'b.ts': after });
    // A per-file cap would spend nearly a million cells twice and pass at 8.
    // The aggregate cap switches the second file to conservative delete/add.
    expect(codes({ ...multiple, limits: { maxChangedLines: 8 } })).toEqual(['patch_too_large']);
    expect(codes({ ...multiple, limits: { maxChangedLines: 1988 } })).toEqual([]);
  });
  it('line default boundary and conservative bounded-diff fallback', () => {
    expect(codes(input({}, { 'a.ts': 'a\n'.repeat(1000) }))).not.toContain('patch_too_large');
    expect(codes(input({}, { 'a.ts': 'a\n'.repeat(1001) }))).toContain('patch_too_large');
    const value = input(
      { 'a.ts': `old\n${'same\n'.repeat(1001)}tail\n` },
      { 'a.ts': `new\n${'same\n'.repeat(1001)}end\n` }
    );
    expect(codes(value)).toContain('patch_too_large');
    expect(codes({ ...value, limits: { maxChangedLines: 2006 } })).not.toContain('patch_too_large');
  });
  it('test file replaced with a directory remains deleted', () => {
    expect(codes(input({ 'tests/a.ts': 'expect(1);' }, { 'tests/a.ts/child': '' }))).toContain(
      'test_deleted'
    );
  });
  it('protected/generated empty directories cannot bypass path rules', () => {
    const directory = (path: string) =>
      createManifest([{ path, mode: '040000', bytes: '', sha256: sha256('') }]);
    expect(codes({ ...input(), candidateManifest: directory('.github') })).toContain(
      'config_changed'
    );
    expect(codes({ ...input(), candidateManifest: directory('dist') })).toContain(
      'generated_or_binary'
    );
    expect(
      codes({ ...input(), candidateManifest: directory('src'), limits: { maxFiles: 0 } })
    ).toEqual([]);
  });
  it.each([
    'baseManifest',
    'candidateManifest',
  ] as const)('malformed/truncated %s fails closed without echo', (side) => {
    for (const raw of [
      null,
      {},
      { ...manifest({ a: 'secret-content' }), digest: 'wrong' },
      { ...manifest({ a: 'text' }), entries: [] },
      { ...manifest({ a: 'text' }), totalBytes: 0 },
    ]) {
      expect(reviewCandidate({ ...input(), [side]: raw } as ReviewCandidateInput)).toEqual({
        verdict: 'hand_off',
        findings: [{ code: 'invalid_input', detail: 'Review evidence is invalid or unreadable.' }],
      });
    }
  });
  it('throwing inputs never echo errors or retry, and secret-shaped paths cannot escape', () => {
    let reads = 0;
    const value = {
      ...input(),
      get baseManifest(): SourceManifest {
        reads++;
        throw new Error('private contents');
      },
    };
    expect(codes(value)).toEqual(['invalid_input']);
    expect(reads).toBe(1);
    expect(codes(input({}, { [`ghp_${'a'.repeat(36)}`]: 'safe' }))).toEqual(['invalid_input']);
    expect(reviewCandidate(null as never).verdict).toBe('hand_off');
  });
  it.each([
    null,
    [],
    1,
    { maxFiles: null },
    { maxChangedLines: null },
    { maxFiles: -1 },
    { maxFiles: NaN },
    { maxChangedLines: Infinity },
    { maxChangedLines: 1.5 },
    { maxFiles: Number.MAX_SAFE_INTEGER + 1 },
  ])('invalid limits %j fail closed', (limits) => {
    expect(codes({ ...input(), limits } as ReviewCandidateInput)).toEqual(['invalid_input']);
  });
  it('AC5 immutable inputs/results and stable exact finding order', () => {
    const value = input(
      { 'z.test.ts': 'expect(1);\n', 'a.test.ts': 'expect(2);\n' },
      { 'a.test.ts': 'it.skip(\n', 'package.json': 'imboard\n' }
    );
    const frozen = Object.freeze({
      ...value,
      candidateDiscovery: null,
      limits: Object.freeze({ maxFiles: 0 }),
    });
    const saved = JSON.stringify(frozen);
    const first = reviewCandidate(frozen);
    expect(first.findings.map(({ code, path }) => [code, path])).toEqual([
      ['discovery_unknown', undefined],
      ['test_disabled', 'a.test.ts'],
      ['assertions_reduced', 'a.test.ts'],
      ['config_changed', 'package.json'],
      ['promotional', 'package.json'],
      ['test_deleted', 'z.test.ts'],
      ['patch_too_large', undefined],
    ]);
    expect(reviewCandidate(frozen)).toEqual(first);
    expect(JSON.stringify(frozen)).toBe(saved);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.findings)).toBe(true);
    expect(first.findings.every(Object.isFrozen)).toBe(true);
  });
});
