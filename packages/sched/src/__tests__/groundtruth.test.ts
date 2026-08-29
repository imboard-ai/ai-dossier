import { describe, expect, it } from 'vitest';
import {
  createExecGroundTruth,
  type ExecFn,
  type GroundTruthMilestone,
  groundTruthExec,
  isVerifiedComplete,
  parseMilestoneJson,
} from '../index';

describe('parseMilestoneJson', () => {
  it('parses the runstate last --json shape', () => {
    const stdout = JSON.stringify({
      phase: 'implement',
      status: 'done',
      run: 'r-464-abcd',
      at: '2026-08-29T12:00:00Z',
      head: 'abc1234',
      branch: 'feature/464-x',
    });
    expect(parseMilestoneJson(stdout)).toEqual({
      phase: 'implement',
      status: 'done',
      run: 'r-464-abcd',
      at: '2026-08-29T12:00:00Z',
      keys: {
        phase: 'implement',
        status: 'done',
        run: 'r-464-abcd',
        at: '2026-08-29T12:00:00Z',
        head: 'abc1234',
        branch: 'feature/464-x',
      },
    } satisfies GroundTruthMilestone);
  });

  it('treats "null" (no milestones), empty, and garbage as null', () => {
    expect(parseMilestoneJson('null')).toBeNull();
    expect(parseMilestoneJson('')).toBeNull();
    expect(parseMilestoneJson(null)).toBeNull();
    expect(parseMilestoneJson('not json')).toBeNull();
    expect(parseMilestoneJson('[1,2]')).toBeNull();
    // shape without the required typed fields is not a milestone
    expect(parseMilestoneJson('{"phase":"gate"}')).toBeNull();
  });
});

describe('isVerifiedComplete (AC2 completion rule)', () => {
  const done = (phase: string, status: string): GroundTruthMilestone => ({
    phase,
    status,
    run: 'r',
    at: '2026-08-29T12:00:00Z',
    keys: {},
  });

  it('only the final report-done milestone verifies completion', () => {
    expect(isVerifiedComplete(done('report', 'done'), false)).toBe(true);
    expect(isVerifiedComplete(done('report', 'blocked'), false)).toBe(false);
    expect(isVerifiedComplete(done('ship', 'done'), false)).toBe(false);
    expect(isVerifiedComplete(done('implement', 'done'), false)).toBe(false);
    expect(isVerifiedComplete(null, false)).toBe(false);
  });

  it('a closed issue is ground truth regardless of the milestone', () => {
    expect(isVerifiedComplete(null, true)).toBe(true);
    expect(isVerifiedComplete(done('gate', 'done'), true)).toBe(true);
  });
});

describe('createExecGroundTruth', () => {
  it('reads milestones, issue state, and branch heads through the exec fn', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      if (file === 'ai-dossier' && args.includes('464')) {
        return JSON.stringify({
          phase: 'report',
          status: 'done',
          run: 'r-464-x',
          at: '2026-08-29T12:00:00Z',
        });
      }
      if (file === 'ai-dossier') return 'null';
      if (file === 'gh') return 'CLOSED';
      if (file === 'git')
        return '9a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b\trefs/heads/feature/464-x';
      return null;
    };
    const gt = createExecGroundTruth(exec, { repoDir: '/repo' });

    expect(gt.latestMilestone(464)?.phase).toBe('report');
    expect(gt.latestMilestone(465)).toBeNull();
    expect(gt.issueClosed(464)).toBe(true);
    expect(gt.branchHead('feature/464-x')).toBe('9a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b');

    // The runstate call asks for JSON; git runs in the repo dir.
    expect(calls.some(([f, a]) => f === 'ai-dossier' && a.includes('--json'))).toBe(true);
    expect(calls.some(([f]) => f === 'git')).toBe(true);
  });

  it('degrades to null/false when the subprocess fails — never crashes the tick', () => {
    const failing: ExecFn = () => null;
    const gt = createExecGroundTruth(failing);
    expect(gt.latestMilestone(1)).toBeNull();
    expect(gt.issueClosed(1)).toBe(false);
    expect(gt.branchHead('x')).toBeNull();
  });

  it('a non-40-hex ls-remote line is not a head sha', () => {
    const exec: ExecFn = (_file, args) =>
      args[0] === 'ls-remote' ? 'short-ref\trefs/heads/x' : null;
    expect(createExecGroundTruth(exec).branchHead('x')).toBeNull();
  });

  it('rejects crafted branch names that could become git options (CWE-88)', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      return null;
    };
    const gt = createExecGroundTruth(exec);
    expect(gt.branchHead('--upload-pack=evil')).toBeNull();
    expect(gt.branchHead('-oProxyCommand=evil')).toBeNull();
    expect(gt.branchHead('ok-branch')).toBeNull(); // exec returns null → null head
    // No git call may have been made for the rejected refs…
    expect(calls.filter(([f]) => f === 'git')).toHaveLength(1);
    // …and the legit ref is queried after the `--` end-of-options separator.
    expect(calls.find(([f]) => f === 'git')?.[1]).toEqual([
      'ls-remote',
      'origin',
      '--',
      'ok-branch',
    ]);
  });

  it('groundTruthExec is the default exec (injectable boundary exists)', () => {
    expect(typeof groundTruthExec).toBe('function');
  });
});
