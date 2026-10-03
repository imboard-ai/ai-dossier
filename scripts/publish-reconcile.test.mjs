import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { findPending, inflightRuns, packageDirs, reconcile } from './publish-reconcile.mjs';

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');
const PUBLISH = read('publish-packages.yml');

/** Fake guard: `decisions` maps dir -> 'publish' | 'skip' | 'none' (no output). */
const fakeGuard = (decisions, reportExit = 0) =>
  vi.fn(async (argv, { outputFile }) => {
    if (argv[0] === '--report-collisions') return reportExit;
    const d = decisions[argv[1]];
    if (d === 'publish') appendFileSync(outputFile, 'skip=false\ncollision=false\n');
    if (d === 'skip') appendFileSync(outputFile, 'skip=true\ncollision=false\n');
    return 0;
  });

describe('packageDirs', () => {
  it('reads every guarded package from the real publish workflow', () => {
    expect(packageDirs(PUBLISH)).toEqual([
      'packages/core',
      'packages/worktree-pool',
      'packages/sched',
      'cli',
      'mcp-server',
    ]);
  });
});

describe('reconcile', () => {
  const opts = (decisions, extra = {}) => ({
    workflowText: PUBLISH,
    guard: fakeGuard(decisions),
    log: () => {},
    ...extra,
  });

  it('is a no-op when everything is published', async () => {
    const dispatch = vi.fn();
    const r = await reconcile(opts({ cli: 'skip' }, { dispatch, inflight: () => 0 }));
    expect(r).toEqual({ pending: [], exitCode: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches when a package is on main but not on npm', async () => {
    const dispatch = vi.fn();
    const r = await reconcile(opts({ cli: 'publish' }, { dispatch, inflight: () => 0 }));
    expect(r.pending).toEqual(['cli']);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('does not dispatch while a publish run is queued or running', async () => {
    const dispatch = vi.fn();
    await reconcile(opts({ cli: 'publish' }, { dispatch, inflight: () => 1 }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch in dry-run', async () => {
    const dispatch = vi.fn();
    await reconcile(opts({ cli: 'publish' }, { dispatch, inflight: () => 0, dryRun: true }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never treats a guard that wrote no output as "publish"', async () => {
    const dispatch = vi.fn();
    const r = await reconcile(opts({ cli: 'none' }, { dispatch, inflight: () => 0 }));
    expect(r.pending).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('surfaces guard collisions/unavailable as a failing exit code without dispatching', async () => {
    const dispatch = vi.fn();
    const r = await reconcile({
      workflowText: PUBLISH,
      guard: fakeGuard({ cli: 'skip' }, 1),
      log: () => {},
      dispatch,
      inflight: () => 0,
    });
    expect(r.exitCode).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses to run against a workflow with no guarded packages', async () => {
    await expect(reconcile({ workflowText: 'jobs: {}', log: () => {} })).rejects.toThrow(
      /no publish-guard/
    );
  });
});

describe('findPending', () => {
  it('passes the shared ledger to every check', async () => {
    const guard = fakeGuard({});
    await findPending(['a', 'b'], { guard, log: () => {} });
    const ledgers = guard.mock.calls.map((c) => c[0][3] ?? c[0][1]);
    expect(new Set(ledgers).size).toBe(1);
  });
});

describe('inflightRuns', () => {
  it('sums queued and in_progress runs', () => {
    const exec = vi.fn().mockReturnValueOnce('1\n').mockReturnValueOnce('2\n');
    expect(inflightRuns(exec)).toBe(3);
  });
});

describe('publish-reconcile.yml', () => {
  const wf = parse(read('publish-reconcile.yml'));
  it('runs on a schedule and can be dispatched by hand', () => {
    expect(wf.on.schedule[0].cron).toBeTruthy();
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });
  it('has only the permissions it needs (dispatch, no publish credentials)', () => {
    expect(wf.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(JSON.stringify(wf)).not.toMatch(/npm publish|id-token/);
  });
  it('checks out main with full history and runs the reconcile script', () => {
    const steps = wf.jobs.reconcile.steps;
    expect(steps[0].with).toMatchObject({ ref: 'main', 'fetch-depth': 0 });
    expect(steps.some((s) => /node scripts\/publish-reconcile\.mjs/.test(s.run ?? ''))).toBe(true);
  });
});
