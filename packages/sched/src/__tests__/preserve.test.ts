import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createExecFn,
  findGatedWorkEvidence,
  isRegisteredWorktree,
  preservedWorkInstruction,
  preserveWork,
  probeWorktree,
  rescueRefName,
  rescueUnitSlug,
} from '../index';

const NOW = new Date('2026-09-29T12:34:56.789Z');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('preserveWork (#945 ask 3, #940 ask 1)', () => {
  let root: string;
  let origin: string;
  let wt: string;
  const exec = createExecFn(30_000);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-preserve-'));
    origin = path.join(root, 'origin.git');
    wt = path.join(root, 'wt');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'clone', '-q', origin, wt);
    git(wt, 'config', 'user.name', 't');
    git(wt, 'config', 'user.email', 't@t');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'init');
    git(wt, 'push', '-q', 'origin', 'HEAD:main');
    git(wt, 'fetch', '-q');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('slugs and names refs safely', () => {
    expect(rescueUnitSlug('batch:b-20260929-01#601')).toBe('batch-b-20260929-01-601');
    expect(rescueRefName('issue:7', NOW)).toBe('rescue/issue-7-20260929T123456Z');
  });

  it('a clean, fully pushed worktree is left alone', () => {
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    expect(r.kind).toBe('clean');
    expect(git(wt, 'for-each-ref', 'refs/heads/rescue')).toBe('');
  });

  it('not a worktree root is skipped, never guessed', () => {
    const sub = path.join(wt, 'sub');
    fs.mkdirSync(sub);
    expect(preserveWork(exec, { worktree: sub, unit: 'issue:7', now: NOW }).kind).toBe('skipped');
    expect(probeWorktree(exec, path.join(root, 'missing'))).toBeNull();
  });

  it('preserves modified + untracked + unpushed work on a pushed rescue ref, leaving the worktree exactly as it was', () => {
    fs.writeFileSync(path.join(wt, 'b.txt'), 'unpushed commit\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'local only');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nmodified\n');
    fs.writeFileSync(path.join(wt, 'gated-fix.ts'), 'export const x = 1;\n');
    git(wt, 'add', 'a.txt'); // staged state must survive too
    const headBefore = git(wt, 'rev-parse', 'HEAD');
    const statusBefore = git(wt, 'status', '--porcelain');

    const r = preserveWork(exec, { worktree: wt, unit: 'batch:b-1', now: NOW });
    expect(r.kind).toBe('preserved');
    if (r.kind !== 'preserved') return;
    expect(r.work).toMatchObject({
      ref: 'rescue/batch-b-1-20260929T123456Z',
      pushed: true,
      reused: false,
      dirty_files: 2,
      unpushed_commits: 1,
      head: headBefore,
    });

    // worktree, index and HEAD untouched
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(wt, 'status', '--porcelain')).toBe(statusBefore);
    expect(fs.readFileSync(path.join(wt, 'gated-fix.ts'), 'utf8')).toContain('x = 1');

    // the rescue commit carries EVERYTHING and descends from the dead agent's HEAD
    const sha = r.work.sha;
    expect(git(wt, 'rev-parse', `${sha}^`)).toBe(headBefore);
    expect(git(wt, 'show', `${sha}:gated-fix.ts`)).toContain('x = 1');
    expect(git(wt, 'show', `${sha}:a.txt`)).toContain('modified');
    expect(git(wt, 'show', `${sha}:b.txt`)).toContain('unpushed commit');
    // and reached origin
    expect(git(origin, 'rev-parse', `refs/heads/${r.work.ref}`)).toBe(sha);
  });

  it('is idempotent for an unchanged tree and mints a new ref once the tree changes', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const first = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    const again = preserveWork(exec, {
      worktree: wt,
      unit: 'issue:7',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(first.kind === 'preserved' && again.kind === 'preserved').toBe(true);
    if (first.kind !== 'preserved' || again.kind !== 'preserved') return;
    expect(again.work.reused).toBe(true);
    expect(again.work.ref).toBe(first.work.ref);
    expect(again.work.sha).toBe(first.work.sha);

    fs.writeFileSync(path.join(wt, 'w2.txt'), 'more\n');
    const changed = preserveWork(exec, {
      worktree: wt,
      unit: 'issue:7',
      now: new Date(NOW.getTime() + 120_000),
    });
    expect(changed.kind === 'preserved' && changed.work.reused).toBe(false);
    expect(git(wt, 'for-each-ref', 'refs/heads/rescue/issue-7-*')).not.toBe('');
  });

  it('a failed push is reported but the local ref and the worktree survive', () => {
    git(wt, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    expect(r.kind).toBe('preserved');
    if (r.kind !== 'preserved') return;
    expect(r.work.pushed).toBe(false);
    expect(git(wt, 'rev-parse', `refs/heads/${r.work.ref}`)).toBe(r.work.sha);
    expect(preservedWorkInstruction(r.work)).toContain('saved locally as branch');
  });

  it('the instruction names the ref and forbids resetting to the pushed head', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    if (r.kind !== 'preserved') throw new Error('expected preserved');
    const text = preservedWorkInstruction(r.work);
    expect(text).toContain(r.work.ref);
    expect(text).toContain('pushed to origin/');
    expect(text).toMatch(/do not\s+reset/);
  });

  it('isRegisteredWorktree only accepts registered absolute paths', () => {
    const linked = path.join(root, 'linked');
    git(wt, 'worktree', 'add', '-q', '-b', 'x', linked);
    expect(isRegisteredWorktree(exec, wt, fs.realpathSync(linked))).toBe(true);
    expect(isRegisteredWorktree(exec, wt, '/etc')).toBe(false);
    expect(isRegisteredWorktree(exec, wt, 'relative')).toBe(false);
  });
});

describe('findGatedWorkEvidence (#940 ask 1)', () => {
  let dir: string;
  let capsFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-gate-ev-'));
    capsFile = path.join(dir, 'caps.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (...rows: Record<string, unknown>[]) =>
    fs.writeFileSync(capsFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\ngarbage\n`);
  const base = { capability: 'gate.batch', outcome: 'ok', cwd: '/wt' };
  const q = (o: Partial<Parameters<typeof findGatedWorkEvidence>[0]> = {}) =>
    findGatedWorkEvidence({
      capsFile,
      worktree: '/wt',
      sinceIso: '2026-09-29T10:00:00Z',
      headTree: 'HEADTREE',
      hasLocalWork: true,
      ...o,
    });

  it('a gate row after the pushed head that ran on a dirty tree is evidence', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: true, git_tree: 'HEADTREE' });
    expect(q()).toMatchObject({ dirty: true });
  });

  it('with #941 fields, a row verifying exactly the current clean HEAD tree is not evidence; a different tree is', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: false, git_tree: 'HEADTREE' });
    expect(q()).toBeNull();
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: false, git_tree: 'OTHER' });
    expect(q()).not.toBeNull();
  });

  it('a legacy row (no git fields) counts only while the worktree holds local work', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z' });
    expect(q({ hasLocalWork: true })).not.toBeNull();
    expect(q({ hasLocalWork: false })).toBeNull();
  });

  it('ignores rows before the pushed head, other worktrees, failures and other capabilities', () => {
    write(
      { ...base, timestamp: '2026-09-29T09:00:00Z', dirty: true },
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true, cwd: '/elsewhere' },
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true, outcome: 'task-failed' },
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true, capability: 'lint.run' }
    );
    expect(q()).toBeNull();
    expect(q({ capsFile: path.join(dir, 'missing.jsonl') })).toBeNull();
  });
});
