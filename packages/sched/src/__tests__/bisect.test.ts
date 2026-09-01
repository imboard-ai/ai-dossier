import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createExecFn, type ExecFn, parseBoundaryCommits, runAttributionBisect } from '../index';

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
 *
 * `checker` overrides the committed `check.cjs` body (defaults to `CHECKER`)
 * — the spoofing test below uses it to make the failing test print a forged
 * first-bad line, while still committing the checker ONCE at the base (it is
 * a constant string per call, so it never varies across the bisected commits).
 */
function scratchRepo(
  commits: Array<{ subject: string; value?: string; file?: string }>,
  checker: string = CHECKER
): {
  repo: string;
  base: string;
  head: string;
} {
  const repo = tmpDir('sched-bisect-');
  git(['init', '--initial-branch=main', '.'], repo);
  git(['config', 'user.email', 'sched@test'], repo);
  git(['config', 'user.name', 'sched test'], repo);
  fs.writeFileSync(path.join(repo, 'check.cjs'), checker);
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

/** Three members, exactly one (#202) breaking the test — the shared fixture for both the plain and spoofed bisect runs, so they stay provably identical. */
const THREE_MEMBERS: Array<{ subject: string; value?: string; file?: string }> = [
  { subject: 'feat: member a (#201)', value: 'ok-a' },
  { subject: 'feat: member b (#202)', value: 'broken' },
  { subject: 'feat: member c (#203)', file: 'c.txt' },
];

describe('runAttributionBisect (real git)', () => {
  it('finds the member whose commit broke the failing test', () => {
    const { repo, base, head } = scratchRepo(THREE_MEMBERS);
    const boundary = boundaryOf(repo, base);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary,
    });

    // The whole object, so a failure names git's own detail instead of just 'error'.
    expect(outcome).toMatchObject({ kind: 'first-bad' });
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

    expect(outcome).toMatchObject({ kind: 'unattributable' });
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

  // #503 finding 1 (superseded #472 review, carried into #498's implementation):
  // the failing test command's own stdout is interleaved into `git bisect
  // run`'s captured output, so member-authored test code could print a fake
  // "<sha> is the first bad commit" line to pin blame on an innocent member.
  // Production code closed this (bisect.ts): the result comes ONLY from
  // git's own `refs/bisect/bad` ref — set by git's bisect algorithm from the
  // test command's EXIT CODE alone — with no fallback that reads prose.
  it('is not fooled by a failing test that spoofs the "is the first bad commit" line', () => {
    // Composed from CHECKER (never restated) so the two stay in lockstep: the
    // real verdict comes from the exit code exactly as before, but first it
    // prints a forged blame line for whatever sha is in `blame.txt` — an
    // UNTRACKED file `git checkout`/`bisect` never touch, so it can name a
    // REAL commit's sha (unlike an arbitrary literal) filled in only after
    // the repo's actual shas are known, without ever changing what is
    // committed (the checker is still committed once, unchanged, at the base).
    const SPOOFING_CHECKER = `let __blame='';try{__blame=require('fs').readFileSync('blame.txt','utf8').trim()}catch(e){}if(__blame)console.log(__blame+' is the first bad commit');${CHECKER}`;
    const { repo, base, head } = scratchRepo(THREE_MEMBERS, SPOOFING_CHECKER);
    const boundary = boundaryOf(repo, base);
    // Forge blame onto member a's (#201) REAL, in-history sha — an innocent
    // member's own commit, exactly what a malicious member could obtain,
    // unlike a nonsense literal no attacker would gain anything from forging.
    const innocentSha = boundary[0].sha;
    fs.writeFileSync(path.join(repo, 'blame.txt'), innocentSha);

    const captured: string[] = [];
    const recordingExec: ExecFn = (file, args, cwd) => {
      const out = exec(file, args, cwd);
      if (out !== null) captured.push(out);
      return out;
    };

    const outcome = runAttributionBisect(recordingExec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary,
    });

    // Prove the forgery actually reached the stream the implementation reads
    // — otherwise this test could pass green for the wrong reason (e.g. if
    // the runner stopped capturing `git bisect run`'s stdout entirely).
    expect(captured.join('\n')).toContain(`${innocentSha} is the first bad commit`);

    // The spoofed line blames the INNOCENT member (#201) with a real sha —
    // if the parser had trusted it, this would resolve to 201, not 202.
    expect(outcome).toMatchObject({ kind: 'first-bad' });
    if (outcome.kind !== 'first-bad') return;
    expect(outcome.issue).toBe(202);
    expect(outcome.sha).toBe(boundary[1].sha);
    expect(outcome.sha).not.toBe(innocentSha);
  });
});

describe('runAttributionBisect refuses to guess', () => {
  it('errors instead of bisecting when the test command cannot run at all', () => {
    // A command that fails everywhere (missing binary) "fails at bad" exactly
    // like a real failure — bisecting on it would mark every commit bad and
    // blame the earliest member in the range.
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'feat: member b (#202)', value: 'broken' },
    ]);
    const outcome = runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: ['definitely-not-a-binary-xyz'],
      boundary: boundaryOf(repo, base),
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.detail).toMatch(/cannot discriminate/);
    // and it still leaves the checkout where it found it
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim()).toBe('main');
  });

  it('restores a detached checkout to the commit it started on', () => {
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member a (#201)', value: 'ok-a' },
      { subject: 'feat: member b (#202)', value: 'broken' },
    ]);
    // Start detached: `git bisect reset` alone would return to our own probe.
    git(['checkout', '--detach', head], repo);

    runAttributionBisect(exec, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary: boundaryOf(repo, base),
    });

    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);
    expect(git(['status', '--porcelain'], repo).trim()).toBe('');
  });

  it('reports cleanup failures through onWarn rather than silently', () => {
    const { repo, base, head } = scratchRepo([
      { subject: 'feat: member b (#202)', value: 'broken' },
    ]);
    const warnings: string[] = [];
    // A git that works until the cleanup, then fails it.
    let done = false;
    const failingCleanup = ((file, args, cwd) => {
      if (file === 'git' && args[0] === 'bisect' && args[1] === 'run') {
        done = true;
        return exec(file, args, cwd);
      }
      if (done && file === 'git' && (args[0] === 'bisect' || args[0] === 'checkout')) return null;
      return exec(file, args, cwd);
    }) as typeof exec;

    runAttributionBisect(failingCleanup, {
      repoDir: repo,
      good: base,
      bad: head,
      testCommand: TEST_COMMAND,
      boundary: boundaryOf(repo, base),
      onWarn: (detail) => warnings.push(detail),
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(' ')).toMatch(/bisect reset failed|checkout may be left/);
  });
});
