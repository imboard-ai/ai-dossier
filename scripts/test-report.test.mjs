import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  changedPaths,
  discoverTestWorkspaces,
  failLines,
  mergeRuns,
  recordsForRun,
  SCRIPTS_SUITE,
  suitesForChangedPaths,
  TAIL_CHARS,
  workspaceDependents,
} from './test-report.mjs';

const ROOT = '/repo';
const run = (over) => ({
  label: 'cli',
  dir: 'cli',
  exitCode: 0,
  report: null,
  tail: '',
  ...over,
});

describe('recordsForRun (#893)', () => {
  it('keeps only failed assertions, with repo-relative file names', () => {
    const records = recordsForRun(
      run({
        exitCode: 1,
        report: {
          testResults: [
            {
              name: '/repo/cli/src/a.test.ts',
              status: 'failed',
              assertionResults: [
                { status: 'passed', fullName: 'ok' },
                { status: 'failed', fullName: 'a > breaks', failureMessages: ['boom'] },
              ],
            },
            { name: '/repo/cli/src/b.test.ts', status: 'passed', assertionResults: [] },
          ],
        },
      }),
      ROOT
    );
    expect(records).toEqual([
      {
        name: 'cli/src/a.test.ts',
        status: 'failed',
        assertionResults: [
          { status: 'failed', fullName: 'a > breaks', title: '', failureMessages: ['boom'] },
        ],
      },
      { name: 'cli/src/b.test.ts', status: 'passed', assertionResults: [] },
    ]);
  });

  it('names a file that failed to run (no assertions) so it is attributable', () => {
    const [record] = recordsForRun(
      run({
        exitCode: 1,
        report: {
          testResults: [
            {
              name: '/repo/cli/src/c.test.ts',
              status: 'failed',
              message: 'Cannot find module ./gone',
              assertionResults: [],
            },
          ],
        },
      }),
      ROOT
    );
    expect(record.assertionResults[0].fullName).toBe(
      'cli/src/c.test.ts failed to run: Cannot find module ./gone'
    );
  });

  it('records a crash without a report on the workspace package.json, with the output tail', () => {
    const tail = `${'x'.repeat(TAIL_CHARS)}REAL CAUSE`;
    const [record] = recordsForRun(run({ exitCode: 2, tail }), ROOT);
    expect(record.name).toBe('cli/package.json');
    expect(record.assertionResults[0].fullName).toContain('exited 2 without a test report');
    expect(record.assertionResults[0].failureMessages[0].endsWith('REAL CAUSE')).toBe(true);
    expect(record.assertionResults[0].failureMessages[0]).toHaveLength(TAIL_CHARS);
  });

  it('a green run with no report contributes nothing', () => {
    expect(recordsForRun(run({ exitCode: 0 }), ROOT)).toEqual([]);
  });

  it('never reads a non-zero exit with an all-green report as green', () => {
    const records = recordsForRun(
      run({
        exitCode: 1,
        report: {
          testResults: [{ name: '/repo/cli/a.test.ts', status: 'passed', assertionResults: [] }],
        },
      }),
      ROOT
    );
    expect(records.some((r) => r.status === 'failed')).toBe(true);
  });
});

describe('mergeRuns (#893)', () => {
  it('is green only when every suite exited 0, and counts failed tests', () => {
    const green = run({ report: { testResults: [] } });
    const red = run({
      dir: 'packages/core',
      exitCode: 1,
      report: {
        testResults: [
          {
            name: '/repo/packages/core/a.test.ts',
            status: 'failed',
            assertionResults: [
              { status: 'failed', fullName: 'x' },
              { status: 'failed', fullName: 'y' },
            ],
          },
        ],
      },
    });
    expect(mergeRuns([green], ROOT)).toMatchObject({ success: true, numFailedTests: 0 });
    expect(mergeRuns([green, red], ROOT)).toMatchObject({ success: false, numFailedTests: 2 });
  });
});

describe('discoverTestWorkspaces (#893)', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-report-ws-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('expands globs and keeps only workspaces with a test script', () => {
    const write = (dir, pkg) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
    };
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', 'cli'] })
    );
    write('packages/a', { scripts: { test: 'vitest run' } });
    write('packages/b', { scripts: { build: 'tsc' } });
    write('cli', { scripts: { test: 'vitest run' } });
    expect(discoverTestWorkspaces(root)).toEqual(['cli', 'packages/a']);
  });
});

