import { describe, expect, it } from 'vitest';
import {
  attributeByOverlap,
  commitsOfMember,
  type FailingTest,
  type MemberFootprint,
  parseBoundaryCommits,
  parseVitestJson,
} from '../index';

const footprint = (issue: number, changed: string[], focused: string[] = []): MemberFootprint => ({
  issue,
  changed_paths: changed,
  focused_tests: focused,
});

const failing = (id: string, file: string | null = null): FailingTest => ({ id, file });

describe('attributeByOverlap (RFC-0001 §F.2 stage 1)', () => {
  it('attributes by exact focused-test match when unique', () => {
    const footprints = [
      footprint(201, ['src/a.ts'], ['src/a.test.ts > suite > works']),
      footprint(202, ['src/b.ts'], ['src/b.test.ts > suite > works']),
    ];
    const result = attributeByOverlap(
      [failing('src/a.test.ts > suite > works', 'src/a.test.ts')],
      footprints
    );
    expect(result).toEqual([
      { test: 'src/a.test.ts > suite > works', members: [201], method: 'focused-test' },
    ]);
  });

  it('focused-test matching is containment-tolerant (reporter prefix variance)', () => {
    const footprints = [footprint(201, [], ['maps tests to members'])];
    const result = attributeByOverlap(
      [failing('attribution.test.ts > maps tests to members')],
      footprints
    );
    expect(result[0]?.members).toEqual([201]);
    expect(result[0]?.method).toBe('focused-test');
  });

  it('attributes by changed-path overlap: the member changed the failing test file', () => {
    const footprints = [
      footprint(201, ['src/a.ts', 'src/a.test.ts']),
      footprint(202, ['src/b.ts']),
    ];
    const result = attributeByOverlap([failing('case x', 'src/a.test.ts')], footprints);
    expect(result[0]?.members).toEqual([201]);
    expect(result[0]?.method).toBe('changed-path');
  });

  it('attributes by changed-path overlap: the member changed the source the test exercises (stem match)', () => {
    const footprints = [footprint(201, ['src/attribution.ts']), footprint(202, ['src/bisect.ts'])];
    const result = attributeByOverlap([failing('case y', 'src/attribution.test.ts')], footprints);
    expect(result[0]?.members).toEqual([201]);
    expect(result[0]?.method).toBe('changed-path');
  });

  it('attributes by changed-path overlap: the member changed a directory containing the test', () => {
    const footprints = [footprint(201, ['src/module'])];
    const result = attributeByOverlap(
      [failing('case z', 'src/module/deep/thing.test.ts')],
      footprints
    );
    expect(result[0]?.members).toEqual([201]);
  });

  it('multiple matching members stay ambiguous — bisect resolves them, never the heuristic', () => {
    const footprints = [
      footprint(201, ['src/shared.ts']),
      footprint(202, ['src/shared.ts', 'src/shared.test.ts']),
    ];
    const result = attributeByOverlap([failing('case w', 'src/shared.test.ts')], footprints);
    expect(result[0]?.members).toEqual([201, 202]);
    expect(result[0]?.method).toBe('ambiguous');
  });

  it('no overlap at all is unattributed', () => {
    const footprints = [footprint(201, ['src/a.ts'])];
    const result = attributeByOverlap([failing('case v', 'src/other.test.ts')], footprints);
    expect(result[0]?.members).toEqual([]);
    expect(result[0]?.method).toBe('unattributed');
  });

  it('a test without a file attribute that matches nothing is unattributed', () => {
    const footprints = [footprint(201, ['src/a.ts'], ['known test'])];
    const result = attributeByOverlap([failing('unknown test', null)], footprints);
    expect(result[0]?.method).toBe('unattributed');
  });

  it('treats absolute and relative path spellings as the same file', () => {
    const footprints = [footprint(201, ['packages/sched/src/a.test.ts'])];
    const result = attributeByOverlap(
      [failing('case u', '/repo/packages/sched/src/a.test.ts')],
      footprints
    );
    expect(result[0]?.members).toEqual([201]);
  });

  it('empty failing list yields an empty verdict', () => {
    expect(attributeByOverlap([], [footprint(201, ['src/a.ts'])])).toEqual([]);
  });
});

describe('parseVitestJson', () => {
  const vitestJson = JSON.stringify({
    numFailedTests: 2,
    testResults: [
      {
        name: '/repo/src/attribution.test.ts',
        status: 'failed',
        assertionResults: [
          { fullName: 'attribution maps a test', status: 'failed', title: 'maps a test' },
          { fullName: 'attribution passes', status: 'passed', title: 'passes' },
        ],
      },
      {
        name: '/repo/src/other.test.ts',
        status: 'passed',
        assertionResults: [{ fullName: 'other ok', status: 'passed', title: 'ok' }],
      },
    ],
  });

  it('extracts only the failing tests with their files', () => {
    const failing = parseVitestJson(vitestJson);
    expect(failing).toEqual([
      { id: 'attribution maps a test', file: '/repo/src/attribution.test.ts' },
    ]);
  });

  it('malformed stdout yields an empty list (infra problem, not green)', () => {
    expect(parseVitestJson(null)).toEqual([]);
    expect(parseVitestJson('')).toEqual([]);
    expect(parseVitestJson('not json')).toEqual([]);
    expect(parseVitestJson('{"testResults": "nope"}')).toEqual([]);
  });
});

describe('parseBoundaryCommits (the (#N) trailer mapping)', () => {
  it('maps subjects ending in (#N) to members and keeps others as issue null', () => {
    const log = [
      '1111111111111111111111111111111111111111\tfix: add eviction (#202)',
      '2222222222222222222222222222222222222222\tfix: add attribution (#201)',
      '3333333333333333333333333333333333333333\tchore: batch-level review fix',
    ].join('\n');
    const commits = parseBoundaryCommits(log);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toEqual({
      sha: '1111111111111111111111111111111111111111',
      subject: 'fix: add eviction (#202)',
      issue: 202,
    });
    expect(commits[2]?.issue).toBeNull();
  });

  it('skips malformed lines (no tab, bad sha, empty)', () => {
    const log = [
      'no-tab-line',
      'zzzz\tbad sha (#1)',
      '',
      '4444444444444444444444444444444444444444\tx (#7)',
    ].join('\n');
    const commits = parseBoundaryCommits(log);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.issue).toBe(7);
  });

  it('null input yields an empty list', () => {
    expect(parseBoundaryCommits(null)).toEqual([]);
  });

  it('a subject that merely mentions (#N) mid-sentence is not a boundary commit', () => {
    const log = ['5555555555555555555555555555555555555555\tfixes #201 along the way'];
    expect(parseBoundaryCommits(log.join('\n'))[0]?.issue).toBeNull();
  });
});

describe('commitsOfMember', () => {
  it('returns the member’s commits oldest first regardless of log order', () => {
    // git log prints newest first
    const boundaries = parseBoundaryCommits(
      [
        'cccccccccccccccccccccccccccccccccccccccc\tfix: third (#201)',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tfix: second (#202)',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tfix: first (#201)',
      ].join('\n')
    );
    expect(commitsOfMember(boundaries, 201)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cccccccccccccccccccccccccccccccccccccccc',
    ]);
    expect(commitsOfMember(boundaries, 999)).toEqual([]);
  });
});
