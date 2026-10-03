import { describe, expect, it } from 'vitest';
import { assessIssue, type ComposeIssueInput, composeBatch } from '../batch-compose';
import {
  assessReadiness,
  READINESS_FLOOR,
  TRACKER_CHECKLIST_MIN,
  TRACKER_SUBISSUE_MIN,
} from '../batch-readiness';

const AC_BODY = `Bug in \`packages/backend/src/x.ts\`.\n\n## Acceptance criteria\n- [ ] the duplicate is gone\n- [ ] a regression test covers it\n`;

describe('assessReadiness (#802)', () => {
  it('a bounded bug with acceptance criteria and a code path is ready and scores high', () => {
    const r = assessReadiness('fix: duplicate items on double save', AC_BODY, ['bug']);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.score).toBe(6);
  });

  it('a bug-labelled issue without a formal AC section still clears the floor', () => {
    const r = assessReadiness(
      'Minutes editor crashes',
      'Steps: open the editor, save twice. It crashes.',
      ['bug']
    );
    expect(r.ready).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(READINESS_FLOOR);
  });

  it('a feature with no acceptance-criteria section is blocked', () => {
    const r = assessReadiness('feat: portfolio mode', 'Search across all boards. '.repeat(5), [
      'enhancement',
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/feature with no acceptance-criteria section/);
  });

  it('a feature WITH an acceptance-criteria section is ready', () => {
    const r = assessReadiness('feat(chat): approval gate', AC_BODY, ['enhancement']);
    expect(r.ready).toBe(true);
  });

  it('a checklist alone does not rescue a feature (needs an AC section)', () => {
    const body = `Do the thing.\n${'- [ ] step\n'.repeat(4)}`;
    expect(assessReadiness('feat: thing', body, ['enhancement']).ready).toBe(false);
  });

  it('a punch list title is a tracker', () => {
    const r = assessReadiness('fix(mobile): layout punch list from the demo', AC_BODY, ['bug']);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/punch list/);
  });

  it(`a checklist of ${TRACKER_CHECKLIST_MIN}+ items is a tracker, fewer is acceptance criteria`, () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `- [ ] item ${i}`).join('\n');
    expect(
      assessReadiness(
        'fix: x',
        `Body text here that is long enough.\n${items(TRACKER_CHECKLIST_MIN)}`,
        ['bug']
      ).ready
    ).toBe(false);
    expect(
      assessReadiness(
        'fix: x',
        `Body text here that is long enough.\n${items(TRACKER_CHECKLIST_MIN - 1)}`,
        ['bug']
      ).ready
    ).toBe(true);
  });

  it(`${TRACKER_SUBISSUE_MIN}+ task items linking issues is a tracker`, () => {
    const body = `Umbrella of work items to land.\n- [ ] #11\n- [ ] #12 sub\n- [ ] org/repo#13\n`;
    const r = assessReadiness('Cleanup pass', body, ['chore']);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/link sub-issues/);
  });

  it('an initiative (strategy/metrics/kill-criteria headings, declared sub-issues) is blocked', () => {
    const body =
      '## Summary\nx\n## Implementation plan — 4 sub-issues\n## Strategic framing\n## Success metrics\n## Kill criteria\n';
    const r = assessReadiness('Investor hook', body, ['enhancement']);
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/initiative/);
    expect(r.blockers.join(' ')).toMatch(/sub-issues/);
  });

  it('three Phase/Part headings make a multi-stage initiative', () => {
    const body =
      '# Phase 1 — a\ntext\n# Phase 2 — b\ntext\n# Phase 3 — c\ntext text text text text text';
    expect(assessReadiness('Do it', body, ['chore']).blockers.join(' ')).toMatch(/Phase\/Part/);
  });

  it('an audit title needs a findings list to be a tracker (a bounded title tolerates a short one)', () => {
    const list = Array.from({ length: 8 }, (_, i) => `- finding ${i}`).join('\n');
    expect(assessReadiness('Audit of the auth flow', `Findings follow.\n${list}`, []).ready).toBe(
      false
    );
    expect(
      assessReadiness('chore: audit remaining call sites', `Sites to convert:\n${list}`, []).ready
    ).toBe(true);
    expect(
      assessReadiness(
        'fix audit log rotation',
        'The rotation job skips the last file in the folder.',
        ['bug']
      ).ready
    ).toBe(true);
  });

  it('an unlabelled issue with no AC, no bounded type and no paths is below the floor', () => {
    const r = assessReadiness(
      'Agent-first onboarding',
      'Make MCP a first-class citizen for new users somehow.',
      []
    );
    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/nothing says it is bounded/);
  });

  it('a named code path alone is not enough', () => {
    expect(
      assessReadiness('Tidy the module', 'Look at packages/core/src/a.ts and improve things.', [])
        .ready
    ).toBe(false);
  });

  it('is linear on adversarial 200 KB bodies (the unbounded path regex was quadratic: 93 s)', () => {
    for (const body of [
      'a'.repeat(200_000),
      'a.'.repeat(100_000),
      'a/'.repeat(100_000),
      `${'x'.repeat(59)}/`.repeat(3_400),
    ]) {
      const t = Date.now();
      assessReadiness('fix: x', body, ['bug']);
      expect(Date.now() - t).toBeLessThan(200);
    }
  });

  it('does not block bounded issues on product nouns or prose (#926 review)', () => {
    const body =
      'The card overflows its container on narrow screens, see `packages/frontend/src/c.tsx`.';
    expect(assessReadiness('fix: initiative card overflow', body, ['bug']).ready).toBe(true);
    expect(assessReadiness('Fix roadmap page rendering', body, ['bug']).ready).toBe(true);
    expect(assessReadiness('fix: theme toggle flickers', body, ['bug', 'theme']).ready).toBe(true);
    expect(
      assessReadiness(
        'fix: parent not updated',
        `${body}\nClosing 2 sub-issues does not update the parent.`,
        ['bug']
      ).ready
    ).toBe(true);
    // ...but a lead/closing tracker word still blocks.
    expect(assessReadiness('Roadmap: Q4 platform work', body, []).ready).toBe(false);
    expect(assessReadiness('Investor acquisition initiative', body, []).ready).toBe(false);
  });

  it('a bounded bug with a long AC checklist is a spec, not a tracker; a long plain checklist still is (#926 review)', () => {
    const items = Array.from({ length: 12 }, (_, i) => `- [ ] check ${i}`).join('\n');
    expect(
      assessReadiness('fix: export', `Export breaks.\n## Acceptance criteria\n${items}`, ['bug'])
        .ready
    ).toBe(true);
    expect(assessReadiness('Cleanup pass', `Things to do here.\n${items}`, ['chore']).ready).toBe(
      false
    );
  });

  it('a standard bug-template report is bounded without a label; a 9-item plain checklist alone is not (#926 review)', () => {
    const report =
      '## Steps to reproduce\n1. open the board\n2. save twice\n## Expected behavior\nOne item.\n';
    expect(assessReadiness('Duplicate items when saving twice', report, []).ready).toBe(true);
    const nine = `Several things to do around here.\n${Array.from({ length: 9 }, (_, i) => `- [ ] item ${i}`).join('\n')}`;
    expect(assessReadiness('Assorted work', nine, []).ready).toBe(false);
  });

  it('plain bullet lists of issue links are trackers too (#926 review)', () => {
    const body =
      'Work items to land as part of this pass.\n- #12\n- #13\n- https://github.com/o/r/issues/14\n';
    expect(assessReadiness('Cleanup pass', body, ['chore']).blockers.join(' ')).toMatch(
      /link sub-issues/
    );
  });

  it('an empty body is blocked', () => {
    expect(assessReadiness('fix: x', '', ['bug']).blockers.join(' ')).toMatch(/empty or too short/);
  });

  it('ready:* and engineering-ready labels count as bounded', () => {
    expect(
      assessReadiness('Something', 'Enough text to be a body of a real issue here.', [
        'ready:backend',
      ]).ready
    ).toBe(true);
    expect(
      assessReadiness('Something', 'Enough text to be a body of a real issue here.', [
        'engineering-ready',
      ]).ready
    ).toBe(true);
  });
});

