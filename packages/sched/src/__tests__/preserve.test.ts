import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyState,
  createExecFn,
  findGatedWorkEvidence,
  isRegisteredWorktree,
  preservedWorkInstruction,
  preserveWork,
  probeWorktree,
  pruneRescueRefs,
  RESCUE_REF_TTL_MS,
  rescueRefName,
  rescueUnitSlug,
  selectRescuableUntracked,
  takeoverWorktreeRefusal,
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
    expect(rescueRefName('issue:7', NOW)).toBe('issue-7-20260929T123456Z');
  });

  it('a clean, fully pushed worktree is left alone', () => {
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    expect(r.kind).toBe('clean');
    expect(git(wt, 'for-each-ref', 'refs/sched-rescue')).toBe('');
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
      ref: 'refs/sched-rescue/batch-b-1-20260929T123456Z',
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
    expect(git(origin, 'rev-parse', r.work.ref)).toBe(sha);
    // a NON-branch namespace: no branch on origin, no rescue/* head anywhere
    expect(git(origin, 'for-each-ref', 'refs/heads')).not.toContain('rescue');
    expect(git(wt, 'for-each-ref', 'refs/heads')).not.toContain('rescue');
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
    expect(git(wt, 'for-each-ref', 'refs/sched-rescue/issue-7-*').split('\n')).toHaveLength(2);
  });

  it('a failed push is reported but the local ref and the worktree survive', () => {
    git(wt, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    expect(r.kind).toBe('preserved');
    if (r.kind !== 'preserved') return;
    expect(r.work.pushed).toBe(false);
    expect(git(wt, 'rev-parse', r.work.ref)).toBe(r.work.sha);
    expect(preservedWorkInstruction(r.work)).toContain('saved locally as refs/sched-rescue/');
  });

  it('the instruction names the ref and forbids resetting to the pushed head', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const r = preserveWork(exec, { worktree: wt, unit: 'issue:7', now: NOW });
    if (r.kind !== 'preserved') throw new Error('expected preserved');
    const text = preservedWorkInstruction(r.work);
    expect(text).toContain(r.work.ref);
    expect(text).toContain('pushed to origin as refs/sched-rescue/');
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

describe('preserveWork security and robustness (#945 review)', () => {
  let root: string;
  let origin: string;
  let wt: string;
  const exec = createExecFn(30_000);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-preserve-sec-'));
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
  const rescue = (unit = 'issue:7', now = NOW) => {
    const r = preserveWork(exec, { worktree: wt, unit, now });
    if (r.kind !== 'preserved') throw new Error(`expected preserved, got ${r.kind}`);
    return r.work;
  };
  const filesIn = (sha: string) => git(wt, 'ls-tree', '-r', '--name-only', sha).split('\n');

  it('never pushes secret-looking untracked or staged-new files; tracked changes and safe untracked files are kept', () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nedit\n'); // tracked change
    fs.writeFileSync(path.join(wt, 'safe.ts'), 'ok\n');
    for (const f of [
      '.env',
      '.env.local',
      'server.pem',
      'tls.key',
      'id_rsa',
      'id_ed25519.pub',
      'aws-credentials.json',
      'store.p12',
      'store.pfx',
      'my-secret-notes.txt',
    ]) {
      fs.writeFileSync(path.join(wt, f), 'TOPSECRET\n');
    }
    fs.writeFileSync(path.join(wt, 'staged.env'), 'x\n');
    fs.writeFileSync(path.join(wt, '.env.staged'), 'STAGED-SECRET\n');
    git(wt, 'add', '.env.staged'); // staged-new secret: also excluded
    const work = rescue();
    const files = filesIn(work.sha);
    expect(files).toContain('safe.ts');
    expect(files).toContain('a.txt');
    for (const f of [
      '.env',
      '.env.local',
      'server.pem',
      'tls.key',
      'id_rsa',
      'id_ed25519.pub',
      'aws-credentials.json',
      'store.p12',
      'store.pfx',
      'my-secret-notes.txt',
      '.env.staged',
    ]) {
      expect(files).not.toContain(f);
    }
    expect(git(wt, 'show', `${work.sha}:a.txt`)).toContain('edit');
    expect(work.skipped.secret).toBeGreaterThanOrEqual(11);
    // still in the worktree, untouched
    expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('TOPSECRET\n');
    expect(preservedWorkInstruction(work)).toMatch(/secret pattern/);
    // and nothing secret reached origin
    expect(git(origin, 'ls-tree', '-r', '--name-only', work.ref)).not.toMatch(
      /env|pem|key|secret|credentials/
    );
  });

  it('caps untracked file size and count; the rest stays in the worktree', () => {
    fs.writeFileSync(path.join(wt, 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
    fs.writeFileSync(path.join(wt, 'small.txt'), 's\n');
    const work = rescue();
    expect(filesIn(work.sha)).toContain('small.txt');
    expect(filesIn(work.sha)).not.toContain('big.bin');
    expect(work.skipped.large).toBe(1);
    const many = Array.from({ length: 510 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    const sel = selectRescuableUntracked(
      wt,
      many.map((f) => (fs.writeFileSync(path.join(wt, f), 'x'), f))
    );
    expect(sel.allowed).toHaveLength(500);
    expect(sel.skipped.over_limit).toBe(10);
  });

  it('a filename with glob characters is added literally and matches nothing else', () => {
    fs.writeFileSync(path.join(wt, 'a[1].txt'), 'x\n');
    fs.writeFileSync(path.join(wt, 'a1.txt'), 'y\n');
    const work = rescue();
    expect(filesIn(work.sha)).toEqual(expect.arrayContaining(['a[1].txt', 'a1.txt']));
  });

  it('is seeded from the real index: staged content (even when the file is later reverted on disk) is preserved', () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'staged version\n');
    git(wt, 'add', 'a.txt');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'worktree version\n');
    const work = rescue();
    expect(git(wt, 'show', `${work.sha}:a.txt`)).toBe('worktree version');
    expect(git(wt, 'diff', '--cached', '--name-only')).toBe('a.txt'); // real index untouched
  });

  it('same-second rescues with different trees never overwrite each other', () => {
    fs.writeFileSync(path.join(wt, 'w1.txt'), '1\n');
    const a = rescue();
    fs.writeFileSync(path.join(wt, 'w2.txt'), '2\n');
    const b = rescue(); // same NOW
    expect(b.ref).not.toBe(a.ref);
    expect(git(wt, 'rev-parse', a.ref)).toBe(a.sha);
    expect(git(wt, 'rev-parse', b.ref)).toBe(b.sha);
  });

  it("unit slugs that are a prefix of each other do not reuse each other's rescue", () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'same tree\n');
    const a = rescue('batch:b-1');
    const b = rescue('batch:b-1-2', new Date(NOW.getTime() + 5_000));
    expect(b.reused).toBe(false);
    expect(b.ref).not.toBe(a.ref);
  });

  it('a reused rescue is not re-pushed every tick', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const first = rescue();
    expect(first.pushed).toBe(true);
    git(wt, 'remote', 'set-url', 'origin', path.join(root, 'gone.git')); // a re-push would now fail
    const again = rescue('issue:7', new Date(NOW.getTime() + 60_000));
    expect(again.reused).toBe(true);
    expect(again.pushed).toBe(true);
  });

  it('counts (not listings) keep a large dirty tree from overflowing the probe', () => {
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(wt, `n${i}.txt`), 'x');
    expect(probeWorktree(exec, wt)?.dirty_files).toBe(300);
  });

  it('prunes rescue refs past the TTL locally and on origin, keeps fresh ones', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const old = rescue();
    fs.writeFileSync(path.join(wt, 'w2.txt'), 'wip2\n');
    const fresh = rescue('issue:8', new Date(NOW.getTime() + 10 * 24 * 3_600_000));
    // rescue commit dates are "now" of the real clock; prune relative to a far-future clock for `old` only
    const future = new Date(Date.now() + RESCUE_REF_TTL_MS + 3_600_000);
    const pruned = pruneRescueRefs(exec, wt, future);
    expect(pruned.sort()).toEqual([old.ref, fresh.ref].sort());
    expect(git(wt, 'for-each-ref', 'refs/sched-rescue')).toBe('');
    expect(git(origin, 'for-each-ref', 'refs/sched-rescue')).toBe('');
    expect(pruneRescueRefs(exec, wt, new Date())).toEqual([]);
  });

  it('keeps a local rescue whose remote deletion failed for a non-"already gone" reason', () => {
    fs.writeFileSync(path.join(wt, 'w.txt'), 'wip\n');
    const work = rescue();
    git(wt, 'remote', 'set-url', 'origin', path.join(root, 'unreachable.git'));
    const pruned = pruneRescueRefs(exec, wt, new Date(Date.now() + RESCUE_REF_TTL_MS + 1000));
    expect(pruned).toEqual([]);
    expect(git(wt, 'rev-parse', work.ref)).toBe(work.sha);
  });

  describe('takeoverWorktreeRefusal', () => {
    it('refuses the main checkout, unregistered paths, paths outside the worktree roots and batch-claimed worktrees', () => {
      const state = createEmptyState();
      const opts = (worktree: string, st = state) => ({
        repoDir: wt,
        worktree,
        state: st,
        unit: 'issue:7',
      });
      expect(takeoverWorktreeRefusal(exec, opts(fs.realpathSync(wt)))).toBe('main-checkout');
      expect(takeoverWorktreeRefusal(exec, opts('/etc'))).toBe('not-a-registered-worktree');
      // registered, but not under a `worktrees/` root
      const stray = path.join(root, 'stray');
      git(wt, 'worktree', 'add', '-q', '-b', 'stray', stray);
      expect(takeoverWorktreeRefusal(exec, opts(fs.realpathSync(stray)))).toBe(
        'outside-worktree-roots'
      );
      // registered + under <repo>/../worktrees, but a batch holds it
      const ok = path.join(root, 'worktrees', 'issue-7');
      git(wt, 'worktree', 'add', '-q', '-b', 'issue-7', ok);
      const real = fs.realpathSync(ok);
      expect(takeoverWorktreeRefusal(exec, opts(real))).toBeNull();
      const claimed = {
        ...state,
        batches: [{ id: 'b-1', worktree: real, member_worktree: null, member_runs: [] }],
      } as unknown as typeof state;
      expect(takeoverWorktreeRefusal(exec, opts(real, claimed))).toBe('claimed-by-batch:b-1');
    });
  });
});

