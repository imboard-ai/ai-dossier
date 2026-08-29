import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createExecFn, parseBoundaryCommits, runAttributionBisect } from '../index';

/**
 * Stage-2 attribution (#472 AC1) against REAL git: a scratch repo with seeded
 * member commits, exactly one of which breaks the test command.
 *
 * The checker script is committed once at the base and never changes, so the
 * only thing that varies across the bisect is the members' own work — which is
 * what makes the first-bad commit meaningful.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** `node check.cjs` exits non-zero exactly when `value.txt` says `broken`. */
const CHECKER =
  "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='broken'?1:0)";

/**
 * A scratch repo whose history is `commits`, on top of a base that carries the
 * checker. Returns the repo path, the base sha and the head sha.
 */
function scratchRepo(commits: Array<{ subject: string; value?: string; file?: string }>): {
  repo: string;
  base: string;
  head: string;
} {
  const repo = tmpDir('sched-bisect-');
  git(['init', '--initial-branch=main', '.'], repo);
  git(['config', 'user.email', 'sched@test'], repo);
  git(['config', 'user.name', 'sched test'], repo);
  fs.writeFileSync(path.join(repo, 'check.cjs'), CHECKER);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'ok\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base: checker + value'], repo);
  const base = git(['rev-parse', 'HEAD'], repo).trim();

  for (const commit of commits) {
    if (commit.value !== undefined) {
      fs.writeFileSync(path.join(repo, 'value.txt'), `${commit.value}\n`);
    }
    if (commit.file !== undefined) {
      fs.writeFileSync(path.join(repo, commit.file), 'x\n');
    }
    git(['add', '.'], repo);
    git(['commit', '-m', commit.subject], repo);
  }
  return { repo, base, head: git(['rev-parse', 'HEAD'], repo).trim() };
}

function boundaryOf(repo: string, base: string): ReturnType<typeof parseBoundaryCommits> {
  return parseBoundaryCommits(
    git(['log', '--reverse', '--format=%H%x09%s', `${base}..HEAD`], repo)
  );
}

const exec = createExecFn(120_000);
const TEST_COMMAND = ['node', 'check.cjs'];

describe('runAttributionBisect (real git)', () => {
  it('finds the member whose commit broke the failing test', () => {
    const { repo, base } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'feat: member b (#202)', value: 'broken' },
      { subject: 'feat: member c (#203)', file: 'c.txt' },
    ]);
    const boundary = boundaryOf(repo, base);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: git(['rev-parse', 'HEAD'], repo).trim(),
      testCommand: TEST_COMMAND,
      boundary,
    });

    expect(outcome.kind).toBe('first-bad');
    if (outcome.kind !== 'first-bad') return;
    expect(outcome.issue).toBe(202);
    expect(outcome.sha).toBe(boundary[1].sha);
  });

  it('leaves the worktree clean and back on its branch', () => {
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'feat: member b (#202)', value: 'broken' },
    ]);
    runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary: boundaryOf(repo, base),
    });

    expect(git(['status', '--porcelain'], repo).trim()).toBe('');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('main');
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);
    expect(fs.existsSync(path.join(repo, '.git', 'BISECT_START'))).toBe(false);
  });

  it('reports green when the failing tests already pass at head', () => {
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'fix: member b (#202)', value: 'ok-b' },
    ]);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary: boundaryOf(repo, base),
    });

    expect(outcome).toEqual({ kind: 'green' });
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('main');
  });

  it('reports unattributable when the first bad commit belongs to no member', () => {
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'chore: batch-level fixup with no trailer', value: 'broken' },
    ]);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary: boundaryOf(repo, base),
    });

    expect(outcome.kind).toBe('unattributable');
    if (outcome.kind !== 'unattributable') return;
    expect(outcome.detail).toMatch(/no \(#N\) member trailer/);
  });

  it('refuses endpoints that are not shas rather than passing them to git', () => {
    const { repo, base } = scratchRepo([{ subject: 'feat: a (#201)', value: 'broken' }]);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: '--upload-pack=touch /tmp/pwned',
      testCommand: TEST_COMMAND,
      boundary: [],
    });
    expect(outcome).toEqual({
      kind: 'error',
      detail: expect.stringContaining('invalid bisect endpoints'),
    });
  });

  it('refuses an empty test command', () => {
    const { repo, base, head } = scratchRepo([{ subject: 'feat: a (#201)', value: 'broken' }]);
    expect(
      runAttributionBisect(exec, {
        repoDir: repo,
        good: base,
        bad: head,
        testCommand: [],
        boundary: [],
      })
    ).toEqual({ kind: 'error', detail: 'bisect test command is empty' });
  });
});
