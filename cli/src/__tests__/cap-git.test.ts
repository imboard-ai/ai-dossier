import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureGitState, mergeGitStates } from '../cap-git';
import { type CapLogEntry, findLastOk, hashCapArgs } from '../cap-log';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'i');
}

describe('captureGitState (#941)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-git-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('omits git state outside a work tree', () => {
    expect(captureGitState(dir)).toBeNull();
  });

  it('omits git state in a repo with no commit yet', () => {
    git(dir, 'init', '-q');
    expect(captureGitState(dir)).toBeNull();
  });

  it('reports head, tree and dirty inside a work tree', () => {
    initRepo(dir);
    expect(captureGitState(dir)).toEqual({
      git_head: git(dir, 'rev-parse', 'HEAD'),
      git_tree: git(dir, 'rev-parse', 'HEAD^{tree}'),
      dirty: false,
    });
    fs.writeFileSync(path.join(dir, 'x'), 'y');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('staged-only changes are dirty', () => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    git(dir, 'add', 'a.txt');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('detached HEAD is reported clean and dirty like any other', () => {
    initRepo(dir);
    git(dir, 'checkout', '-q', '--detach');
    expect(captureGitState(dir)).toMatchObject({ dirty: false });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('works in a linked worktree', () => {
    initRepo(dir);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-git-wt-'));
    try {
      git(dir, 'worktree', 'add', '-q', '--detach', wt);
      expect(captureGitState(wt)).toMatchObject({ dirty: false });
      fs.writeFileSync(path.join(wt, 'new'), 'n');
      expect(captureGitState(wt)?.dirty).toBe(true);
      expect(captureGitState(dir)?.dirty).toBe(false);
    } finally {
      git(dir, 'worktree', 'remove', '--force', wt);
    }
  });

  it('is not fooled by status.showUntrackedFiles=no', () => {
    initRepo(dir);
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(dir, 'untracked'), 'u');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('is not fooled by --assume-unchanged or --skip-worktree', () => {
    initRepo(dir);
    git(dir, 'update-index', '--assume-unchanged', 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit');
    expect(captureGitState(dir)?.dirty).toBe(true);
    git(dir, 'update-index', '--no-assume-unchanged', 'a.txt');
    git(dir, 'checkout', '--', 'a.txt');
    expect(captureGitState(dir)?.dirty).toBe(false);
    git(dir, 'update-index', '--skip-worktree', 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hidden edit');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('ignores inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', () => {
    initRepo(dir);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-git-other-'));
    const saved = { ...process.env };
    try {
      git(other, 'init', '-q');
      fs.writeFileSync(path.join(other, 'z'), 'z');
      git(other, 'add', 'z');
      git(other, 'commit', '-q', '-m', 'o');
      process.env.GIT_DIR = path.join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
      expect(captureGitState(dir)?.git_tree).toBe(
        execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
          cwd: dir,
          encoding: 'utf8',
          env: Object.fromEntries(Object.entries(saved).filter(([k]) => !k.startsWith('GIT_'))),
        }).trim()
      );
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      delete process.env.GIT_INDEX_FILE;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('mergeGitStates (#941)', () => {
  const s = { git_head: 'h', git_tree: 't', dirty: false };
  it('is clean only when both probes are clean and nothing moved', () => {
    expect(mergeGitStates(s, s)?.dirty).toBe(false);
    expect(mergeGitStates(s, { ...s, dirty: true })?.dirty).toBe(true);
    expect(mergeGitStates(s, { ...s, git_head: 'h2' })?.dirty).toBe(true);
    expect(mergeGitStates(s, { ...s, git_tree: 't2' })?.dirty).toBe(true);
    expect(mergeGitStates({ ...s, dirty: true }, s)?.dirty).toBe(true);
  });
  it('a failed after-probe marks the row dirty and probe-flagged; no before means no state', () => {
    expect(mergeGitStates(s, null)).toMatchObject({ dirty: true, git_probe: 'error' });
    expect(mergeGitStates(null, s)).toBeNull();
  });
});

describe('findLastOk (#941)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-lastok-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const row = (o: Partial<CapLogEntry>): CapLogEntry => ({
    timestamp: 't',
    capability: 'gate.batch',
    outcome: 'ok',
    exit_code: 0,
    duration_ms: 1,
    reason: null,
    signal: null,
    cwd: '/x',
    git_tree: 'T1',
    dirty: false,
    args: [],
    args_hash: hashCapArgs([]),
    ...o,
  });
  const write = (file: string, rows: unknown[], tail = '') =>
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${tail}`);

  it('returns the latest clean ok row for the tree, never a dirty one', () => {
    const file = path.join(dir, 'caps.jsonl');
    write(
      file,
      [
        row({ timestamp: 'a' }),
        row({ timestamp: 'b' }),
        row({ timestamp: 'c', dirty: true }),
        row({ timestamp: 'd', outcome: 'task-failed' }),
        row({ timestamp: 'e', git_tree: 'T2' }),
        row({ timestamp: 'f', git_probe: 'timeout' }),
      ],
      'garbage\n'
    );
    expect(findLastOk('gate.batch', 'T1', [], file)?.timestamp).toBe('b');
    expect(findLastOk('gate.batch', 'T3', [], file)).toBeNull();
    expect(findLastOk('other', 'T1', [], file)).toBeNull();
    write(file, [row({ dirty: true })]);
    expect(findLastOk('gate.batch', 'T1', [], file)).toBeNull();
    expect(findLastOk('gate.batch', 'T1', [], path.join(dir, 'missing'))).toBeNull();
  });

  it('a run with different args never satisfies a lookup (--only smoke != full gate)', () => {
    const file = path.join(dir, 'caps.jsonl');
    const smoke = ['--only', 'smoke'];
    write(file, [
      row({ timestamp: 'smoke', args: smoke, args_hash: hashCapArgs(smoke) }),
      row({ timestamp: 'legacy', args_hash: undefined, args: undefined }),
    ]);
    expect(findLastOk('gate.batch', 'T1', [], file)).toBeNull();
    expect(findLastOk('gate.batch', 'T1', smoke, file)?.timestamp).toBe('smoke');
    expect(findLastOk('gate.batch', 'T1', ['--only', 'other'], file)).toBeNull();
  });

  it('tolerates a torn line mid-file, even one glued to the next row', () => {
    const file = path.join(dir, 'caps.jsonl');
    const good = JSON.stringify(row({ timestamp: 'good' }));
    fs.writeFileSync(
      file,
      `${JSON.stringify(row({ timestamp: 'older' }))}\n{"timestamp":"tor${good}\n{"timestamp":"half\n`
    );
    expect(findLastOk('gate.batch', 'T1', [], file)?.timestamp).toBe('good');
  });

  it('a non-ENOENT read error throws instead of pretending "no match"', () => {
    expect(() => findLastOk('gate.batch', 'T1', [], dir)).toThrow();
  });
});

describe('cap CLI wiring (#941)', () => {
  const cliPath = path.resolve(__dirname, '../../src/cli.ts');
  const tsxBin = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-repo-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-home-'));
    fs.mkdirSync(path.join(repo, '.dossier', 'automation'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.dossier', 'automation', 'manifest.yaml'),
      [
        'capabilities:',
        '  gate.test:',
        '    command: node -e "process.exit(0)" --',
        '    lifecycle: active',
        '',
      ].join('\n')
    );
    initRepo(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'manifest');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(tsxBin, [cliPath, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...process.env, HOME: home, ...env },
    });
  const tree = () => git(repo, 'rev-parse', 'HEAD^{tree}');

  it(
    'records git fields + args; last-ok matches only the same args; distinct exit codes',
    {
      timeout: 120_000,
    },
    () => {
      const runRes = cli(['cap', 'run', 'gate.test', '--', '--only', 'smoke']);
      expect(runRes.status).toBe(0);
      const lines = fs
        .readFileSync(path.join(home, '.dossier', 'caps.jsonl'), 'utf8')
        .trim()
        .split('\n');
      const logged = JSON.parse(lines[lines.length - 1]);
      expect(logged).toMatchObject({
        capability: 'gate.test',
        git_tree: tree(),
        git_head: git(repo, 'rev-parse', 'HEAD'),
        dirty: false,
        args: ['--only', 'smoke'],
        args_hash: hashCapArgs(['--only', 'smoke']),
      });

      const hit = cli(['cap', 'last-ok', 'gate.test', '--tree', tree(), '--', '--only', 'smoke']);
      expect(hit.status).toBe(0);
      expect(JSON.parse(hit.stdout).capability).toBe('gate.test');

      const full = cli(['cap', 'last-ok', 'gate.test', '--tree', tree()]);
      expect(full.status).toBe(1);
      expect(full.stdout).toBe('');

      expect(cli(['cap', 'last-ok', 'gate.test', '--tree', 'nothex']).status).toBe(2);

      const cfgDir = path.join(home, '.dossier');
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ auditLog: false }));
      expect(cli(['cap', 'last-ok', 'gate.test', '--tree', tree()]).status).toBe(3);
    }
  );

  it('a run that dirties the tree is recorded dirty and never reused', { timeout: 60_000 }, () => {
    fs.writeFileSync(
      path.join(repo, '.dossier', 'automation', 'manifest.yaml'),
      [
        'capabilities:',
        '  gate.test:',
        "    command: node -e \"require('fs').writeFileSync('side-effect','x')\"",
        '    lifecycle: active',
        '',
      ].join('\n')
    );
    git(repo, 'commit', '-qam', 'mutating gate');
    expect(cli(['cap', 'run', 'gate.test']).status).toBe(0);
    const row = JSON.parse(
      fs
        .readFileSync(path.join(home, '.dossier', 'caps.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .pop() as string
    );
    expect(row.dirty).toBe(true);
    expect(cli(['cap', 'last-ok', 'gate.test', '--tree', tree()]).status).toBe(1);
  });
});
