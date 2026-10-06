import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrustedGit } from '../canonical/trusted-git';
import {
  CANONICAL_COMMITTER,
  CanonicalError,
  type CommitInputs,
  createCandidate,
  createManifest,
  exportSource,
  reconstructCandidate,
  type SourceEntry,
  sha256,
  validateManifest,
  validateSourcePath,
} from '../index';

const temps: string[] = [];
function temp(): string {
  const path = fs.mkdtempSync(join(tmpdir(), 'canonical-test-'));
  temps.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temps.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});
function rejects(work: () => unknown, reason: string): void {
  try {
    work();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalError);
    expect((error as CanonicalError).reason).toBe(reason);
  }
}
function file(path: string, value = 'hello\n', mode: SourceEntry['mode'] = '100644'): SourceEntry {
  return { path, mode, bytes: Buffer.from(value).toString('base64'), sha256: sha256(value) };
}
const author = Object.freeze({
  login: 'contributor',
  name: 'Approved Contributor',
  email: 'contributor@example.org',
  timestamp: '2026-10-05T10:00:00Z',
});
function approved(baseSha: string): CommitInputs {
  return {
    baseSha,
    author,
    committerTimestamp: '2026-10-05T10:01:00Z',
    message: 'fix: approved contribution\n\nSubstantial LLM assistance via ai-dossier.\n',
  };
}
function baseline(
  entries: { path: string; mode: string; content?: string; sha?: string }[] = [
    { path: 'base.txt', mode: '100644', content: 'base\n' },
  ]
): { baseSha: string; pack: Buffer } {
  const git = new TrustedGit();
  try {
    const tree = git
      .run(
        ['mktree', '-z', '--missing'],
        Buffer.concat(
          entries.map((entry) => {
            const sha =
              entry.sha ??
              git
                .run(['hash-object', '-w', '--stdin'], entry.content ?? '')
                .toString()
                .trim();
            return Buffer.from(
              `${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${sha}\t${entry.path}\u0000`
            );
          })
        )
      )
      .toString()
      .trim();
    const baseSha = git
      .run(['commit-tree', tree], 'baseline\n', {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: '1791194400 +0000',
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: '1791194400 +0000',
      })
      .toString()
      .trim();
    return { baseSha, pack: git.run(['pack-objects', '--stdout', '--revs'], `${baseSha}\n`) };
  } finally {
    git.close();
  }
}

