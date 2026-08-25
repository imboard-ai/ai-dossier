import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  breakWorktreeAdminDir,
  commitAndPush,
  readPoolState,
  runPoolExpectingFailure as runPoolExpectingFailureIn,
  runPool as runPoolIn,
  writePoolConfig,
} from './helpers/cli';
import { createTempRepo, type TempRepo } from './helpers/setup';

/**
 * Partial-failure behaviour of `return` (#453).
 *
 * The bug these cover: a `return` that failed part-way used to destroy the
 * worktree and delete its pool entry, or leave the entry `assigned` with a
 * dirty directory while the caller reported success. The contract now is
 * transactional in outcome — `warm` and verified, or `broken` and non-zero.
 */
describe.sequential('pool return failure modes', () => {
  let repo: TempRepo;
  let poolDir: string;

  const runPool = (args: string) => runPoolIn(repo.root, args);
  const runPoolCombined = (args: string) => runPoolIn(repo.root, args, { combined: true });
  const runPoolExpectingFailure = (args: string) => runPoolExpectingFailureIn(repo.root, args);
  const state = () => readPoolState(poolDir);

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    writePoolConfig(repo.root, poolDir);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('leaves the entry broken (not assigned) when a dirty dir blocks the re-branch', () => {
    // A tracked file that main will move on top of.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'base\n');
    commitAndPush(repo.root, 'add shared.txt');

    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-dirty').trim();

    // Advance main, then leave a conflicting uncommitted edit in the worktree.
    // `git checkout -b <temp> origin/main` now refuses: local changes would be
    // overwritten. `git clean -fd` runs *after* the checkout, so it cannot save it.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'moved-on-main\n');
    commitAndPush(repo.root, 'move shared.txt on main');
    fs.writeFileSync(path.join(claimedPath, 'shared.txt'), 'local-uncommitted\n');

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    // AC1: the failing step is named.
    expect(output).toContain("return failed at step 'checkout-temp-branch'");

    const entry = state()?.worktrees[0];
    expect(state()?.worktrees).toHaveLength(1);
    // AC1: broken — neither of the two states a caller could mistake for a result.
    expect(entry?.status).toBe('broken');
    expect(entry?.status).not.toBe('assigned');
    expect(entry?.status).not.toBe('warm');
    expect(entry?.broken_step).toBe('checkout-temp-branch');
    expect(entry?.broken_reason).toBeTruthy();

    // The worktree is preserved for inspection, not destroyed.
    expect(fs.existsSync(claimedPath)).toBe(true);
  });

  it('leaves the entry broken when the git admin dir is missing', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-admin').trim();

    const adminDir = breakWorktreeAdminDir(claimedPath);
    expect(fs.existsSync(adminDir)).toBe(false);

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    expect(output).toContain('return failed at step');
    expect(output).toContain("marked 'broken'");

    const entry = state()?.worktrees[0];
    expect(entry?.status).toBe('broken');
    expect(entry?.broken_step).toBeTruthy();
    expect(fs.existsSync(claimedPath)).toBe(true);
  });

  it('marks the entry broken when the post-return self-check fails', () => {
    // The regression that survived the first cut of this suite: `commit-state`
    // renames the entry id, so a later `verify` failure was marking an id that
    // no longer existed — leaving the entry `warm` and claimable while the CLI
    // announced it as broken.
    //
    // Force it: a warm command that dirties a *tracked* file, run because the
    // lockfile moved on main.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'base\n');
    fs.writeFileSync(path.join(repo.root, 'package-lock.json'), '{"v":1}\n');
    commitAndPush(repo.root, 'add shared.txt and lockfile');
    writePoolConfig(repo.root, poolDir, {
      warm_commands: [['sh', '-c', 'echo dirtied > shared.txt']],
    });

    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-verify').trim();

    // Move the lockfile so the recycle re-runs the warm commands.
    fs.writeFileSync(path.join(repo.root, 'package-lock.json'), '{"v":2}\n');
    commitAndPush(repo.root, 'bump lockfile');

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    expect(output).toContain("return failed at step 'verify'");

    const entry = state()?.worktrees[0];
    expect(entry?.status).toBe('broken');
    expect(entry?.broken_step).toBe('verify');
    // And the CLI's claim about the pool matches the pool.
    expect(output).toContain("marked 'broken'");
  });

  it('names the step and modifies nothing when the path is not in the pool', () => {
    runPool('replenish --count 1');
    const before = JSON.stringify(state());

    const { code, output } = runPoolExpectingFailure(
      `return --path "${path.join(poolDir, 'not-a-pool-entry')}"`
    );

    expect(code).not.toBe(0);
    expect(output).toContain("return failed at step 'lookup'");
    expect(output).toContain('No pool entry was modified.');
    expect(JSON.stringify(state())).toBe(before);
  });

  it('records a pool-owned temp branch, never the branch that happens to be checked out', () => {
    // Recording the observed branch would make the ownership check that
    // protects developer worktrees (#438) tautological.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'base\n');
    commitAndPush(repo.root, 'add shared.txt');

    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-branch').trim();

    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'moved-on-main\n');
    commitAndPush(repo.root, 'move shared.txt on main');
    fs.writeFileSync(path.join(claimedPath, 'shared.txt'), 'local-uncommitted\n');
    runPoolExpectingFailure(`return --path "${claimedPath}"`);

    const entry = state()?.worktrees[0];
    expect(entry?.status).toBe('broken');
    expect(entry?.temp_branch).toMatch(/^pool\/spare-/);
    // The observed branch is kept, but only as a diagnostic.
    expect(entry?.broken_branch).toBe('bug/453-branch');
  });

  it('a broken entry is never handed out by a later claim', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-inert').trim();
    breakWorktreeAdminDir(claimedPath);
    runPoolExpectingFailure(`return --path "${claimedPath}"`);

    // Only warm entries are claimable, so the pool now reads as empty.
    const { code, output } = runPoolExpectingFailure('claim --issue 454 --branch bug/454-next');
    expect(code).not.toBe(0);
    expect(output).toContain('No warm worktrees available');
  });

  it('gc clears a broken entry immediately, without waiting for stale_after_hours', () => {
    // The CLI tells the operator to clear broken entries with gc; that has to
    // be true the moment the entry is marked, not 72h later.
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-gc').trim();
    breakWorktreeAdminDir(claimedPath);
    runPoolExpectingFailure(`return --path "${claimedPath}"`);
    expect(state()?.worktrees[0].status).toBe('broken');

    const plan = runPoolCombined('gc --dry-run');
    expect(plan).toContain('[broken]');
    expect(plan).not.toContain('Nothing to remove.');

    runPoolCombined('gc --yes');
    expect(state()?.worktrees).toHaveLength(0);
    expect(fs.existsSync(claimedPath)).toBe(false);
  });

  it('prints a self-check on success and really is warm, clean and on a temp branch', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-ok').trim();

    const output = runPoolCombined(`return --path "${claimedPath}"`);

    // AC2: the self-check is printed, not merely performed.
    expect(output).toContain('Self-check:');
    expect(output).toContain('directory clean: yes');
    expect(output).toMatch(/checked out: pool\/spare-/);

    const entry = state()?.worktrees[0];
    expect(entry?.status).toBe('warm');
    expect(entry?.assigned_to_issue).toBeNull();
    expect(entry?.broken_step).toBeUndefined();

    // And the claims the self-check made are independently true.
    const recycled = path.join(poolDir, entry?.path as string);
    expect(execSync('git status --porcelain', { cwd: recycled, encoding: 'utf-8' }).trim()).toBe(
      ''
    );
    expect(
      execSync('git rev-parse --abbrev-ref HEAD', { cwd: recycled, encoding: 'utf-8' }).trim()
    ).toBe(entry?.temp_branch);
  });

  it('return --json emits the machine-readable result', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-retjson').trim();

    const result = JSON.parse(runPool(`return --path "${claimedPath}" --json`));
    expect(result.verification.entry_status).toBe('warm');
    expect(result.verification.directory_clean).toBe(true);
    expect(result.verification.checked_out_branch).toBe(result.verification.expected_branch);
  });

  it('status --json exposes per-entry state so a caller can assert the return happened', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-json').trim();

    // AC3: assigned is visible before the return...
    const assigned = JSON.parse(runPool('status --json'));
    expect(assigned.worktrees).toHaveLength(1);
    expect(assigned.worktrees[0].status).toBe('assigned');
    expect(assigned.worktrees[0].assigned_to_issue).toBe(453);

    runPool(`return --path "${claimedPath}"`);

    // ...and warm after it, which is the assertion a ship tail needs.
    const after = JSON.parse(runPool('status --json'));
    expect(after.worktrees[0].status).toBe('warm');
    expect(after.warm).toBe(1);
    expect(after.assigned).toBe(0);
    expect(after.broken_entries).toBe(0);
  });

  it('status --json reports the failed step of a broken entry', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-brokenjson').trim();
    breakWorktreeAdminDir(claimedPath);
    runPoolExpectingFailure(`return --path "${claimedPath}"`);

    const s = JSON.parse(runPool('status --json'));
    expect(s.worktrees[0].status).toBe('broken');
    expect(s.worktrees[0].broken_step).toBeTruthy();
    expect(s.warm).toBe(0);
    expect(s.assigned).toBe(0);
    // Counted on its own, so a caller checking `warm`/`broken_entries` is never misled.
    expect(s.broken_entries).toBe(1);
    expect(s.other).toBe(0);
  });
});
