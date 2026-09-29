import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { discoverTestWorkspaces, mergeRuns, recordsForRun, TAIL_CHARS } from './test-report.mjs';

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
