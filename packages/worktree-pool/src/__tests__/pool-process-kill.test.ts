import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWorktreeKillRootSafe,
  findWorktreeProcesses,
  UnsafeKillRootError,
} from '../process-scan';
import {
  readPoolState,
  runPoolExpectingFailure as runPoolExpectingFailureIn,
  runPool as runPoolIn,
  writePoolConfig,
} from './helpers/cli';
import { createTempRepo, type TempRepo } from './helpers/setup';

/**
 * Process cleanup on `return`/`gc`, and the `reap` sweep for what escapes
 * them (imboard-ai/ai-dossier#760).
 *
 * The bug: a dev server, jest run, or vite server started inside a worktree
 * by a verification step outlived the worktree, the branch, and the issue —
 * `return`/`gc` recycled or removed the checkout without looking at what was
 * still running out of it. 13 such processes were found across four merged
 * worktrees on hcc, one holding Atlas test-cluster connections for 10 days.
 */
describe.sequential('worktree-pool process cleanup (#760)', () => {
  let repo: TempRepo;
  let poolDir: string;
  const spawnedPids: number[] = [];

  const runPool = (args: string) => runPoolIn(repo.root, args);
  const runPoolCombined = (args: string) => runPoolIn(repo.root, args, { combined: true });
  const runPoolExpectingFailure = (args: string) => runPoolExpectingFailureIn(repo.root, args);

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** A long-lived, easily killable child rooted at `cwd`. Tracked for teardown. */
  function spawnSleeper(cwd: string): number {
    const child = spawn('sleep', ['300'], { cwd, detached: true, stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('failed to spawn test sleeper process');
    spawnedPids.push(child.pid);
    child.unref();
    return child.pid;
  }

  async function waitUntil(pred: () => boolean, timeoutMs = 8000, stepMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return pred();
  }

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    writePoolConfig(repo.root, poolDir);
  });

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone — fine
      }
    }
    repo.cleanup();
  });

  it('return kills a process still running from inside the worktree, and reports the pid', async () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 760 --branch bug/760-kill').trim();

    const pid = spawnSleeper(claimedPath);
    expect(isAlive(pid)).toBe(true);

    const output = runPoolCombined(`return --path "${claimedPath}"`);

    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(output).toContain(`pid ${pid}`);
    expect(output).toMatch(/Killed \d+ process/);
  });

  it('leaves a sibling process outside the target worktree untouched', async () => {
    runPool('replenish --count 2');
    const claimedPath = runPool('claim --issue 761 --branch bug/761-sibling').trim();

    // The second warm spare from the pool — a legitimate sibling worktree
    // sharing the same pool directory. `return` must never look past the
    // exact path it was given.
    const siblingPath = fs
      .readdirSync(poolDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(poolDir, e.name))
      .find((p) => path.resolve(p) !== path.resolve(claimedPath));
    expect(siblingPath).toBeTruthy();

    const targetPid = spawnSleeper(claimedPath);
    const siblingPid = spawnSleeper(siblingPath as string);

    runPoolCombined(`return --path "${claimedPath}"`);

    expect(await waitUntil(() => !isAlive(targetPid))).toBe(true);
    // Give the sibling the same grace window `return`'s kill step allows
    // before asserting it was never even targeted.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(siblingPid)).toBe(true);
  });

  it('never kills an ancestor of the invoking process, even one whose own cwd is inside the worktree', async () => {
    // Orchestrator addendum on #760's review (#763): `return --path <wt>` is
    // frequently invoked from a shell whose own cwd is `<wt>` — this spawns
    // a real ANCESTOR of the CLI process performing the kill (a shell whose
    // cwd is the worktree being recycled, which `sh` then execs the CLI as
    // a child of, then execs into a long-lived process itself so it survives
    // past the CLI's exit for the assertion below).
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 768 --branch bug/768-ancestor').trim();
    const fixturePid = spawnSleeper(claimedPath);

    const TSX = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
    const CLI = path.resolve(__dirname, '../cli.ts');
    // The CLI invocation runs in a SUBSHELL cd'd to `repo.root` — required
    // for `worktree-pool` to resolve the right `.worktree-pool.json` (it
    // discovers the pool config from its OWN process cwd's git toplevel,
    // which for a linked worktree is the worktree itself, not the main
    // repo). The subshell does not change the outer wrapper's own cwd, so
    // the wrapper — the actual ancestor under test — keeps `claimedPath` as
    // its cwd for the whole test, exactly like a real invoking shell would.
    const wrapperScript = `(cd "${repo.root}" && "${TSX}" "${CLI}" return --path "${claimedPath}"); exec sleep 300`;
    const wrapper = spawn('sh', ['-c', wrapperScript], {
      cwd: claimedPath,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (wrapper.pid === undefined) throw new Error('failed to spawn wrapper process');
    spawnedPids.push(wrapper.pid);
    wrapper.unref();

    // The fixture (a genuine orphan, unrelated to the wrapper) must still be
    // killed — this is not a case where the guard should refuse anything.
    expect(await waitUntil(() => !isAlive(fixturePid), 10000)).toBe(true);
    // The wrapper — alive throughout via `exec`, so its pid never changes —
    // must never be a kill target despite its cwd matching the recycle root
    // exactly.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(wrapper.pid)).toBe(true);
  });

  it('gc kills a process still running from a stale worktree before removing it', async () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 762 --branch bug/762-gc').trim();
    // Return it to the pool (idle, warm) — then age it past staleness so
    // `gc` removes it, mirroring pool-cli.test.ts's 'gc removes stale entries'.
    runPool(`return --path "${claimedPath}"`);

    const state = readPoolState(poolDir) as NonNullable<ReturnType<typeof readPoolState>>;
    const old = new Date();
    old.setDate(old.getDate() - 10);
    state.worktrees[0].warmed_at = old.toISOString();
    state.config.stale_after_hours = 24;
    fs.writeFileSync(path.join(poolDir, '.pool-state.json'), JSON.stringify(state, null, 2));

    const warmPath = path.join(poolDir, state.worktrees[0].path);
    const pid = spawnSleeper(warmPath);
    expect(isAlive(pid)).toBe(true);

    const output = runPoolCombined('gc --yes');

    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(output).toContain(`pid ${pid}`);
    expect(fs.existsSync(warmPath)).toBe(false);
  });

  it('reap --dry-run lists an orphaned process from a removed worktree without killing it', async () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 763 --branch bug/763-removed').trim();

    const pid = spawnSleeper(claimedPath);

    // Simulate a worktree removed out from under a still-running process —
    // bypass our own tool (which now kills first) so the orphan is genuine,
    // matching a directory removed by something other than this package.
    execSync(`git worktree remove --force "${claimedPath}"`, { cwd: repo.root, stdio: 'pipe' });
    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(isAlive(pid)).toBe(true);

    // `--older-than 0` so a moments-old orphan still counts as a candidate —
    // the age filter itself is covered by the dedicated test below.
    const plan = runPoolCombined('reap --older-than 0 --dry-run');

    expect(plan).toContain(`pid ${pid}`);
    expect(plan).not.toMatch(/Killed \d+\/\d+/);
    expect(isAlive(pid)).toBe(true);
  });

  it('reap --yes kills the orphaned process', async () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 764 --branch bug/764-reap').trim();

    const pid = spawnSleeper(claimedPath);
    execSync(`git worktree remove --force "${claimedPath}"`, { cwd: repo.root, stdio: 'pipe' });

    const output = runPoolCombined('reap --older-than 0 --yes');

    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(output).toContain(`pid ${pid}`);
    expect(output).toMatch(/Killed 1\/1 process/);
  });

  it('leaves a process younger than --older-than alone', async () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 765 --branch bug/765-fresh').trim();

    const pid = spawnSleeper(claimedPath);
    execSync(`git worktree remove --force "${claimedPath}"`, { cwd: repo.root, stdio: 'pipe' });

    // Default --older-than is 24h; a process spawned moments ago is not old
    // enough to reap even though it is a genuine orphan.
    const plan = runPoolCombined('reap --dry-run');

    expect(plan).not.toContain(`pid ${pid}`);
    expect(plan).toContain('Nothing to reap.');
    expect(isAlive(pid)).toBe(true);
  });

  it('reap never touches a foreign worktree sharing the pool directory', async () => {
    // A developer's own worktree, not created by the pool (imboard-ai/ai-dossier#438).
    const foreignPath = path.join(poolDir, 'developer-own-branch');
    execSync(`git worktree add "${foreignPath}" -b developer-own-branch`, {
      cwd: repo.root,
      stdio: 'pipe',
    });

    const pid = spawnSleeper(foreignPath);

    const plan = runPoolCombined('reap --older-than 0 --dry-run');

    expect(plan).not.toContain(`pid ${pid}`);
    expect(isAlive(pid)).toBe(true);
  });

  it('return still reports a failed step when the recycle fails, after killing what was running', async () => {
    // A dirty tracked file blocks the re-branch (mirrors pool-return.test.ts),
    // proving the kill step runs even on a `return` that ultimately fails.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'base\n');
    execSync('git add -A', { cwd: repo.root, stdio: 'pipe' });
    execSync('git commit -m "add shared.txt"', { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: repo.root, stdio: 'pipe' });

    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 766 --branch bug/766-fail').trim();

    const pid = spawnSleeper(claimedPath);

    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'moved-on-main\n');
    execSync('git add -A', { cwd: repo.root, stdio: 'pipe' });
    execSync('git commit -m "move shared.txt on main"', { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: repo.root, stdio: 'pipe' });
    fs.writeFileSync(path.join(claimedPath, 'shared.txt'), 'local-uncommitted\n');

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    expect(output).toContain("return failed at step 'checkout-temp-branch'");
    // The kill ran before the failing step, and is reported anyway.
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    expect(output).toContain(`pid ${pid}`);
  });

  it('reap does not touch a worktree mid-recycle (status recycling, not yet assigned=null)', async () => {
    // Regression for a review finding on #760: reap only excluded status
    // 'assigned', so a `return` that had already flipped its entry to
    // 'recycling' (its very first write, before its own kill step even
    // runs) looked like an orphan to a concurrently-running `reap`.
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 767 --branch bug/767-recycling').trim();

    const pid = spawnSleeper(claimedPath);

    const st = readPoolState(poolDir) as NonNullable<ReturnType<typeof readPoolState>>;
    st.worktrees[0].status = 'recycling';
    fs.writeFileSync(path.join(poolDir, '.pool-state.json'), JSON.stringify(st, null, 2));

    const plan = runPoolCombined('reap --older-than 0 --dry-run');

    expect(plan).not.toContain(`pid ${pid}`);
    expect(isAlive(pid)).toBe(true);
  });
});

