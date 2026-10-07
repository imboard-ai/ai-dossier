import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSource, resolveBase, sourceUrl } from '../canonical/acquire';
import { CanonicalError, exportSource } from '../canonical/export';
import { baseManifest, createCandidate, MAX_PACK_BYTES } from '../canonical/reconstruct';
import { TrustedGit } from '../canonical/trusted-git';

const temps: string[] = [];
const upstream = { owner: 'owner', repo: 'repo' };
function temp(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'acquire-test-'));
  temps.push(root);
  return root;
}
function git(root: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    input,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function fixture(parent = true) {
  const root = temp();
  git(root, ['init', '--bare', '--template=', '.']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'raw\r\nbytes\u0000').toString().trim();
  const tree = git(root, ['mktree'], `100755 blob ${blob}\tfile\n`).toString().trim();
  const commit = (treeSha: string, previous?: string) =>
    git(
      root,
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.org',
        'commit-tree',
        treeSha,
        ...(previous ? ['-p', previous] : []),
      ],
      'fixture\n'
    )
      .toString()
      .trim();
  const ancestor = commit(tree);
  const baseSha = parent ? commit(tree, ancestor) : ancestor;
  git(root, ['update-ref', 'refs/heads/main', baseSha]);
  return { root, baseSha, blob, commit, url: pathToFileURL(root).href };
}
function acquire(f: ReturnType<typeof fixture>) {
  return acquireSource({ ...upstream, baseSha: f.baseSha }, { remoteUrlForTest: f.url });
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of temps.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('credential-free source acquisition', () => {
  it.each([false, true])('returns a complete canonical pack with parent=%s', (parent) => {
    const f = fixture(parent);
    const fetch = vi.spyOn(TrustedGit.prototype, 'exec');
    const result = acquire(f);
    const source = temp();
    fs.writeFileSync(join(source, 'file'), 'raw\r\nbytes\u0000', { mode: 0o755 });
    expect(result.manifest).toEqual(exportSource(source));
    expect(baseManifest(result.pack, f.baseSha)).toEqual(result.manifest);
    const candidate = createCandidate(
      result.manifest,
      {
        baseSha: f.baseSha,
        author: {
          login: 'contributor',
          name: 'Contributor',
          email: 'contributor@example.org',
          timestamp: '2026-10-05T00:00:00Z',
        },
        committerTimestamp: '2026-10-05T00:01:00Z',
        message: 'approved contribution\n',
      },
      result.pack
    );
    expect(candidate.record.baseSha).toBe(f.baseSha);
    const fetches = fetch.mock.calls.filter(([args]) => args[0] === 'fetch');
    expect(fetches).toHaveLength(parent ? 2 : 1);
    expect(fetches[0]?.[0]).toContain('--depth=1');
    if (parent) expect(fetches[1]?.[0]).not.toContain('--depth=1');
  });
  it.each([
    '120000',
    '160000',
    '.git ',
    'collision',
    '060000',
  ])('refuses unsupported baseline %s', (kind) => {
    const f = fixture(false);
    const names = kind === 'collision' ? ['A', 'a'] : [kind === '.git ' ? kind : 'bad'];
    const mode = ['120000', '160000', '060000'].includes(kind) ? kind : '100644';
    const raw = Buffer.concat(
      names.map((name) =>
        Buffer.concat([
          Buffer.from(`${mode} ${name}\u0000`),
          Buffer.from(mode === '160000' ? f.baseSha : f.blob, 'hex'),
        ])
      )
    );
    const tree = git(f.root, ['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], raw)
      .toString()
      .trim();
    f.baseSha = f.commit(tree);
    git(f.root, ['update-ref', 'refs/heads/main', f.baseSha]);
    expect(() => acquire(f)).toThrow(new CanonicalError('unsupported'));
  });
  it('does not execute hooks, filters, gitmodules or inherited credentials; positive controls fire', () => {
    const f = fixture();
    const source = temp();
    const hookSentinel = join(source, 'hook-sentinel');
    const filterSentinel = join(source, 'filter-sentinel');
    const credentials = join(source, 'credential-sentinel');
    const hooks = join(source, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${hookSentinel}'\n`, {
      mode: 0o755,
    });
    const filter = join(source, 'filter');
    fs.writeFileSync(filter, `#!/bin/sh\ntouch '${filterSentinel}'\ncat\n`, { mode: 0o755 });
    const attributes = git(f.root, ['hash-object', '-w', '--stdin'], '* filter=evil\n')
      .toString()
      .trim();
    const modules = git(
      f.root,
      ['hash-object', '-w', '--stdin'],
      '[submodule "evil"]\n path=evil\n url=ext::touch forbidden\n'
    )
      .toString()
      .trim();
    const tree = git(
      f.root,
      ['mktree'],
      `100644 blob ${attributes}\t.gitattributes\n100644 blob ${modules}\t.gitmodules\n100755 blob ${f.blob}\tfile\n`
    )
      .toString()
      .trim();
    f.baseSha = f.commit(tree, f.baseSha);
    git(f.root, ['update-ref', 'refs/heads/main', f.baseSha]);
    fs.mkdirSync(join(f.root, 'hooks'));
    fs.copyFileSync(join(hooks, 'post-checkout'), join(f.root, 'hooks', 'post-checkout'));
    const config = join(source, 'gitconfig');
    fs.writeFileSync(
      config,
      `[core]\n hooksPath=${hooks}\n[filter "evil"]\n smudge=${filter}\n clean=${filter}\n required=true\n[credential]\n helper=!touch ${credentials}\n`
    );
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: forbidden');
    vi.stubEnv('GITHUB_TOKEN', 'forbidden');
    const result = acquire(f);
    expect(result.manifest.entries.map((e) => e.path)).toContain('.gitmodules');
    expect(fs.existsSync(hookSentinel)).toBe(false);
    expect(fs.existsSync(filterSentinel)).toBe(false);
    expect(fs.existsSync(credentials)).toBe(false);
    const checkout = temp();
    git(checkout, ['clone', '--no-checkout', f.root, '.']);
    git(checkout, [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      `filter.evil.smudge=${filter}`,
      'checkout',
      '--force',
      'main',
    ]);
    expect(fs.existsSync(hookSentinel)).toBe(true);
    expect(fs.existsSync(filterSentinel)).toBe(true);
  });
  it.each([
    '/',
    '..',
    '%2f',
    'a b',
    'https://evil',
    '',
    '.',
    'a'.repeat(101),
  ])('rejects unsafe name %j in both positions', (value) => {
    expect(() => sourceUrl({ owner: value, repo: 'repo' })).toThrow(CanonicalError);
    expect(() => sourceUrl({ owner: 'owner', repo: value })).toThrow(CanonicalError);
  });
  it('only builds a GitHub HTTPS URL', () => {
    expect(sourceUrl({ owner: 'owner._-1', repo: 'repo._-1' })).toBe(
      'https://github.com/owner._-1/repo._-1.git'
    );
  });
  it('resolves an encoded branch and rejects unreadable/malformed reads without retry', async () => {
    const head = 'a'.repeat(40);
    const read = vi.fn(async () => ({ status: 200, body: { commit: { sha: head } } }));
    expect(await resolveBase(read, { ...upstream, defaultBranch: 'feature/a' })).toBe(head);
    expect(read).toHaveBeenCalledWith('/repos/owner/repo/branches/feature%2Fa');
    for (const body of [null, {}, { commit: {} }, { commit: { sha: 'bad' } }])
      await expect(
        resolveBase(async () => ({ status: 200, body }), { ...upstream, defaultBranch: 'main' })
      ).rejects.toThrow(new CanonicalError('unavailable'));
    await expect(
      resolveBase(async () => ({ status: 404, body: {} }), { ...upstream, defaultBranch: 'main' })
    ).rejects.toThrow(new CanonicalError('unavailable'));
    await expect(
      resolveBase(
        async () => {
          throw new Error('secret');
        },
        { ...upstream, defaultBranch: 'main' }
      )
    ).rejects.toThrow(new CanonicalError('unavailable'));
    await expect(resolveBase(read, { ...upstream, defaultBranch: '' })).rejects.toThrow(
      CanonicalError
    );
  });
  it('test remote is refused outside Vitest and never accepts another transport', () => {
    const f = fixture();
    for (const url of [
      'https://github.com/owner/repo.git',
      'ssh://evil/repo',
      'file://remote/repo',
      `${f.url}?q=1`,
      `${f.url}#fragment`,
      'not a url',
    ])
      expect(() =>
        acquireSource({ ...upstream, baseSha: f.baseSha }, { remoteUrlForTest: url })
      ).toThrow(new CanonicalError('unsupported'));
    vi.stubEnv('VITEST', '');
    expect(() => acquire(f)).toThrow(new CanonicalError('unsupported'));
  });
  it('failed fetch is unavailable, never silently retried, and removes trusted storage', () => {
    const f = fixture();
    const exec = vi.spyOn(TrustedGit.prototype, 'exec');
    expect(() =>
      acquireSource({ ...upstream, baseSha: '0'.repeat(40) }, { remoteUrlForTest: f.url })
    ).toThrow(new CanonicalError('unavailable'));
    expect(exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    for (const context of exec.mock.contexts)
      expect(fs.existsSync((context as TrustedGit).directory)).toBe(false);
    expect(() => acquireSource({ ...upstream, baseSha: '--upload-pack=evil' })).toThrow(
      CanonicalError
    );
  });
  it('rejects oversize pack output before importing or exposing it to a store', () => {
    const f = fixture();
    const store = temp();
    const writes: string[] = [];
    const write = fs.writeFileSync;
    const append = fs.appendFileSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      writes.push(String(path));
      return write(path, data, options);
    });
    vi.spyOn(fs, 'appendFileSync').mockImplementation((path, data, options) => {
      writes.push(String(path));
      return append(path, data, options);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      writes.push(String(to));
      return rename(from, to);
    });
    const original = TrustedGit.prototype.exec;
    let packed = false;
    let imported = false;
    vi.spyOn(TrustedGit.prototype, 'exec').mockImplementation(function (
      this: TrustedGit,
      args,
      options
    ) {
      if (args[0] === 'pack-objects') {
        packed = true;
        expect(options?.maxOutputBytes).toBe(MAX_PACK_BYTES);
        return { status: null, stdout: Buffer.alloc(0), outputLimitExceeded: true };
      }
      if (args[0] === 'index-pack') imported = true;
      return original.call(this, args, options);
    });
    expect(() => {
      const result = acquire(f);
      fs.writeFileSync(join(store, 'baseline.pack'), result.pack);
    }).toThrow(new CanonicalError('limit_exceeded'));
    expect(packed).toBe(true);
    expect(imported).toBe(false);
    expect(writes.filter((path) => path.startsWith(`${store}/`))).toEqual([]);
    expect(fs.readdirSync(store)).toEqual([]);
    fs.writeFileSync(join(store, 'positive-control'), 'control');
    expect(writes.filter((path) => path.startsWith(`${store}/`))).toHaveLength(1);
  });
  it('malformed Unicode branch returns unavailable without a read', async () => {
    const read = vi.fn();
    await expect(resolveBase(read, { ...upstream, defaultBranch: '\ud800' })).rejects.toThrow(
      new CanonicalError('unavailable')
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('an unavailable strict importer never retries or publishes', () => {
    const f = fixture();
    const original = TrustedGit.prototype.exec;
    const exec = vi.spyOn(TrustedGit.prototype, 'exec').mockImplementation(function (
      this: TrustedGit,
      args,
      options
    ) {
      if (args[0] === 'index-pack') return { status: null, stdout: Buffer.alloc(0) };
      return original.call(this, args, options);
    });
    expect(() => acquire(f)).toThrow(new CanonicalError('unavailable'));
    expect(exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    for (const context of exec.mock.contexts)
      expect(fs.existsSync((context as TrustedGit).directory)).toBe(false);
  });
  it.each([
    'No space left on device',
    'Permission denied',
    'unknown failure',
  ])('completed operational import failure %s never retries', (detail) => {
    const f = fixture();
    const original = TrustedGit.prototype.exec;
    const exec = vi.spyOn(TrustedGit.prototype, 'exec').mockImplementation(function (
      this: TrustedGit,
      args,
      options
    ) {
      if (args[0] === 'index-pack')
        return { status: 128, stdout: Buffer.alloc(0), strictImportRejected: false };
      return original.call(this, args, options);
    });
    expect(detail).toBeTruthy();
    expect(() => acquire(f)).toThrow(new CanonicalError('unavailable'));
    expect(exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    for (const context of exec.mock.contexts)
      expect(fs.existsSync((context as TrustedGit).directory)).toBe(false);
  });
  it('strict importer classifies fixed terminal Git diagnostics without exposing arbitrary stderr', () => {
    const trusted = new TrustedGit();
    try {
      const spawn = vi.spyOn(childProcess, 'spawnSync');
      syncBuiltinESMExports();
      for (const [stderr, rejected] of [
        [`fatal: did not receive expected object ${'a'.repeat(40)}\n`, true],
        ['fatal: fsck error in packed object\n', true],
        ['fatal: early EOF\n', true],
        ['fatal: pack signature mismatch\n', true],
        ['fatal: cannot create temporary file: No space left on device\n', false],
        ['fatal: cannot create temporary file: Permission denied\n', false],
        ['fatal: unknown failure\n', false],
        [`fatal: did not receive expected object ${'a'.repeat(40)}\nfatal: write failed\n`, false],
      ] as const) {
        spawn.mockReturnValue({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.from(stderr)],
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(stderr),
          status: 128,
          signal: null,
        });
        const result = trusted.exec(['index-pack', '--strict', '--stdin'], {
          input: Buffer.from('pack'),
        });
        expect(result.strictImportRejected).toBe(rejected);
        expect(JSON.stringify(result)).not.toContain(stderr.trim());
      }
    } finally {
      trusted.close();
    }
  });
  it.each([
    true,
    false,
  ])('kernel receive bound stops the actual fetch before pack publication, shallow=%s', (shallow) => {
    const f = fixture();
    const trusted = new TrustedGit();
    try {
      const result = trusted.exec(
        [
          'fetch',
          ...(shallow ? ['--depth=1'] : []),
          '--no-tags',
          '--no-recurse-submodules',
          f.url,
          f.baseSha,
        ],
        { sourceFetch: 'file-test', sourcePackBytes: 64 }
      );
      expect(result.status).not.toBe(0);
      expect(result.fileLimitExceeded).toBe(true);
      const packDir = join(trusted.directory, 'repo', 'objects', 'pack');
      for (const file of fs.readdirSync(packDir)) {
        expect(fs.statSync(join(packDir, file)).size).toBeLessThanOrEqual(64);
        expect(file).not.toMatch(/^pack-.*\.pack$/u);
      }
    } finally {
      trusted.close();
    }
  });
  it('receive overflow stops acquisition before generation, fallback or store exposure', () => {
    const f = fixture();
    const original = TrustedGit.prototype.exec;
    const exec = vi.spyOn(TrustedGit.prototype, 'exec').mockImplementation(function (
      this: TrustedGit,
      args,
      options
    ) {
      if (args[0] === 'fetch')
        return { status: 128, stdout: Buffer.alloc(0), fileLimitExceeded: true };
      return original.call(this, args, options);
    });
    expect(() => acquire(f)).toThrow(new CanonicalError('limit_exceeded'));
    expect(exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    expect(
      exec.mock.calls.some(([args]) => args[0] === 'pack-objects' || args[0] === 'index-pack')
    ).toBe(false);
  });
  it('base inspection operational failure stays unavailable', () => {
    const f = fixture(false);
    const result = acquire(f);
    const original = TrustedGit.prototype.run;
    vi.spyOn(TrustedGit.prototype, 'run').mockImplementation(function (
      this: TrustedGit,
      args,
      input,
      identity
    ) {
      if (args[0] === 'cat-file') throw new CanonicalError('git_failed');
      return original.call(this, args, input, identity);
    });
    expect(() => baseManifest(result.pack, f.baseSha)).toThrow(new CanonicalError('unavailable'));
  });
  it.each([
    1, 2, 3, 4,
  ])('source repository initialization failure at step %s stops without publication', (failureAt) => {
    const f = fixture();
    const original = TrustedGit.prototype.run;
    let initializations = 0;
    const directories: string[] = [];
    const exec = vi.spyOn(TrustedGit.prototype, 'exec');
    vi.spyOn(TrustedGit.prototype, 'run').mockImplementation(function (
      this: TrustedGit,
      args,
      input,
      identity
    ) {
      if (args[0] === 'init') {
        directories.push(this.directory);
        if (++initializations === failureAt) throw new CanonicalError('git_failed');
      }
      return original.call(this, args, input, identity);
    });
    expect(() => acquire(f)).toThrow(new CanonicalError('unavailable'));
    expect(initializations).toBe(failureAt);
    expect(exec.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(
      failureAt === 1 ? 0 : failureAt === 4 ? 2 : 1
    );
    for (const directory of directories) expect(fs.existsSync(directory)).toBe(false);
  });
  it('raw storage initialization failure is classified unavailable', () => {
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('private storage failure');
    });
    expect(() => acquireSource({ ...upstream, baseSha: 'a'.repeat(40) })).toThrow(
      new CanonicalError('unavailable')
    );
    expect(() => baseManifest(Buffer.from('pack'), 'a'.repeat(40))).toThrow(
      new CanonicalError('unavailable')
    );
  });
  it('real bounded subprocess reports output overflow', () => {
    const f = fixture(false);
    const trusted = new TrustedGit();
    try {
      trusted.exec(['fetch', '--no-tags', '--no-recurse-submodules', f.url, f.baseSha], {
        sourceFetch: 'file-test',
      });
      const result = trusted.exec(['pack-objects', '--stdout', '--revs'], {
        input: `${f.baseSha}\n`,
        maxOutputBytes: 16,
      });
      expect(result.outputLimitExceeded).toBe(true);
      expect(result.status).toBeNull();
    } finally {
      trusted.close();
    }
  });
  it('source fetch config preserves defaults, disallows credentials and refuses non-HTTPS protocols', () => {
    const f = fixture();
    const trusted = new TrustedGit();
    try {
      expect(trusted.run(['config', '--get', 'protocol.allow']).toString().trim()).toBe('never');
      // Real local refusal; no invalid-host connections even if a regression enables HTTP.
      expect(trusted.exec(['fetch', f.url, f.baseSha], { sourceFetch: 'https' }).status).not.toBe(
        0
      );
      for (const extra of [{ env: {} }, { config: [] }, { identity: {} }])
        expect(() => trusted.exec(['fetch', f.url], { sourceFetch: 'https', ...extra })).toThrow(
          TypeError
        );
      expect(() => trusted.exec(['push', f.url], { sourceFetch: 'https' })).toThrow(TypeError);
      for (const sourcePackBytes of [0, Number.NaN, MAX_PACK_BYTES + 1])
        expect(() =>
          trusted.exec(['fetch', f.url], { sourceFetch: 'file-test', sourcePackBytes })
        ).toThrow(TypeError);
      expect(() => trusted.exec(['status'], { sourcePackBytes: 64 })).toThrow(TypeError);
      vi.stubEnv('VITEST', '');
      expect(() => trusted.exec(['fetch', f.url], { sourceFetch: 'file-test' })).toThrow(TypeError);
    } finally {
      trusted.close();
    }
  });
  it('records an HTTPS-only production invocation and detects injected forbidden protocols', () => {
    const trusted = new TrustedGit();
    try {
      const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      });
      syncBuiltinESMExports();
      vi.stubEnv('GITHUB_TOKEN', 'credential-canary');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'credential-canary');
      trusted.exec(['fetch', 'file:///nonexistent-offline-fixture', 'a'.repeat(40)], {
        sourceFetch: 'https',
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      const [executable, argv, options] = spawn.mock.calls[0] as [
        string,
        readonly string[],
        { env: NodeJS.ProcessEnv; shell: boolean },
      ];
      expect(executable).toBe('/usr/bin/env');
      const assertPolicy = (args: readonly string[]) => {
        expect(args).toContain('protocol.allow=never');
        expect(args.filter((arg) => /^protocol\..*\.allow=/u.test(arg))).toEqual([
          'protocol.https.allow=always',
        ]);
        expect(args).toContain('credential.helper=');
        expect(args).toContain('http.followRedirects=false');
      };
      assertPolicy(argv);
      for (const protocol of ['http', 'ssh', 'git', 'file', 'ext'])
        expect(() => assertPolicy([...argv, '-c', `protocol.${protocol}.allow=always`])).toThrow();
      expect(options.shell).toBe(false);
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(Object.values(options.env)).not.toContain('credential-canary');
    } finally {
      trusted.close();
    }
  });
});
