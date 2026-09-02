import { describe, expect, it } from 'vitest';
import {
  attributeByOverlap,
  failingTest,
  isReadableVitestReport,
  type MemberFootprint,
  memberOfCommit,
  memberRanges,
  offendersOf,
  parseBoundaryCommits,
  parseVitestJson,
} from '../index';

/**
 * Stage-1 attribution (#472 AC1) is pure: no git, no LLM, no I/O. These tests
 * pin the one property the whole eviction path depends on — attribution never
 * guesses. A test that could belong to two members is AMBIGUOUS (bisect
 * decides), never assigned to the first plausible one.
 */

const member = (
  issue: number,
  changedPaths: string[],
  focusedTests: string[] = []
): MemberFootprint => ({ issue, changedPaths, focusedTests });

describe('attributeByOverlap', () => {
  it('attributes a test its member ran focused', () => {
    const test = failingTest('packages/sched/src/__tests__/recovery.test.ts', 'evicts a member');
    const result = attributeByOverlap(
      [test],
      [
        member(201, ['packages/sched/src/recovery.ts'], [test.file]),
        member(202, ['packages/core/src/lint.ts']),
      ]
    );
    expect(result.attributed.get(201)).toEqual([test]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unattributed).toEqual([]);
    expect(offendersOf(result.attributed)).toEqual([201]);
  });

  it('attributes by an exact changed-path match', () => {
    const test = failingTest('src/__tests__/a.test.ts', 'a');
    const result = attributeByOverlap([test], [member(201, ['src/__tests__/a.test.ts'])]);
    expect(result.attributed.get(201)).toEqual([test]);
  });

  it('attributes by the directory a member changed', () => {
    // src/foo.ts changed → src/foo.test.ts is that member's surface.
    const test = failingTest('src/foo.test.ts', 'foo');
    const result = attributeByOverlap([test], [member(201, ['src/foo.ts'])]);
    expect(offendersOf(result.attributed)).toEqual([201]);
  });

  it('never lets a top-level change claim the whole repo', () => {
    // README.md's directory is '' — an empty prefix must not match everything.
    const test = failingTest('src/foo.test.ts', 'foo');
    const result = attributeByOverlap([test], [member(201, ['README.md'])]);
    expect(result.unattributed).toEqual([test]);
    expect(offendersOf(result.attributed)).toEqual([]);
  });

  it('reports several overlapping members as ambiguous, never a guess', () => {
    const test = failingTest('src/shared/util.test.ts', 'util');
    const result = attributeByOverlap(
      [test],
      [member(202, ['src/shared/util.ts']), member(201, ['src/shared/other.ts'])]
    );
    expect(result.attributed.size).toBe(0);
    expect(result.ambiguous).toEqual([{ test, candidates: [201, 202] }]);
  });

  it('lets a focused-test match break a tie against mere path overlap', () => {
    const test = failingTest('src/shared/util.test.ts', 'util');
    const result = attributeByOverlap(
      [test],
      [member(201, ['src/shared/other.ts']), member(202, ['src/shared/util.ts'], [test.file])]
    );
    expect(offendersOf(result.attributed)).toEqual([202]);
    expect(result.ambiguous).toEqual([]);
  });

  it('reports a test no member touched as unattributed', () => {
    const test = failingTest('packages/other/x.test.ts', 'x');
    const result = attributeByOverlap([test], [member(201, ['packages/sched/src/recovery.ts'])]);
    expect(result.unattributed).toEqual([test]);
  });

  it('normalizes path shapes before comparing', () => {
    const test = failingTest('./src/foo.test.ts', 'foo');
    const result = attributeByOverlap([test], [member(201, ['src/foo.ts'])]);
    expect(offendersOf(result.attributed)).toEqual([201]);
  });
});

describe('parseVitestJson', () => {
  const report = {
    testResults: [
      {
        name: 'src/__tests__/a.test.ts',
        assertionResults: [
          { status: 'passed', fullName: 'a > passes' },
          { status: 'failed', fullName: 'a > fails' },
        ],
      },
      {
        name: 'src/__tests__/b.test.ts',
        assertionResults: [{ status: 'failed', title: 'b fails' }],
      },
    ],
  };

  it('returns only the failing assertions, with file + name', () => {
    const failing = parseVitestJson(JSON.stringify(report));
    expect(failing.map((t) => t.id)).toEqual([
      'src/__tests__/a.test.ts::a > fails',
      'src/__tests__/b.test.ts::b fails',
    ]);
  });

  it('finds the report inside a runner banner', () => {
    const noisy = `RUN v4.0.9\n${JSON.stringify(report)}\nDuration 1.2s\n`;
    expect(parseVitestJson(noisy)).toHaveLength(2);
  });

  it('degrades to no failing tests rather than throwing', () => {
    expect(parseVitestJson(null)).toEqual([]);
    expect(parseVitestJson('not json at all')).toEqual([]);
    expect(parseVitestJson('{"testResults": "wrong shape"}')).toEqual([]);
    expect(parseVitestJson('{"testResults": [{"assertionResults": []}]}')).toEqual([]);
  });

  describe('isReadableVitestReport (#562)', () => {
    it('is true for a parseable report, whether or not it names any failures', () => {
      expect(isReadableVitestReport(JSON.stringify(report))).toBe(true);
      expect(isReadableVitestReport('{"testResults": []}')).toBe(true);
    });

    it('finds the report inside a runner banner, same as parseVitestJson', () => {
      const noisy = `RUN v4.0.9\n${JSON.stringify(report)}\nDuration 1.2s\n`;
      expect(isReadableVitestReport(noisy)).toBe(true);
    });

    it('is false for exactly the inputs parseVitestJson silently degrades on — the ambiguity #562 exists to remove', () => {
      expect(isReadableVitestReport(null)).toBe(false);
      expect(isReadableVitestReport('')).toBe(false);
      // A make-delegated wrapper's plain-text abort (the #562 bug): no JSON
      // document at all, not a report naming zero failures.
      expect(isReadableVitestReport("make: unrecognized option '--reporter=json'\n")).toBe(false);
      expect(isReadableVitestReport('{"testResults": "wrong shape"}')).toBe(false);
    });
  });
});