describe('findWorktreeProcesses path-boundary matching (#760)', () => {
  const spawnedPids: number[] = [];

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone — fine
      }
    }
  });

  it('does not match a sibling process whose path is a numeric-prefix collision, only in the command-line fallback', async () => {
    // Regression for a review finding on #760: pool worktree names are
    // `pool-<timestamp>-<pid>`, so a same-batch replenish routinely produces
    // one name that is a literal string-prefix of another
    // (`pool-1700000000-1234` vs `pool-1700000000-12345`). The cwd match was
    // always boundary-safe (`path.relative`); the command-line fallback used
    // to be a bare `String.includes`, which would treat the short root as a
    // substring of the sibling's argv and report it as rooted there too.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-boundary-'));
    const shortRoot = path.join(tmp, 'pool-1700000000-1234');
    const longSibling = path.join(tmp, 'pool-1700000000-12345');
    fs.mkdirSync(shortRoot);
    fs.mkdirSync(longSibling);

    // cwd is neither root (forces the command-line fallback path); the
    // sibling's own path is passed as an argv (a long-lived `node` process
    // ignores extra positional args, unlike `sleep`, which would error on a
    // non-numeric one), which contains `shortRoot` as a literal
    // character-prefix.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', longSibling], {
      cwd: tmp,
      detached: true,
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('failed to spawn test process');
    spawnedPids.push(child.pid);
    child.unref();

    const matches = findWorktreeProcesses(shortRoot);
    expect(matches.find((m) => m.pid === child.pid)).toBeUndefined();

    // Sanity: the real target (longSibling) does match, proving the process
    // and the fallback path are both live for this test.
    const realMatches = findWorktreeProcesses(longSibling);
    expect(realMatches.find((m) => m.pid === child.pid)).toBeDefined();

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('assertWorktreeKillRootSafe (#763)', () => {
  let tmp: string;
  let gitRoot: string;
  let poolDir: string;
  let worktreePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-guard-'));
    gitRoot = path.join(tmp, 'main');
    poolDir = path.join(tmp, 'worktrees');
    worktreePath = path.join(poolDir, 'pool-1700000000-1');
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts a path strictly inside the pool directory', () => {
    expect(assertWorktreeKillRootSafe(worktreePath, gitRoot, poolDir)).toBe(
      path.resolve(worktreePath)
    );
  });

  it('refuses an empty path', () => {
    expect(() => assertWorktreeKillRootSafe('', gitRoot, poolDir)).toThrow(UnsafeKillRootError);
    expect(() => assertWorktreeKillRootSafe('   ', gitRoot, poolDir)).toThrow(UnsafeKillRootError);
  });

  it('refuses the filesystem root', () => {
    expect(() => assertWorktreeKillRootSafe('/', gitRoot, poolDir)).toThrow(UnsafeKillRootError);
  });

  it('refuses the git root itself', () => {
    expect(() => assertWorktreeKillRootSafe(gitRoot, gitRoot, poolDir)).toThrow(
      UnsafeKillRootError
    );
  });

  it('refuses the pool directory itself (must be strictly inside it, not equal to it)', () => {
    expect(() => assertWorktreeKillRootSafe(poolDir, gitRoot, poolDir)).toThrow(
      UnsafeKillRootError
    );
  });

  it('refuses a path outside the pool directory entirely', () => {
    const outside = path.join(tmp, 'somewhere-else');
    fs.mkdirSync(outside);
    expect(() => assertWorktreeKillRootSafe(outside, gitRoot, poolDir)).toThrow(
      UnsafeKillRootError
    );
  });

  it('refuses a sibling directory whose name is merely a numeric-prefix collision with the pool dir', () => {
    // Guards against the same `String.includes` boundary bug findWorktreeProcesses's
    // command-line fallback had (#760): `${poolDir}extra` is NOT inside `poolDir`.
    const collision = `${poolDir}-extra-suffix`;
    fs.mkdirSync(collision, { recursive: true });
    expect(() => assertWorktreeKillRootSafe(collision, gitRoot, poolDir)).toThrow(
      UnsafeKillRootError
    );
  });
});
