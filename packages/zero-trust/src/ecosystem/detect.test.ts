import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManifest, sha256 } from '../canonical/export';
import { ReasonCode } from '../state';
import {
  type Detection,
  detectEcosystem,
  parseHashedRequirements,
  type SourceFiles,
  sourceFilesFromManifest,
} from './detect';

const FIXTURES = path.join(__dirname, '../../fixtures/ecosystem');
function fixtureFiles(name: string): Map<string, string> {
  const dir = path.join(FIXTURES, name, 'base');
  return new Map(
    fs
      .readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
  );
}

const H = (c: string) => c.repeat(64);
const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'x',
    scripts: { test: 'node --test' },
    engines: { node: '>=20' },
    ...extra,
  });
const lock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  JSON.stringify({ lockfileVersion, packages: { '': { name: 'x' }, ...packages } });
const dep = {
  resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
  integrity:
    'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==',
};
const npm = (over: Record<string, string> = {}): SourceFiles =>
  new Map(
    Object.entries({
      'package.json': pkg(),
      'package-lock.json': lock({ 'node_modules/ms': dep }),
      ...over,
    })
  );
const reqs = `pytest==8.4.2 \\\n    --hash=sha256:${H('a')}\n    # via -r requirements.in\nplain==1.0 --hash=sha256:${H('b')} --hash=sha256:${H('c')}\n`;
const uvLock = (packages: string, version = 1) =>
  `version = ${version}\nrequires-python = ">=3.11"\n${packages}`;
const uvPkg = (
  name: string,
  source = '{ registry = "https://pypi.org/simple" }',
  hash = `sha256:${H('d')}`
) =>
  `\n[[package]]\nname = "${name}"\nversion = "1.0"\nsource = ${source}\nwheels = [{ url = "https://files.pythonhosted.org/packages/aa/bb/${H('e').slice(0, 60)}/${name}-1.0-py3-none-any.whl", hash = "${hash}" }]\n`;
const root = '\n[[package]]\nname = "app"\nversion = "1.0"\nsource = { virtual = "." }\n';
const uv = (over: Record<string, string> = {}): SourceFiles =>
  new Map(
    Object.entries({
      'pyproject.toml': '[project]\nname = "app"\nrequires-python = ">=3.11"\n',
      'uv.lock': uvLock(root + uvPkg('pytest')),
      ...over,
    })
  );