describe('parseBoundaryCommits', () => {
  const log = [
    'aaaaaaa1\tfeat(sched): first member change (#201)',
    'bbbbbbb2\tfix(sched): second member change (#202)',
    'ccccccc3\tchore: batch-level fixup with no trailer',
    'not-a-sha\tmalformed line',
    '',
  ].join('\n');

  it('maps commits to members through the (#N) subject trailer', () => {
    const commits = parseBoundaryCommits(log);
    expect(commits.map((c) => c.issue)).toEqual([201, 202, null]);
    expect(commits[0].sha).toBe('aaaaaaa1');
  });

  it('skips malformed lines and empty output', () => {
    expect(parseBoundaryCommits(log)).toHaveLength(3);
    expect(parseBoundaryCommits(null)).toEqual([]);
    expect(parseBoundaryCommits('')).toEqual([]);
  });

  it('does not read a (#N) reference from the middle of a subject', () => {
    const commits = parseBoundaryCommits('aaaaaaa1\trevert of (#201) work, unrelated');
    expect(commits[0].issue).toBeNull();
  });
});

describe('memberRanges and memberOfCommit', () => {
  const commits = parseBoundaryCommits(
    [
      'aaaaaaa1\tfeat: a1 (#201)',
      'bbbbbbb2\tfeat: b1 (#202)',
      'aaaaaaa3\tfeat: a2 (#201)',
      'ccccccc4\tchore: no trailer',
    ].join('\n')
  );

  it('groups every commit of a member, even when members interleave', () => {
    const ranges = memberRanges(commits);
    const a = ranges.find((r) => r.issue === 201);
    expect(a?.commits).toEqual(['aaaaaaa1', 'aaaaaaa3']);
    expect(a?.from).toBe('aaaaaaa1');
    expect(a?.to).toBe('aaaaaaa3');
    expect(ranges.find((r) => r.issue === 202)?.commits).toEqual(['bbbbbbb2']);
  });

  it('ignores commits with no member trailer', () => {
    expect(memberRanges(commits)).toHaveLength(2);
    expect(memberOfCommit(commits, 'ccccccc4')).toBeNull();
  });

  it('maps a commit to its member by full or abbreviated sha', () => {
    expect(memberOfCommit(commits, 'bbbbbbb2')).toBe(202);
    expect(memberOfCommit(commits, 'bbbbbbb')).toBe(202);
    expect(memberOfCommit(commits, 'deadbee')).toBeNull();
  });
});

describe('memberRanges ordering and ambiguous shas', () => {
  it('records each commit position so eviction can revert newest-first across members', () => {
    const interleaved = parseBoundaryCommits(
      [
        'aaaaaaa1\tfeat: a1 (#201)',
        'bbbbbbb2\tfeat: b1 (#202)',
        'aaaaaaa3\tfeat: a2 (#201)',
        'bbbbbbb4\tfeat: b2 (#202)',
      ].join('\n')
    );
    const ranges = memberRanges(interleaved);
    expect(ranges.find((r) => r.issue === 201)?.positions).toEqual([0, 2]);
    expect(ranges.find((r) => r.issue === 202)?.positions).toEqual([1, 3]);
  });

  it('refuses to name a member when an abbreviated sha matches two commits', () => {
    // Both boundary commits share the `abc1234` prefix — blaming either would
    // revert an innocent member's work.
    const colliding = parseBoundaryCommits(
      ['abc1234aaa\tfeat: a (#201)', 'abc1234bbb\tfeat: b (#202)'].join('\n')
    );
    expect(memberOfCommit(colliding, 'abc1234')).toBeNull();
    // ...but a prefix that resolves to exactly one commit still attributes.
    expect(memberOfCommit(colliding, 'abc1234aaa')).toBe(201);
  });

  it('matches shas case-insensitively', () => {
    const commits = parseBoundaryCommits('ABCDEF1234\tfeat: a (#201)');
    expect(memberOfCommit(commits, 'abcdef1234')).toBe(201);
  });
});
