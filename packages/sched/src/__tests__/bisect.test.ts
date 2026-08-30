/**
 * Integration tests for the #472 attribution bisect: REAL git on scratch
 * repos, seeded failures, deterministic outcomes — no LLM, no network (the
 * issue's test strategy: "scripted scratch-repo fixtures with seeded
 * failures; deterministic").
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBoundaryCommits, readBoundaries, runAttributionBisect } from '../index';
import { createExecFn, type ExecFn } from '../project';

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Real subprocess exec (like groundTruthExec, never throws). */
const exec: ExecFn = createExecFn(30_000);

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commit(cwd: string, message: string, files: Record<string, string | null>): string {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

/**
 * A scratch repo with a pushed `main` (the batch base) and a `batch/b1`
 * branch on top carrying one boundary commit per member. `broken` controls
 * which member introduces the failing marker.
 */
function batchRepo(members: { issue: number; broken?: boolean; trailer?: boolean }[]): {
  work: string;
  base: string;
} {
  const root = tmpDir('sched-bisect-');
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(['init', '--initial-branch=main', '.'], work);
  git(['config', 'user.email', 'sched@test'], work);
  git(['config', 'user.name', 'sched test'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'scratch\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();

  git(['checkout', '-b', 'batch/b1'], work);
  for (const member of members) {
    const label = member.trailer === false ? 'chore: batch fix' : `fix: thing (#${member.issue})`;
    commit(
      work,
      label,
      member.broken ? { 'broken.marker': 'broken\n' } : { [`f${member.issue}.txt`]: 'ok\n' }
    );
  }
  return { work, base };
}

/** The "suite": fails exactly when the seeded marker exists (exit 1). */
const MARKER_TEST = ['node', '-e', "process.exit(require('fs').existsSync('broken.marker')?1:0)"];

describe('runAttributionBisect (real git)', () => {
  it('attributes the first bad boundary commit to its member (AC: bisect attribution)', () => {
    const { work, base } = batchRepo([
      { issue: 201 },
      { issue: 202, broken: true },
      { issue: 203 },
    ]);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    const boundaries = parseBoundaryCommits(
      execFileSync('git', ['log', '--format=%H%x09%s', `${base}..HEAD`], {
        cwd: work,
        encoding: 'utf8',
      })
    );

    const outcome = runAttributionBisect(
      { exec, cwd: work },
      { base, head, boundaries, testCommand: MARKER_TEST }
    );
    expect(outcome).toMatchObject({ kind: 'first-bad', issue: 202 });

    // bisect always resets: the worktree is back on the branch, clean.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })).toBe(
      ''
    );
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: work,
        encoding: 'utf8',
      }).trim()
    ).toBe('batch/b1');
  });

  it('returns green when the failure does not reproduce at head (flake/infra)', () => {
    const { work, base } = batchRepo([{ issue: 201 }, { issue: 202 }, { issue: 203 }]);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    const outcome = runAttributionBisect(
      { exec, cwd: work },
      { base, head, boundaries: [], testCommand: MARKER_TEST }
    );
    expect(outcome).toEqual({ kind: 'green' });
  });

  it('maps a first-bad NON-boundary commit to issue null (unattributable)', () => {
    // The batch-level review fix commit (no trailer) breaks the suite.
    const { work, base } = batchRepo([
      { issue: 201 },
      { issue: 202 },
      { issue: 203 },
      { issue: 204, broken: true, trailer: false },
    ]);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
    const boundaries = parseBoundaryCommits(
      execFileSync('git', ['log', '--format=%H%x09%s', `${base}..HEAD`], {
        cwd: work,
        encoding: 'utf8',
      })
    );
    const outcome = runAttributionBisect(
      { exec, cwd: work },
      { base, head, boundaries, testCommand: MARKER_TEST }
    );
    expect(outcome).toMatchObject({ kind: 'first-bad', issue: null });
  });

  it('rejects invalid shas and empty test commands without touching git', () => {
    const { work } = batchRepo([{ issue: 201 }]);
    expect(
      runAttributionBisect(
        { exec, cwd: work },
        { base: 'nope!', head: 'abc', boundaries: [], testCommand: MARKER_TEST }
      )
    ).toMatchObject({ kind: 'error' });
    expect(
      runAttributionBisect(
        { exec, cwd: work },
        { base: '0123456', head: '1234567', boundaries: [], testCommand: [] }
      )
    ).toMatchObject({ kind: 'error' });
  });
});

describe('readBoundaries (real git)', () => {
  it('reads the member commits of the batch branch over the base', () => {
    const { work } = batchRepo([{ issue: 201 }, { issue: 202 }, { issue: 203 }]);
    const boundaries = readBoundaries({ exec, cwd: work }, 'main');
    // The base ref does not exist as origin/main in this scratch repo —
    // readBoundaries must return null, never a guess.
    expect(boundaries).toBeNull();
  });

  it('parses members when the base ref exists', () => {
    const root = tmpDir('sched-bisect-');
    const bare = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    fs.mkdirSync(bare, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    git(['init', '--bare', '--initial-branch=main', bare], root);
    git(['init', '--initial-branch=main', '.'], work);
    git(['config', 'user.email', 'sched@test'], work);
    git(['config', 'user.name', 'sched test'], work);
    git(['remote', 'add', 'origin', bare], work);
    fs.writeFileSync(path.join(work, 'README.md'), 'scratch\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'init'], work);
    git(['push', '-u', 'origin', 'main'], work);

    git(['checkout', '-b', 'batch/b1'], work);
    commit(work, 'fix: a (#201)', { 'a.txt': 'a\n' });
    commit(work, 'fix: b (#202)', { 'b.txt': 'b\n' });

    const boundaries = readBoundaries({ exec, cwd: work }, 'main');
    expect(boundaries?.map((b) => b.issue)).toEqual([202, 201]); // git log order: newest first
  });

  it('rejects unsafe base refs', () => {
    const { work } = batchRepo([{ issue: 201 }]);
    expect(readBoundaries({ exec, cwd: work }, 'main; rm -rf /')).toBeNull();
  });
});