describe('canonical filesystem export', () => {
  it('entry limit stops streaming enumeration without reading the full directory', () => {
    const root = temp();
    for (let i = 0; i < 100; i++) fs.writeFileSync(join(root, `file-${i}`), 'bytes');
    const read = vi.spyOn(fs.Dir.prototype, 'readSync');
    rejects(() => exportSource(root, { entries: 1 }), 'limit_exceeded');
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('malformed persisted shapes yield typed, non-echoing rejections', () => {
    rejects(() => validateManifest(null as never), 'invalid_manifest');
    rejects(() => createManifest(null as never), 'invalid_manifest');
    rejects(() => createManifest([null] as never), 'invalid_manifest');
    rejects(() => validateManifest({ version: 1, entries: [null] } as never), 'invalid_manifest');
  });
  it.each([
    ['ß.txt', 'SS.txt'],
    ['ς.txt', 'σ.txt'],
    ['Ａ.txt', 'a.txt'],
  ])('rejects portable case-fold aliases %s/%s', (a, b) => {
    rejects(() => createManifest([file(a), file(b)]), 'path_collision');
  });
  it('rejects gitlink manifest modes and real device stat types', () => {
    rejects(
      () => createManifest([{ ...file('submodule'), mode: '160000' as SourceEntry['mode'] }]),
      'unsupported'
    );
    const root = temp();
    fs.writeFileSync(join(root, 'device'), 'placeholder');
    const original = fs.lstatSync;
    const device = original('/dev/null');
    expect(device.isCharacterDevice()).toBe(true);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) =>
      String(path).endsWith('/device') ? device : original(path)) as typeof fs.lstatSync);
    rejects(() => exportSource(root), 'unsupported');
  });
  it('captures all regular bytes, executable bits and empty directories immutably', () => {
    const root = temp();
    fs.mkdirSync(join(root, 'empty'));
    fs.writeFileSync(join(root, 'script'), 'binary\u0000bytes');
    fs.chmodSync(join(root, 'script'), 0o751);
    const manifest = exportSource(root);
    expect(manifest.entries.map((entry) => [entry.path, entry.mode])).toEqual([
      ['empty', '040000'],
      ['script', '100755'],
    ]);
    fs.writeFileSync(join(root, 'script'), 'changed');
    expect(Buffer.from(manifest.entries[1]?.bytes ?? '', 'base64')).toEqual(
      Buffer.from('binary\u0000bytes')
    );
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries[1])).toBe(true);
    expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
  it.each([
    'link',
    'fifo',
    'git',
    'socket',
  ])('rejects a real %s without silent dropping', async (kind) => {
    const root = temp();
    const path = join(root, kind === 'git' ? '.git' : 'bad');
    let server: ReturnType<typeof createServer> | undefined;
    if (kind === 'link') fs.symlinkSync('/etc/passwd', path);
    if (kind === 'fifo') execFileSync('mkfifo', [path]);
    if (kind === 'git') fs.mkdirSync(path);
    if (kind === 'socket') {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(path, resolve);
      });
    }
    try {
      rejects(() => exportSource(root), kind === 'git' ? 'invalid_path' : 'unsupported');
    } finally {
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });
  it('rejects a nested Git component and a gitfile', () => {
    const root = temp();
    fs.mkdirSync(join(root, 'dir'));
    fs.writeFileSync(join(root, 'dir', '.GiT'), 'gitdir: /outside');
    rejects(() => exportSource(root), 'invalid_path');
  });
  it('never traverses a symlink root or ancestor', () => {
    const root = temp();
    const outside = temp();
    fs.mkdirSync(join(outside, 'dir'));
    fs.symlinkSync(outside, join(root, 'alias'));
    rejects(() => exportSource(join(root, 'alias', 'dir')), 'source_changed');
    rejects(() => exportSource(join(root, 'alias')), 'source_changed');
  });
  it.each([
    '../a',
    '/a',
    'a/../b',
    'a//b',
    '.',
    'a/',
    'C:/a',
    'a\\b',
    'a/.git/config',
    '.GIT/hooks/x',
    'a\nfile',
    'a\u0000b',
    '\ud800',
  ])('rejects unsafe path %j', (path) => rejects(() => validateSourcePath(path), 'invalid_path'));
  it.each([
    ['A.txt', 'a.txt'],
    ['é.txt', 'e\u0301.txt'],
    ['Dir', 'dir'],
  ])('rejects colliding paths %s/%s', (a, b) => {
    const root = temp();
    fs.writeFileSync(join(root, a), 'one');
    fs.writeFileSync(join(root, b), 'two');
    rejects(() => exportSource(root), 'path_collision');
  });
  it('rejects invalid UTF-8 filesystem names', () => {
    const root = temp();
    fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]), 'bad');
    rejects(() => exportSource(root), 'invalid_path');
  });
  it('enforces default file cap, configured aggregate cap, entry/depth caps and invalid limits', () => {
    const root = temp();
    fs.writeFileSync(join(root, 'big'), Buffer.alloc(10 * 1024 * 1024 + 1));
    rejects(() => exportSource(root), 'limit_exceeded');
    fs.writeFileSync(join(root, 'big'), '123');
    fs.writeFileSync(join(root, 'other'), '456');
    rejects(() => exportSource(root, { fileBytes: 2 }), 'limit_exceeded');
    rejects(() => exportSource(root, { totalBytes: 5 }), 'limit_exceeded');
    rejects(() => exportSource(root, { entries: 1 }), 'limit_exceeded');
    rejects(() => exportSource(root, { totalBytes: Number.NaN }), 'limit_exceeded');
    const nested = temp();
    fs.mkdirSync(join(nested, 'a', 'b'), { recursive: true });
    rejects(() => exportSource(nested, { depth: 1 }), 'limit_exceeded');
  });
  it('rejects a file replaced by a symlink between lstat and open', () => {
    const root = temp();
    const path = join(root, 'file');
    fs.writeFileSync(path, 'safe');
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      if (String(name).endsWith('/file')) {
        fs.unlinkSync(path);
        fs.symlinkSync('/etc/passwd', path);
      }
      return original(name, flags, mode);
    });
    rejects(() => exportSource(root), 'source_changed');
  });
  it('pins file type without opening a raced special inode for I/O', () => {
    const root = temp();
    fs.writeFileSync(join(root, 'file'), 'safe');
    const originalStat = fs.fstatSync;
    const originalOpen = fs.openSync;
    const device = fs.lstatSync('/dev/null');
    let pinned: number | undefined;
    let reopened = false;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      const fd = originalOpen(path, flags, mode);
      if (String(path).endsWith('/file')) {
        expect(Number(flags) & 0x200000).not.toBe(0); // O_PATH, not device I/O.
        pinned = fd;
      }
      if (pinned !== undefined && String(path) === `/proc/self/fd/${pinned}`) reopened = true;
      return fd;
    });
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
      fd === pinned ? device : originalStat(fd)) as typeof fs.fstatSync);
    rejects(() => exportSource(root), 'source_changed');
    expect(pinned).toBeDefined();
    expect(reopened).toBe(false);
  });
  it('directory replacement cannot redirect the descriptor-anchored walk', () => {
    const root = temp();
    const outside = temp();
    const dir = join(root, 'dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'file'), 'safe');
    fs.writeFileSync(join(outside, 'secret'), 'outside');
    const original = fs.opendirSync;
    let swapped = false;
    vi.spyOn(fs, 'opendirSync').mockImplementation((path, options) => {
      const result = original(path, options);
      if (!swapped && fs.realpathSync(path).endsWith('/dir')) {
        swapped = true;
        fs.renameSync(dir, join(root, 'old'));
        fs.symlinkSync(outside, dir);
      }
      return result;
    });
    rejects(() => exportSource(root), 'source_changed');
    expect(swapped).toBe(true);
  });
  it('rejects growth during a bounded file read', () => {
    const root = temp();
    const path = join(root, 'file');
    fs.writeFileSync(path, 'safe');
    const original = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      fs.appendFileSync(path, 'growth');
      return original(...args);
    }) as typeof fs.readSync);
    rejects(() => exportSource(root), 'source_changed');
  });
  it('rejects forged digests, noncanonical base64 and missing parent directories', () => {
    const manifest = createManifest([file('a')]);
    rejects(() => validateManifest({ ...manifest, digest: '0'.repeat(64) }), 'invalid_manifest');
    rejects(() => createManifest([{ ...file('a'), bytes: 'aGVsbG8=!!!' }]), 'invalid_manifest');
    rejects(() => createManifest([file('dir/a')]), 'invalid_manifest');
    rejects(
      () => createManifest([file('a', '', '040000'), file('a/b', 'x', '040000')]),
      'invalid_manifest'
    );
  });
});