describe('test-report.mjs entrypoint (#893)', () => {
  it('starts, runs zero suites for an unmatched --only, and prints a readable green report', () => {
    const script = fileURLToPath(new URL('./test-report.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, '--only=__none__'], { encoding: 'utf-8' });
    expect(JSON.parse(out)).toEqual({ success: true, numFailedTests: 0, testResults: [] });
  });
});

describe('--changed suite mapping (#919)', () => {
  const workspaces = ['cli', 'mcp-server', 'packages/core', 'packages/sched', 'registry'];
  const dependents = new Map([
    ['packages/core', new Set(['cli', 'packages/sched', 'registry', 'mcp-server'])],
    ['packages/sched', new Set(['cli'])],
    ['cli', new Set()],
    ['mcp-server', new Set()],
    ['registry', new Set()],
  ]);
  const plan = (paths) => suitesForChangedPaths(paths, { workspaces, dependents });

  it('a single-workspace change runs that workspace plus the scripts suite', () => {
    expect(plan(['registry/tests/auth.test.ts'])).toEqual({
      only: [SCRIPTS_SUITE, 'registry'].sort(),
      reason: 'mapped',
    });
  });

  it('a library change also runs its dependents', () => {
    expect(plan(['packages/sched/src/x.ts']).only).toEqual(['cli', 'packages/sched', 'scripts']);
    expect(plan(['packages/core/src/x.ts']).only).toEqual([
      'cli',
      'mcp-server',
      'packages/core',
      'packages/sched',
      'registry',
      'scripts',
    ]);
  });

  it('script, docs and root markdown changes run only the scripts suite', () => {
    expect(plan(['scripts/a.mjs', 'docs/agent-traps.md', 'README.md']).only).toEqual(['scripts']);
  });

  it('an empty diff runs only the scripts suite', () => {
    expect(plan([]).only).toEqual(['scripts']);
  });

  it('any unmappable path falls back to the full run', () => {
    for (const p of [
      'package-lock.json',
      'test-support/isolated-home.mjs',
      '.dossier/x.yaml',
      'Makefile',
    ]) {
      const r = plan(['registry/a.ts', p]);
      expect(r.only).toBeNull();
      expect(r.reason).toContain(p);
    }
  });

  it('does not treat a sibling dir sharing a prefix as the workspace', () => {
    expect(plan(['cli-extras/a.ts']).only).toBeNull();
  });
});

describe('workspaceDependents + changedPaths (#919)', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-report-dep-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const write = (rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it('computes the transitive dependents of each workspace', () => {
    write('a/package.json', JSON.stringify({ name: '@x/a' }));
    write('b/package.json', JSON.stringify({ name: '@x/b', dependencies: { '@x/a': '*' } }));
    write('c/package.json', JSON.stringify({ name: '@x/c', devDependencies: { '@x/b': '*' } }));
    const deps = workspaceDependents(root, ['a', 'b', 'c']);
    expect([...deps.get('a')].sort()).toEqual(['b', 'c']);
    expect([...deps.get('b')]).toEqual(['c']);
    expect([...deps.get('c')]).toEqual([]);
  });

  it('lists committed, uncommitted and untracked paths since the base; null without git', () => {
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    sh('add', '-A');
    sh('commit', '-qm', 'base');
    sh('checkout', '-qb', 'member');
    write('a/src.ts', '1');
    sh('add', '-A');
    sh('commit', '-qm', 'member');
    write('b/package.json', JSON.stringify({ name: '@x/b', dependencies: { '@x/a': '1' } }));
    write('c/new.ts', '2');
    expect(changedPaths(root, { TEST_REPORT_BASE: 'main' }).sort()).toEqual([
      'a/src.ts',
      'b/package.json',
      'c/new.ts',
    ]);
    expect(changedPaths(mkdtempSync(join(tmpdir(), 'test-report-nogit-')), {})).toBeNull();
  });

  it('reports both sides of a rename so the source workspace is not skipped', () => {
    sh('add', '-A');
    sh('commit', '-qm', 'wip');
    sh('mv', 'a/package.json', 'c/moved.json');
    sh('commit', '-qm', 'move');
    expect(changedPaths(root, { TEST_REPORT_BASE: 'main' })).toEqual(
      expect.arrayContaining(['a/package.json', 'c/moved.json'])
    );
  });
});

describe('failLines (#919)', () => {
  it('emits one FAIL line per failed assertion and none for passing suites', () => {
    const merged = mergeRuns(
      [
        run({
          exitCode: 1,
          report: {
            testResults: [
              {
                name: '/repo/cli/a.test.ts',
                status: 'failed',
                assertionResults: [
                  { status: 'failed', fullName: 'a > x', title: 'x', failureMessages: ['boom'] },
                  { status: 'passed', fullName: 'a > y', title: 'y' },
                ],
              },
              { name: '/repo/cli/b.test.ts', status: 'passed', assertionResults: [] },
            ],
          },
        }),
      ],
      ROOT
    );
    expect(failLines(merged)).toEqual(['FAIL cli/a.test.ts > a > x']);
  });
});