describe('findGatedWorkEvidence (#940 ask 1, #941 fields)', () => {
  let dir: string;
  let capsFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-gate-ev-'));
    capsFile = path.join(dir, 'caps.jsonl');
    base = { capability: 'gate.batch', outcome: 'ok', cwd: dir, git_tree: 'T' };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (...rows: Record<string, unknown>[]) =>
    fs.writeFileSync(capsFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\ngarbage\n`);
  let base: Record<string, unknown>;
  const q = (o: Partial<Parameters<typeof findGatedWorkEvidence>[0]> = {}) =>
    findGatedWorkEvidence({
      capsFile,
      worktree: dir,
      sinceIso: '2026-09-29T10:00:00Z',
      hasLocalWork: true,
      now: new Date('2026-09-29T13:00:00Z'),
      ...o,
    });

  it('a passing gate row after the pushed head that ran on a DIRTY tree is evidence', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: true });
    expect(q()).toMatchObject({ dirty: true });
  });

  it('a clean row is never evidence (its code was a commit), whatever tree it verified', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: false, git_tree: 'OTHER' });
    expect(q()).toBeNull();
  });

  it("LEGACY rows (no git fields) — the engine's own post-landing gate rows — are ignored", () => {
    write({ capability: 'gate.batch', outcome: 'ok', cwd: dir, timestamp: '2026-09-29T11:35:00Z' });
    expect(q()).toBeNull();
  });

  it('only the NEWEST matching row decides: a later clean or failed row supersedes an old dirty one', () => {
    write(
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true },
      { ...base, timestamp: '2026-09-29T11:30:00Z', dirty: false }
    );
    expect(q()).toBeNull();
    write(
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true },
      { ...base, timestamp: '2026-09-29T11:30:00Z', dirty: true, outcome: 'task-failed' }
    );
    expect(q()).toBeNull();
  });

  it('a probe-failed row counts as dirty', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: true, git_probe: 'timeout' });
    expect(q()).not.toBeNull();
  });

  it('needs local work, ignores rows before the pushed head, other worktrees and other capabilities', () => {
    write({ ...base, timestamp: '2026-09-29T11:35:00Z', dirty: true });
    expect(q({ hasLocalWork: false })).toBeNull();
    write(
      { ...base, timestamp: '2026-09-29T09:00:00Z', dirty: true },
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true, cwd: '/elsewhere' },
      { ...base, timestamp: '2026-09-29T11:00:00Z', dirty: true, capability: 'lint.run' }
    );
    expect(q()).toBeNull();
    expect(q({ capsFile: path.join(dir, 'missing.jsonl') })).toBeNull();
  });

  it('compares worktree paths by realpath and ignores a future-dated pushed head (clock skew)', () => {
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      write({ ...base, cwd: link, timestamp: '2026-09-29T11:35:00Z', dirty: true });
      expect(q()).not.toBeNull();
      expect(q({ sinceIso: '2030-01-01T00:00:00Z' })).not.toBeNull();
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});