describe('canonical Git reconstruction', () => {
  it('cleans its private directory after initialization failure', () => {
    const original = fs.mkdtempSync;
    let created = '';
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
      created = original(prefix);
      return created;
    }) as typeof fs.mkdtempSync);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('synthetic storage failure');
    });
    expect(() => new TrustedGit()).toThrow('synthetic storage failure');
    expect(created).toMatch(/^\/tmp\/zt-canonical-/u);
    expect(fs.existsSync(created)).toBe(false);
  });
  it('validates nested baseline trees and rejects inconsistent bound tree/commit identities', () => {
    const base = baseline();
    const source = createManifest([
      file('a', '', '040000'),
      file('a/b', '', '040000'),
      file('a/b/c'),
    ]);
    const first = createCandidate(source, approved(base.baseSha), base.pack);
    const next = createCandidate(source, approved(first.record.candidateSha), first.pack);
    expect(next.record.baseSha).toBe(first.record.candidateSha);
    for (const field of ['treeSha', 'candidateSha'] as const) {
      const inconsistent = { ...first.record, [field]: 'a'.repeat(40) };
      // Simulate corrupted controller state: even a matching binding cannot mask
      // recomputed tree/commit identity disagreement.
      const authority = { ...first.authority, recordDigest: sha256(JSON.stringify(inconsistent)) };
      rejects(
        () => reconstructCandidate(source, inconsistent, authority, base.pack),
        field === 'treeSha' ? 'tree_mismatch' : 'commit_mismatch'
      );
    }
    rejects(() => createCandidate(source, null as never, base.pack), 'invalid_manifest');
    rejects(
      () =>
        createCandidate(source, { ...approved(base.baseSha), author: null } as never, base.pack),
      'altered_identity'
    );
    rejects(
      () => reconstructCandidate(source, first.record, null as never, base.pack),
      'invalid_manifest'
    );
  });
  it.each([
    '.git',
    '../escape',
    '/absolute',
    'a/b',
    'bad\nname',
  ])('rejects malformed baseline path %j', (name) => {
    const git = new TrustedGit();
    try {
      const blob = git.run(['hash-object', '-w', '--stdin'], 'bytes').toString().trim();
      const tree = git
        .run(
          ['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'],
          Buffer.concat([Buffer.from(`100644 ${name}\u0000`), Buffer.from(blob, 'hex')])
        )
        .toString()
        .trim();
      const baseSha = git
        .run(['commit-tree', tree], 'base\n', {
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.org',
          GIT_AUTHOR_DATE: '1791194400 +0000',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.org',
          GIT_COMMITTER_DATE: '1791194400 +0000',
        })
        .toString()
        .trim();
      const pack = git.run(['pack-objects', '--stdout', '--revs'], `${baseSha}\n`);
      rejects(
        () => createCandidate(createManifest([]), approved(baseSha), pack),
        name.includes('\n') ? 'invalid_path' : 'unsupported'
      );
    } finally {
      git.close();
    }
  });
  it('reconstructs twice with the exact same SHA, raw bytes, modes, parent and identities', () => {
    const base = baseline();
    const source = createManifest([
      file('dir', '', '040000'),
      file('dir/run', 'abc\u0000binary', '100755'),
      file('dir.txt'),
      file('empty', '', '040000'),
    ]);
    const first = createCandidate(source, approved(base.baseSha), base.pack);
    const second = reconstructCandidate(
      JSON.parse(JSON.stringify(source)),
      JSON.parse(JSON.stringify(first.record)),
      JSON.parse(JSON.stringify(first.authority)),
      base.pack
    );
    expect(second.record).toEqual(first.record);
    const git = new TrustedGit();
    try {
      git.run(['index-pack', '--strict', '--stdin'], second.pack);
      const raw = git.run(['cat-file', 'commit', second.record.candidateSha]).toString();
      expect(raw).toContain(`parent ${base.baseSha}\n`);
      expect(raw).toContain(`author ${author.name} <${author.email}> 1791194400 +0000\n`);
      expect(raw).toContain(
        `committer ${CANONICAL_COMMITTER.name} <${CANONICAL_COMMITTER.email}> 1791194460 +0000\n`
      );
      expect(raw.endsWith(approved(base.baseSha).message)).toBe(true);
      expect(git.run(['ls-tree', '-r', second.record.treeSha]).toString()).toContain('100755 blob');
      expect(git.run(['cat-file', 'blob', `${second.record.treeSha}:dir/run`])).toEqual(
        Buffer.from('abc\u0000binary')
      );
      expect(git.run(['ls-tree', second.record.treeSha]).toString()).not.toContain('empty');
    } finally {
      git.close();
    }
  });
  it.each([
    '120000',
    '160000',
  ])('baseline mode %s is unsupported even if candidate removes it', (mode) => {
    const base = baseline([
      {
        path: 'bad',
        mode,
        content: 'target',
        ...(mode === '160000' ? { sha: 'a'.repeat(40) } : {}),
      },
    ]);
    rejects(
      () => createCandidate(createManifest([]), approved(base.baseSha), base.pack),
      'unsupported'
    );
  });
  it.each([
    ['A', 'a'],
    ['é', 'e\u0301'],
  ])('baseline collision %s/%s is rejected', (a, b) => {
    const base = baseline([
      { path: a, mode: '100644' },
      { path: b, mode: '100644' },
    ]);
    rejects(
      () => createCandidate(createManifest([]), approved(base.baseSha), base.pack),
      'path_collision'
    );
  });
  it('baseline size limits cannot be bypassed by a small candidate', () => {
    const base = baseline([{ path: 'large', mode: '100644', content: '123456' }]);
    rejects(
      () =>
        createCandidate(createManifest([]), approved(base.baseSha), base.pack, { fileBytes: 5 }),
      'limit_exceeded'
    );
  });
  it('rejects wrong parent, altered approved author/login, manifest and recorded tree/commit tampering', () => {
    const base = baseline();
    const source = createManifest([file('file')]);
    const first = createCandidate(source, approved(base.baseSha), base.pack);
    const rebuild = (record = first.record, manifest = source) =>
      reconstructCandidate(manifest, record, first.authority, base.pack);
    rejects(() => rebuild({ ...first.record, baseSha: 'a'.repeat(40) }), 'wrong_parent');
    for (const field of ['name', 'email', 'timestamp', 'login']) {
      const value = field === 'timestamp' ? '2026-10-05T11:00:00Z' : 'Changed';
      rejects(
        () => rebuild({ ...first.record, author: { ...author, [field]: value } }),
        'altered_identity'
      );
    }
    rejects(
      () => rebuild(first.record, createManifest([file('file', 'changed')])),
      'tree_mismatch'
    );
    rejects(() => rebuild({ ...first.record, treeSha: 'a'.repeat(40) }), 'invalid_manifest');
    rejects(() => rebuild({ ...first.record, candidateSha: 'a'.repeat(40) }), 'invalid_manifest');
    rejects(() => rebuild({ ...first.record, message: 'other\n' }), 'invalid_manifest');
    rejects(
      () => rebuild({ ...first.record, committerTimestamp: '2026-10-05T12:00:00Z' }),
      'invalid_manifest'
    );
  });
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-10-05T10:00:00+00:00',
    '2026-10-05T10:00:00.001Z',
  ])('rejects noncanonical timestamp %s', (timestamp) => {
    const base = baseline();
    rejects(
      () =>
        createCandidate(
          createManifest([]),
          { ...approved(base.baseSha), author: { ...author, timestamp } },
          base.pack
        ),
      'altered_identity'
    );
  });
  it('rejects Git header injection and bad/missing baseline objects', () => {
    const base = baseline();
    rejects(
      () =>
        createCandidate(
          createManifest([]),
          { ...approved(base.baseSha), author: { ...author, name: 'Name\nparent injected' } },
          base.pack
        ),
      'altered_identity'
    );
    rejects(
      () => createCandidate(createManifest([]), approved('a'.repeat(40)), base.pack),
      'git_failed'
    );
    rejects(
      () => createCandidate(createManifest([]), approved(base.baseSha), Buffer.from('not a pack')),
      'unsupported'
    );
    rejects(
      () => createCandidate(createManifest([]), approved(base.baseSha), Buffer.alloc(0)),
      'limit_exceeded'
    );
  });
  it('real malicious attributes, filter driver, hooks, templates and inherited Git environment never execute', () => {
    const root = temp();
    const sentinel = join(root, 'sentinel');
    const repo = join(root, 'repo');
    const hooks = join(root, 'hooks');
    fs.mkdirSync(hooks);
    fs.mkdirSync(repo);
    const script = `#!/bin/sh\ntouch '${sentinel}'\ncat\n`;
    for (const hook of ['pre-commit', 'post-commit', 'prepare-commit-msg', 'commit-msg']) {
      fs.writeFileSync(join(hooks, hook), script, { mode: 0o755 });
    }
    const filter = join(root, 'filter');
    fs.writeFileSync(filter, script, { mode: 0o755 });
    const config = join(root, 'gitconfig');
    fs.writeFileSync(
      config,
      `[core]\n hooksPath = ${hooks}\n[filter "evil"]\n clean = ${filter}\n smudge = ${filter}\n required = true\n[credential]\n helper = !touch ${sentinel}\n`
    );
    // Real repo-local settings, not a mocked subprocess assertion.
    execFileSync('/usr/bin/git', ['init', '--template=', repo]);
    fs.appendFileSync(join(repo, '.git', 'config'), fs.readFileSync(config));
    fs.writeFileSync(join(repo, '.gitattributes'), '* filter=evil diff=evil\n');
    fs.writeFileSync(join(repo, 'payload'), 'unaltered\r\n');
    execFileSync('/usr/bin/git', ['-C', repo, 'add', 'payload']);
    expect(fs.existsSync(sentinel)).toBe(true); // Positive control: driver really executes.
    fs.unlinkSync(sentinel);
    execFileSync('/usr/bin/git', [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.org',
      'commit',
      '-m',
      'positive hook control',
    ]);
    expect(fs.existsSync(sentinel)).toBe(true); // Real repo-local hooks execute too.
    fs.unlinkSync(sentinel);
    const base = baseline();
    const sourceRoot = temp();
    fs.writeFileSync(join(sourceRoot, '.gitattributes'), '* filter=evil diff=evil text eol=lf\n');
    fs.writeFileSync(join(sourceRoot, 'payload'), 'unaltered\r\n');
    for (const [key, value] of Object.entries({
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_DIR: join(repo, '.git'),
      GIT_WORK_TREE: repo,
      GIT_TEMPLATE_DIR: root,
      GIT_OBJECT_DIRECTORY: join(repo, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/bad',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks,
      GIT_AUTHOR_NAME: 'attacker',
      GIT_COMMITTER_DATE: 'now',
      GIT_CONFIG_PARAMETERS: "'filter.evil.clean=touch sentinel'",
      GIT_SSH_COMMAND: `touch ${sentinel}`,
      PATH: root,
      LD_PRELOAD: '/nonexistent/hostile.so',
      TMPDIR: '/nonexistent-worker-controlled-temp',
    }))
      vi.stubEnv(key, value);
    const candidate = createCandidate(exportSource(sourceRoot), approved(base.baseSha), base.pack);
    reconstructCandidate(
      exportSource(sourceRoot),
      candidate.record,
      candidate.authority,
      base.pack
    );
    expect(fs.existsSync(sentinel)).toBe(false);
    const git = new TrustedGit();
    try {
      expect(git.run(['config', '--get', 'core.hooksPath']).toString().trim()).toBe('/dev/null');
      expect(git.run(['config', '--get', 'protocol.allow']).toString().trim()).toBe('never');
      expect(
        git
          .run(['config', '--get', 'core.hooksPath'], undefined, {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: hooks,
            HOME: root,
          })
          .toString()
          .trim()
      ).toBe('/dev/null');
      rejects(() => git.run(['ls-remote', repo]), 'git_failed');
      git.run(['index-pack', '--strict', '--stdin'], candidate.pack);
      expect(git.run(['cat-file', 'blob', `${candidate.record.treeSha}:payload`]).toString()).toBe(
        'unaltered\r\n'
      );
    } finally {
      git.close();
    }
  });
});
