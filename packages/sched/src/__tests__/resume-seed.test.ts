import { describe, expect, it } from 'vitest';
import { createExecResumeSeeder } from '../index';

/** #840: the exec-backed resume-trail seeder's CLI contract. */
describe('createExecResumeSeeder', () => {
  const seed = {
    branch: 'batch/b-840-m1-840',
    baseBranch: 'main',
    batch: 'b-840',
    worktree: '/repo/worktrees/batch-b-840-m1-840',
  };

  it('mints a run, then posts a setup-done milestone on the member branch', () => {
    const calls: string[][] = [];
    const seeder = createExecResumeSeeder(
      (file, args) => {
        calls.push([file, ...args]);
        return args[1] === 'mint' ? 'r-840-abc123\n' : '';
      },
      { repoDir: '/repo' }
    );

    expect(seeder(840, seed)).toEqual({ ok: true, run: 'r-840-abc123' });
    expect(calls[0]).toEqual(['ai-dossier', 'runstate', 'mint', '--issue', '840']);
    const post = calls[1] ?? [];
    expect(post.slice(0, 11)).toEqual([
      'ai-dossier',
      'runstate',
      'post',
      '--issue',
      '840',
      '--phase',
      'setup',
      '--status',
      'done',
      '--run',
      'r-840-abc123',
    ]);
    for (const kv of [
      'branch=batch/b-840-m1-840',
      'worktree=/repo/worktrees/batch-b-840-m1-840',
      'pool_claimed=false',
      'base_branch=main',
      'remote=pushed',
    ]) {
      expect(post).toContain(kv);
    }
    // Never `batch=`: runstate verify reads a last milestone carrying it as a
    // slot-mode trail and enters fresh — the opposite of this seed.
    expect(post.some((a) => a.startsWith('batch='))).toBe(false);
  });

  it('fails with a reason (and posts nothing) when mint returns no run id', () => {
    const calls: string[][] = [];
    const seeder = createExecResumeSeeder((file, args) => {
      calls.push([file, ...args]);
      return null;
    });
    expect(seeder(840, seed)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it('fails when the post fails', () => {
    const seeder = createExecResumeSeeder((_file, args) =>
      args[1] === 'mint' ? 'r-840-abc123' : null
    );
    expect(seeder(840, seed)).toMatchObject({ ok: false });
  });

  it('refuses a branch that is not a plain ref before any exec', () => {
    let execs = 0;
    const seeder = createExecResumeSeeder(() => {
      execs += 1;
      return '';
    });
    expect(seeder(840, { ...seed, branch: '--upload-pack=pwn' })).toMatchObject({ ok: false });
    expect(execs).toBe(0);
  });
});