function backlogInput(over: Partial<ComposeIssueInput>): ComposeIssueInput {
  return {
    issue: 7,
    source: 'backlog',
    title: 'feat: portfolio mode',
    body: 'Search across all boards, no acceptance criteria here at all really.',
    labels: ['enhancement'],
    state: 'OPEN',
    assignees: [],
    ...over,
  };
}

describe('assessIssue — readiness screen in compose (#802)', () => {
  it('excludes an unready BACKLOG candidate with a stated not-ready reason', () => {
    const a = assessIssue(backlogInput({}));
    expect(a.admissible).toBe(false);
    expect(a.excluded.map((e) => e.code)).toContain('not-ready');
    expect(a.excluded.find((e) => e.code === 'not-ready')?.message).toMatch(/acceptance-criteria/);
    expect(a.readiness.ready).toBe(false);
  });

  it('never drops an explicit PICK for readiness, but still records it', () => {
    const a = assessIssue(backlogInput({ source: 'pick' }));
    expect(a.admissible).toBe(true);
    expect(a.readiness.ready).toBe(false);
  });

  it('--rules legacy reproduces pre-#770 admission: no readiness screen', () => {
    expect(assessIssue(backlogInput({}), 'legacy').excluded.map((e) => e.code)).not.toContain(
      'not-ready'
    );
  });

  it('backfill ranks better-specified candidates first, all else equal', () => {
    const ready = (issue: number, body: string, labels: string[]) =>
      assessIssue(backlogInput({ issue, title: 'fix: thing', body, labels }));
    const weak = ready(1, 'A bounded thing with enough words in the body to count.', ['bug']);
    const strong = ready(2, AC_BODY, ['bug']);
    const r = composeBatch([weak, strong], {
      rules: 'v2',
      baseBranch: 'main',
      minMembers: 1,
      maxMembers: 2,
      maxFullReview: 2,
      picksMode: false,
    });
    expect(r.members.map((m) => m.issue)).toEqual([2, 1]);
    expect(r.members[0].readiness).toBeGreaterThan(r.members[1].readiness);
  });
});