function reason(d: Detection) {
  if (d.supported) throw new Error('expected unsupported');
  expect(d.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
  return [d.reason, d.detail];
}

describe('supported ecosystems', () => {
  it('detects npm with package-lock.json and collects runtime declarations', () => {
    const d = detectEcosystem(npm({ '.nvmrc': 'v22\n', '.node-version': '22' }));
    expect(d).toEqual({
      supported: true,
      ecosystem: 'node',
      manager: 'npm',
      lockfile: 'package-lock.json',
      declarations: [
        { source: 'package.json#engines.node', value: '>=20' },
        { source: '.nvmrc', value: 'v22' },
        { source: '.node-version', value: '22' },
      ],
    });
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('accepts workspace links and bundled packages without a registry URL', () => {
    const files = npm({
      'package-lock.json': lock(
        {
          'node_modules/ms': dep,
          'node_modules/w': { link: true },
          'node_modules/b': { inBundle: true },
        },
        2
      ),
    });
    expect(detectEcosystem(files).supported).toBe(true);
  });

  it('detects pip with fully hash-pinned requirements', () => {
    const d = detectEcosystem(
      new Map([
        ['requirements.txt', `--require-hashes\n${reqs}`],
        ['pyproject.toml', '[project]\nrequires-python = ">=3.12"\n'],
        ['.python-version', '3.12\n'],
      ])
    );
    expect(d).toMatchObject({
      supported: true,
      ecosystem: 'python',
      manager: 'pip',
      lockfile: 'requirements.txt',
      declarations: [
        { source: 'pyproject.toml#project.requires-python', value: '>=3.12' },
        { source: '.python-version', value: '3.12' },
      ],
    });
  });

  it('detects uv with uv.lock and records its requires-python', () => {
    expect(detectEcosystem(uv())).toMatchObject({
      supported: true,
      manager: 'uv',
      declarations: [
        { source: 'pyproject.toml#project.requires-python', value: '>=3.11' },
        { source: 'uv.lock#requires-python', value: '>=3.11' },
      ],
    });
  });

  it.each([
    ['npm', 'npm'],
    ['pip', 'pip'],
    ['uv', 'uv'],
  ])('accepts the %s fixture', (name, manager) => {
    expect(detectEcosystem(fixtureFiles(name))).toMatchObject({ supported: true, manager });
  });

  it('reads root-level files from a canonical source manifest', () => {
    const entry = (p: string, text: string, mode: '100644' | '040000' = '100644') => ({
      path: p,
      mode,
      bytes: Buffer.from(text).toString('base64'),
      sha256: sha256(Buffer.from(text)),
    });
    const manifest = createManifest([
      entry('package-lock.json', lock({ 'node_modules/ms': dep })),
      entry('package.json', pkg()),
      entry('sub', '', '040000'),
      entry('sub/yarn.lock', ''),
    ]);
    const files = sourceFilesFromManifest(manifest);
    expect([...files.keys()].sort()).toEqual(['package-lock.json', 'package.json']);
    expect(detectEcosystem(files).supported).toBe(true);
  });
});

describe('unsupported setups fail closed with a specific reason', () => {
  it.each<[string, SourceFiles, string, string | undefined]>([
    ['empty repository', new Map(), 'no_supported_ecosystem', undefined],
    ['node and python together', npm({ 'requirements.txt': reqs }), 'mixed_ecosystems', undefined],
    ['pnpm lockfile', npm({ 'pnpm-lock.yaml': '' }), 'unsupported_manager', 'pnpm'],
    ['pnpm workspace', npm({ 'pnpm-workspace.yaml': '' }), 'unsupported_manager', 'pnpm'],
    ['yarn lockfile', npm({ 'yarn.lock': '' }), 'unsupported_manager', 'yarn'],
    ['yarn berry config', npm({ '.yarnrc.yml': '' }), 'unsupported_manager', 'yarn'],
    ['bun lockfile', npm({ 'bun.lockb': '' }), 'unsupported_manager', 'bun'],
    [
      'npm shrinkwrap',
      npm({ 'npm-shrinkwrap.json': '{}' }),
      'unsupported_manager',
      'npm-shrinkwrap',
    ],
    [
      'packageManager pnpm',
      npm({ 'package.json': pkg({ packageManager: 'pnpm@9.0.0' }) }),
      'unsupported_manager',
      'pnpm',
    ],
    [
      'packageManager yarn',
      npm({ 'package.json': pkg({ packageManager: 'yarn@4.1.0' }) }),
      'unsupported_manager',
      'yarn',
    ],
    [
      'non-string packageManager',
      npm({ 'package.json': pkg({ packageManager: 7 }) }),
      'unsupported_manager',
      'packageManager',
    ],
    [
      'lockfile only',
      new Map([['package-lock.json', lock({})]]),
      'manifest_invalid',
      'package.json',
    ],
    ['unparseable package.json', npm({ 'package.json': '{' }), 'manifest_invalid', 'package.json'],
    [
      'non-string engines.node',
      npm({ 'package.json': pkg({ engines: { node: 20 } }) }),
      'manifest_invalid',
      'package.json#engines.node',
    ],
    [
      'package.json without lockfile',
      new Map([['package.json', pkg()]]),
      'lockfile_missing',
      'package-lock.json',
    ],
    [
      'unparseable lockfile',
      npm({ 'package-lock.json': '[]' }),
      'lockfile_invalid',
      'package-lock.json',
    ],
    [
      'non-object lock entry',
      npm({ 'package-lock.json': lock({ 'node_modules/x': 'nope' }) }),
      'lockfile_invalid',
      'package-lock.json',
    ],
    [
      'lockfile v1',
      npm({ 'package-lock.json': lock({}, 1) }),
      'lockfile_version',
      'package-lock.json',
    ],
    [
      'git dependency',
      npm({
        'package-lock.json': lock({
          'node_modules/g': { resolved: 'git+ssh://git@github.com/a/b.git' },
        }),
      }),
      'non_registry_dependency',
      'node_modules/g',
    ],
    [
      'tarball from another host',
      npm({
        'package-lock.json': lock({
          'node_modules/t': { ...dep, resolved: 'https://example.com/t.tgz' },
        }),
      }),
      'non_registry_dependency',
      'node_modules/t',
    ],
    [
      'npm entry without integrity',
      npm({ 'package-lock.json': lock({ 'node_modules/ms': { resolved: dep.resolved } }) }),
      'missing_hashes',
      'node_modules/ms',
    ],
    [
      'npm sha1 integrity',
      npm({ 'package-lock.json': lock({ 'node_modules/ms': { ...dep, integrity: 'sha1-abc=' } }) }),
      'missing_hashes',
      'node_modules/ms',
    ],
    [
      'no test script',
      npm({ 'package.json': pkg({ scripts: {} }) }),
      'test_runner_missing',
      'scripts.test',
    ],
    [
      'npm init default test script',
      npm({
        'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      }),
      'test_runner_missing',
      'scripts.test',
    ],
    [
      'unpinned requirements.txt',
      new Map([['requirements.txt', 'pytest>=8\n']]),
      'unpinned_requirement',
      'pytest',
    ],
    [
      'pinned requirements without hashes',
      new Map([['requirements.txt', 'pytest==8.4.2\n']]),
      'missing_hashes',
      'pytest',
    ],
    [
      'requirements with an index override',
      new Map([['requirements.txt', `--extra-index-url https://evil.example/simple\n${reqs}`]]),
      'unsupported_requirement_option',
      '--extra-index-url',
    ],
    [
      'requirements including another file',
      new Map([['requirements.txt', '-r base.txt\n']]),
      'unsupported_requirement_option',
      '-r',
    ],
    [
      'requirement with an unknown option',
      new Map([['requirements.txt', `pytest==8.4.2 --hash=md5:${H('a')}\n`]]),
      'unsupported_requirement_option',
      '--hash',
    ],
    [
      'direct URL requirement',
      new Map([['requirements.txt', 'pkg @ https://example.com/pkg.whl\n']]),
      'non_registry_dependency',
      'pkg',
    ],
    [
      'empty requirements',
      new Map([['requirements.txt', '# nothing\n']]),
      'lockfile_invalid',
      'requirements.txt',
    ],
    [
      'hashed requirements without pytest',
      new Map([['requirements.txt', `plain==1.0 --hash=sha256:${H('b')}\n`]]),
      'test_runner_missing',
      'pytest',
    ],
    [
      'uv.lock and requirements.txt together',
      uv({ 'requirements.txt': reqs }),
      'ambiguous_manager',
      'uv.lock,requirements.txt',
    ],
    ['poetry lockfile', new Map([['poetry.lock', '']]), 'unsupported_manager', 'poetry'],
    [
      'poetry pyproject',
      new Map([['pyproject.toml', '[tool.poetry]\nname = "x"\n']]),
      'unsupported_manager',
      'poetry',
    ],
    ['Pipfile', new Map([['Pipfile', '']]), 'unsupported_manager', 'pipenv'],
    ['pdm lockfile', new Map([['pdm.lock', '']]), 'unsupported_manager', 'pdm'],
    [
      'pyproject without a lock',
      new Map([['pyproject.toml', '[project]\nname = "x"\n']]),
      'lockfile_missing',
      'pyproject.toml',
    ],
    ['setup.py only', new Map([['setup.py', '']]), 'lockfile_missing', 'setup.py'],
    [
      'invalid pyproject',
      uv({ 'pyproject.toml': '[project' }),
      'manifest_invalid',
      'pyproject.toml',
    ],
    [
      'non-string requires-python',
      uv({ 'pyproject.toml': '[project]\nrequires-python = 3\n' }),
      'manifest_invalid',
      'pyproject.toml#project.requires-python',
    ],
    [
      'uv.lock without pyproject',
      new Map([['uv.lock', uvLock(root)]]),
      'manifest_invalid',
      'pyproject.toml',
    ],
    ['unparseable uv.lock', uv({ 'uv.lock': 'version = ' }), 'lockfile_invalid', 'uv.lock'],
    ['uv.lock without packages', uv({ 'uv.lock': 'version = 1\n' }), 'lockfile_invalid', 'uv.lock'],
    [
      'uv.lock unknown version',
      uv({ 'uv.lock': uvLock(root + uvPkg('pytest'), 2) }),
      'lockfile_version',
      'uv.lock',
    ],
    [
      'uv package without source',
      uv({ 'uv.lock': uvLock('\n[[package]]\nname = "x"\n') }),
      'lockfile_invalid',
      'uv.lock',
    ],
    [
      'uv git source',
      uv({
        'uv.lock': uvLock(
          root + uvPkg('pytest') + uvPkg('g', '{ git = "https://github.com/a/b" }')
        ),
      }),
      'non_registry_dependency',
      'g',
    ],
    [
      'uv package without hashes',
      uv({ 'uv.lock': uvLock(root + uvPkg('pytest', undefined, 'md5:x')) }),
      'missing_hashes',
      'pytest',
    ],
    [
      'uv package without artifacts',
      uv({
        'uv.lock': uvLock(
          `${root}\n[[package]]\nname = "x"\nversion = "1"\nsource = { registry = "https://pypi.org/simple" }\n`
        ),
      }),
      'missing_hashes',
      'x',
    ],
    [
      'uv lock without pytest',
      uv({ 'uv.lock': uvLock(root + uvPkg('six')) }),
      'test_runner_missing',
      'pytest',
    ],
  ])('%s', (_name, files, expected, detail) => {
    expect(reason(detectEcosystem(files))).toEqual([expected, detail]);
  });
});

describe('parseHashedRequirements', () => {
  it('joins continuations, ignores comments and normalizes names', () => {
    const parsed = parseHashedRequirements(
      `Some_Pkg[extra]==1.0 ; python_version >= "3.11" \\\n  --hash=sha256:${H('a')}  # pinned\n`
    );
    expect(parsed).toEqual([{ name: 'some-pkg', version: '1.0', hashes: [H('a')] }]);
  });
});
