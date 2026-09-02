import { describe, expect, it } from 'vitest';
import { isIssueNumber } from '../gh';
import {
  BATCH_PHASES,
  BATCH_SPECS,
  buildMilestone,
  CLASSIFY_SPEC,
  computeResume,
  DEFAULT_GENERATION,
  defaultNext,
  FENCE_STATUS,
  fenceGeneration,
  generationOf,
  hitLoopCap,
  isAcKey,
  isBatchPhase,
  isFenced,
  isKnownPhase,
  isPhase,
  KEY_VALUE_RULES,
  latestFence,
  MAX_GENERATION,
  MAX_VALUE_LENGTH,
  mintRunId,
  NEXT_VALUES,
  nextFenceGeneration,
  nowStamp,
  type ParsedMilestone,
  PHASE_SPECS,
  PHASES,
  parseDispatchedAt,
  parseGeneration,
  parseMilestone,
  parseMilestones,
  type ResumeProbe,
  RUNSTATE_MARKER,
  requiredKeys,
  STATUSES,
  splitPair,
  statusAllowed,
  validateMilestone,
} from '../runstate';

/**
 * The per-phase required-key table exactly as written in
 * `imboard-ai/git/full-cycle-issue@3.8.0`'s "Runstate Milestones" section. Kept as a
 * literal here (rather than derived from PHASE_SPECS) so that drifting the source table
 * away from the dossier spec fails the suite.
 */
const DOSSIER_SPEC: Array<{ phase: string; statuses: string[]; keys: Record<string, string[]> }> = [
  { phase: 'gate', statuses: ['done', 'blocked'], keys: { done: ['base_branch', 'warnings'] } },
  {
    phase: 'setup',
    statuses: ['done', 'blocked'],
    keys: { done: ['branch', 'worktree', 'pool_claimed', 'base_branch'] },
  },
  {
    phase: 'plan',
    statuses: ['done', 'blocked'],
    keys: { done: ['planning', 'head', 'open_questions', 'visual_review'] },
  },
  {
    phase: 'implement',
    statuses: ['done', 'blocked'],
    keys: { done: ['head', 'files', 'tests_added', 'tests_run', 'ci_parity'] },
  },
  {
    phase: 'review',
    statuses: ['done', 'partial', 'blocked'],
    keys: {
      done: ['head', 'fixed', 'escalated', 'agents_done', 'agents_pending'],
      partial: ['head', 'fixed', 'escalated', 'agents_done', 'agents_pending'],
    },
  },
  {
    phase: 'ship',
    statuses: ['awaiting-merge', 'done', 'blocked'],
    keys: {
      'awaiting-merge': ['pr', 'head', 'ci_fix_attempts'],
      done: ['pr', 'merge_commit', 'ci_fix_attempts', 'cleanup'],
    },
  },
  { phase: 'report', statuses: ['done'], keys: { done: ['pr', 'traps_added'] } },
];

const noopProbe: ResumeProbe = {
  branchOnRemote: () => true,
  headOnRemote: () => true,
  dirExists: () => true,
  prState: () => null,
  issueClosed: () => false,
};

function probe(overrides: Partial<ResumeProbe> = {}): ResumeProbe {
  return { ...noopProbe, ...overrides };
}

function milestone(body: string) {
  const parsed = parseMilestone(body);
  if (!parsed) throw new Error('expected a runstate milestone');
  return parsed;
}

/** One milestone from a header line plus key lines — the computeResume fixtures' shape. */
function m(header: string, ...keys: string[]) {
  return milestone(`${RUNSTATE_MARKER}\n${header}\n${keys.join('\n')}\nnext=x\n`);
}

describe('runstate spec table', () => {
  it('matches full-cycle-issue@3.8.0 phase order', () => {
    expect([...PHASES]).toEqual(['gate', 'setup', 'plan', 'implement', 'review', 'ship', 'report']);
  });

  it('exposes exactly the five protocol statuses', () => {
    expect([...STATUSES]).toEqual([
      'done',
      'partial',
      'blocked',
      'awaiting-merge',
      // #504's fence. Universally valid rather than per-phase, so it is deliberately
      // absent from every PHASE_SPECS.statuses below.
      'superseded',
    ]);
  });

  it.each(DOSSIER_SPEC)('phase $phase allows only its spec statuses', ({ phase, statuses }) => {
    expect([...PHASE_SPECS[phase as keyof typeof PHASE_SPECS].statuses].sort()).toEqual(
      [...statuses].sort()
    );
  });

  it.each(DOSSIER_SPEC)('phase $phase requires the spec keys', ({ phase, keys }) => {
    for (const [status, expected] of Object.entries(keys)) {
      const actual = requiredKeys(
        phase as Parameters<typeof requiredKeys>[0],
        status as Parameters<typeof requiredKeys>[1]
      );
      expect([...actual].sort()).toEqual([...expected].sort());
    }
  });

  it.each(DOSSIER_SPEC)('phase $phase requires reason= when blocked', ({ phase, statuses }) => {
    if (!statuses.includes('blocked')) return;
    expect(requiredKeys(phase as Parameters<typeof requiredKeys>[0], 'blocked')).toContain(
      'reason'
    );
  });
});

describe('defaultNext', () => {
  it('walks the linear phase order', () => {
    expect(defaultNext('gate', 'done')).toBe('setup');
    expect(defaultNext('setup', 'done')).toBe('plan');
    expect(defaultNext('plan', 'done')).toBe('implement');
    expect(defaultNext('implement', 'done')).toBe('review');
    expect(defaultNext('review', 'done')).toBe('ship');
    expect(defaultNext('ship', 'done')).toBe('report');
    expect(defaultNext('report', 'done')).toBe('done');
  });

  it('ends the run on blocked', () => {
    for (const phase of PHASES) {
      expect(defaultNext(phase, 'blocked')).toBe('done');
    }
  });

  it('keeps awaiting-merge inside ship (a second ship milestone follows)', () => {
    expect(defaultNext('ship', 'awaiting-merge')).toBe('ship');
  });

  it('keeps a partial review in review (agents still pending)', () => {
    expect(defaultNext('review', 'partial')).toBe('review');
  });
});

describe('buildMilestone', () => {
  it('renders the exact protocol template', () => {
    const body = buildMilestone({
      phase: 'setup',
      status: 'done',
      run: 'r-440-ab56',
      at: '2026-08-24T10:00:00Z',
      keys: [
        ['branch', 'feature/440-cli-runstate-subcommand'],
        ['worktree', '/repo/worktrees/feature-440'],
        ['pool_claimed', 'false'],
        ['base_branch', 'main'],
      ],
    });

    expect(body).toBe(
      [
        '<!-- runstate:v1 -->',
        'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:00:00Z',
        'branch=feature/440-cli-runstate-subcommand',
        'worktree=/repo/worktrees/feature-440',
        'pool_claimed=false',
        'base_branch=main',
        'next=plan',
        '',
      ].join('\n')
    );
  });

  it('starts with the marker readers filter on', () => {
    const body = buildMilestone({ phase: 'gate', status: 'done', run: 'r-1-abcd' });
    expect(body.startsWith(RUNSTATE_MARKER)).toBe(true);
  });

  it('timestamps itself in date -u format rather than leaving a shell expansion', () => {
    const body = buildMilestone({ phase: 'gate', status: 'done', run: 'r-1-abcd' });
    expect(body).not.toContain('$(');
    expect(body).toMatch(/at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it('honours an explicit next override', () => {
    const body = buildMilestone({
      phase: 'ship',
      status: 'awaiting-merge',
      run: 'r-1-abcd',
      next: 'report',
    });
    expect(body).toContain('next=report');
  });

  it('emits next=done for an unknown phase rather than crashing', () => {
    const body = buildMilestone({ phase: 'nope', status: 'done', run: 'r-1-abcd' });
    expect(body).toContain('next=done');
  });
});

describe('nowStamp', () => {
  it('drops milliseconds and keeps the Z suffix', () => {
    expect(nowStamp(new Date('2026-08-24T10:11:12.345Z'))).toBe('2026-08-24T10:11:12Z');
  });
});

describe('validateMilestone', () => {
  const valid = {
    phase: 'gate',
    status: 'done',
    run: 'r-440-ab56',
    keys: [
      ['base_branch', 'main'],
      ['warnings', '0'],
    ] as Array<[string, string]>,
  };

  it('accepts a well-formed milestone', () => {
    expect(validateMilestone(valid)).toEqual([]);
  });

  it('rejects an unknown phase with one actionable line', () => {
    const errors = validateMilestone({ ...valid, phase: 'deploy' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Unknown phase 'deploy'");
    expect(errors[0]).toContain('gate, setup, plan, implement, review, ship, report');
  });

  it('rejects an unknown status', () => {
    const errors = validateMilestone({ ...valid, status: 'finished' });
    expect(errors.some((e) => e.includes("Unknown status 'finished'"))).toBe(true);
  });

  it('rejects a status that is valid globally but not for this phase', () => {
    const errors = validateMilestone({ ...valid, status: 'partial' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      "Status 'partial' is not valid for phase 'gate' — expected one of: done, blocked ('superseded' is valid on every phase, but is written by 'runstate fence', never by hand)"
    );
  });

  it('allows partial on review only', () => {
    expect(
      validateMilestone({
        phase: 'review',
        status: 'partial',
        run: 'r-440-ab56',
        keys: [
          ['head', 'abc1234'],
          ['fixed', '2'],
          ['escalated', '0'],
          ['agents_done', 'security,perf'],
          ['agents_pending', 'a11y'],
        ],
      })
    ).toEqual([]);
  });

  it('names every missing required key in one line with a copy-pasteable fix', () => {
    const errors = validateMilestone({
      phase: 'implement',
      status: 'done',
      run: 'r-440-ab56',
      keys: [['head', 'abc1234']],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Phase 'implement' with status 'done' requires");
    expect(errors[0]).toContain('files=');
    expect(errors[0]).toContain('tests_added=');
    expect(errors[0]).toContain('tests_run=');
    expect(errors[0]).toContain('ci_parity=');
    expect(errors[0]).toContain('--kv files=<value>');
  });

  it('requires reason= on a blocked milestone', () => {
    const errors = validateMilestone({ phase: 'plan', status: 'blocked', run: 'r-440-ab56' });
    expect(errors.some((e) => e.includes('reason='))).toBe(true);
  });

  it('accepts a blocked milestone that carries reason=', () => {
    expect(
      validateMilestone({
        phase: 'plan',
        status: 'blocked',
        run: 'r-440-ab56',
        keys: [['reason', 'needs-clarification']],
      })
    ).toEqual([]);
  });

  it('rejects a shell expansion left in a value', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [
        ['base_branch', 'main'],
        ['warnings', '$(date -u)'],
      ],
    });
    // One line per offending key, even though this value breaks two rules at once.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("contains '$'");
  });

  it('rejects spaces in ordinary values', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [
        ['base_branch', 'my branch'],
        ['warnings', '0'],
      ],
    });
    expect(errors.some((e) => e.includes('contains whitespace'))).toBe(true);
  });

  it('allows spaces in ac* values', () => {
    expect(
      validateMilestone({
        phase: 'report',
        status: 'done',
        run: 'r-440-ab56',
        keys: [
          ['pr', '441'],
          ['traps_added', '1'],
          ['ac1', 'AC1 met — four subcommands with unit tests'],
          ['ac_results', 'all four criteria verified'],
        ],
      })
    ).toEqual([]);
  });

  it('rejects a relative path for path-valued keys', () => {
    const errors = validateMilestone({
      phase: 'setup',
      status: 'done',
      run: 'r-440-ab56',
      keys: [
        ['branch', 'feature/440'],
        ['worktree', 'worktrees/feature-440'],
        ['pool_claimed', 'true'],
        ['base_branch', 'main'],
      ],
    });
    expect(errors).toEqual([
      "Key 'worktree' must be an absolute path, got 'worktrees/feature-440'",
    ]);
  });

  it('rejects a malformed run id and points at mint', () => {
    const errors = validateMilestone({ ...valid, run: 'run-1' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('runstate mint');
  });

  it('rejects duplicate keys', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [
        ['base_branch', 'main'],
        ['warnings', '0'],
        ['warnings', '1'],
      ],
    });
    expect(errors).toEqual(["Duplicate key 'warnings' — each key may appear at most once"]);
  });

  it('rejects an empty value', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [
        ['base_branch', ''],
        ['warnings', '0'],
      ],
    });
    expect(errors.some((e) => e.includes('empty value'))).toBe(true);
  });

  it('rejects a non-snake_case key', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [
        ['base_branch', 'main'],
        ['warnings', '0'],
        ['BaseBranch', 'main'],
      ],
    });
    expect(errors.some((e) => e.includes('lower_snake_case'))).toBe(true);
  });
});

describe('isAcKey', () => {
  it.each(['ac', 'ac1', 'ac12', 'ac_results', 'ac2_note'])('treats %s as an AC key', (key) => {
    expect(isAcKey(key)).toBe(true);
  });

  it.each(['acme', 'branch', 'head'])('does not treat %s as an AC key', (key) => {
    expect(isAcKey(key)).toBe(false);
  });
});

describe('splitPair', () => {
  it('splits at the first =', () => {
    expect(splitPair('base_branch=main')).toEqual(['base_branch', 'main']);
  });

  it('keeps later = signs in the value', () => {
    expect(splitPair('cmd=a=b=c')).toEqual(['cmd', 'a=b=c']);
  });

  it('returns an empty value for a trailing =', () => {
    expect(splitPair('warnings=')).toEqual(['warnings', '']);
  });

  it.each(['base_branch', '', '=main'])('rejects %o, which has no key', (token) => {
    expect(splitPair(token)).toBeNull();
  });

  it('is the grammar parseMilestone and --kv both use', () => {
    // Guards the one behaviour the two callers must agree on: a value may contain '='.
    const parsed = parseMilestone(
      `${RUNSTATE_MARKER}\nphase=gate status=done run=r-1-abcd at=2026-08-24T10:00:00Z\nnext=done\n`
    );
    expect(parsed?.at).toBe('2026-08-24T10:00:00Z');
  });
});

describe('parseMilestone', () => {
  it('round-trips a built milestone', () => {
    const body = buildMilestone({
      phase: 'ship',
      status: 'awaiting-merge',
      run: 'r-440-ab56',
      at: '2026-08-24T10:00:00Z',
      keys: [
        ['pr', '441'],
        ['head', 'abc1234'],
        ['ci_fix_attempts', '0'],
      ],
    });

    expect(parseMilestone(body)).toEqual({
      phase: 'ship',
      status: 'awaiting-merge',
      run: 'r-440-ab56',
      at: '2026-08-24T10:00:00Z',
      next: 'ship',
      keys: {
        phase: 'ship',
        status: 'awaiting-merge',
        run: 'r-440-ab56',
        at: '2026-08-24T10:00:00Z',
        pr: '441',
        head: 'abc1234',
        ci_fix_attempts: '0',
        next: 'ship',
      },
    });
  });

  it('returns null for a non-runstate comment', () => {
    expect(parseMilestone('**Agent pickup** — work started')).toBeNull();
  });

  it('keeps spaces in ac* values on their own line', () => {
    const parsed = milestone(
      `${RUNSTATE_MARKER}\nphase=report status=done run=r-440-ab56 at=2026-08-24T10:00:00Z\nac1=AC1 met in full\nnext=done\n`
    );
    expect(parsed.keys.ac1).toBe('AC1 met in full');
  });

  it('tolerates a milestone with only the header line', () => {
    const parsed = milestone(
      `${RUNSTATE_MARKER}\nphase=gate status=done run=r-440-ab56 at=2026-08-24T10:00:00Z\n`
    );
    expect(parsed.phase).toBe('gate');
    expect(parsed.next).toBe('');
  });

  it('filters non-runstate comments out of a comment list', () => {
    const bodies = [
      'plain comment',
      buildMilestone({ phase: 'gate', status: 'done', run: 'r-440-ab56' }),
      'another plain comment',
      buildMilestone({ phase: 'setup', status: 'done', run: 'r-440-ab56' }),
    ];
    const parsed = parseMilestones(bodies);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((m) => m.phase)).toEqual(['gate', 'setup']);
  });
});

describe('mintRunId', () => {
  it('mints r-<issue>-<4 hex>', () => {
    expect(mintRunId(440)).toMatch(/^r-440-[0-9a-f]{4}$/);
  });

  it('passes its own validation', () => {
    const run = mintRunId('440');
    expect(
      validateMilestone({ phase: 'gate', status: 'blocked', run, keys: [['reason', 'x']] })
    ).toEqual([]);
  });
});

describe('hitLoopCap', () => {
  const blocked = (phase: string) =>
    milestone(
      `${RUNSTATE_MARKER}\nphase=${phase} status=blocked run=r-1-abcd at=2026-08-24T10:00:00Z\nreason=x\nnext=done\n`
    );
  const done = (phase: string) =>
    milestone(
      `${RUNSTATE_MARKER}\nphase=${phase} status=done run=r-1-abcd at=2026-08-24T10:00:00Z\nnext=done\n`
    );

  it('fires on three consecutive blocks of the same phase', () => {
    expect(hitLoopCap([blocked('plan'), blocked('plan'), blocked('plan')])).toBe(true);
  });

  it('does not fire on blocks of different phases', () => {
    expect(hitLoopCap([blocked('plan'), blocked('implement'), blocked('plan')])).toBe(false);
  });

  it('does not fire when the streak is broken by a success', () => {
    expect(hitLoopCap([blocked('plan'), done('plan'), blocked('plan')])).toBe(false);
  });

  it('does not fire with fewer than three milestones', () => {
    expect(hitLoopCap([blocked('plan'), blocked('plan')])).toBe(false);
  });
});

describe('computeResume', () => {
  const gateDone = m(
    'phase=gate status=done run=r-440-ab56 at=2026-08-24T10:00:00Z',
    'base_branch=main'
  );
  const setupDone = m(
    'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:01:00Z',
    'branch=feature/440',
    'worktree=/repo/worktrees/feature-440'
  );
  const planDone = m(
    'phase=plan status=done run=r-440-ab56 at=2026-08-24T10:02:00Z',
    'planning=/repo/worktrees/feature-440/PLANNING-440.md',
    'head=abc1234'
  );
  const implementDone = m(
    'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
    'head=abc1234'
  );

  const reviewDone = m(
    'phase=review status=done run=r-440-ab56 at=2026-08-24T10:04:00Z',
    'head=abc1234'
  );

  it('reports a fresh run when there are no milestones', () => {
    const result = computeResume([], probe());
    expect(result.resume_from).toBe('none');
    expect(result.run_id).toBeNull();
    expect(result.last).toBeNull();
  });

  it('reuses the run id from the last milestone', () => {
    expect(computeResume([gateDone], probe()).run_id).toBe('r-440-ab56');
  });

  it('resumes at setup after a gate milestone without verifying anything', () => {
    expect(computeResume([gateDone], probe()).resume_from).toBe('setup');
  });

  it('resumes at plan when the setup claims verify', () => {
    const result = computeResume([gateDone, setupDone], probe());
    expect(result.resume_from).toBe('plan');
    expect(result.verified).toEqual(['branch']);
  });

  it('falls back to setup when the branch is gone from the remote', () => {
    const result = computeResume([gateDone, setupDone], probe({ branchOnRemote: () => false }));
    expect(result.resume_from).toBe('setup');
  });

  // Remote-first (WIP sync rule): a resume that has verified the branch on origin must not
  // fall back to setup just because this machine has never seen the worktree — issue #499.
  it('does not fall back to setup when only the local worktree directory is gone', () => {
    const result = computeResume([gateDone, setupDone], probe({ dirExists: () => false }));
    expect(result.resume_from).toBe('plan');
    expect(result.local_worktree).toBe('absent');
  });

  it('resumes at implement when the plan head verifies on origin', () => {
    const result = computeResume([gateDone, setupDone, planDone], probe());
    expect(result.resume_from).toBe('implement');
    expect(result.verified).toContain('head');
  });

  it('falls back to plan when the plan head cannot be verified on origin', () => {
    const result = computeResume(
      [gateDone, setupDone, planDone],
      probe({ headOnRemote: () => false })
    );
    expect(result.resume_from).toBe('plan');
  });

  it('falls back to setup from plan when the branch is gone from the remote', () => {
    const result = computeResume(
      [gateDone, setupDone, planDone],
      probe({ branchOnRemote: () => false })
    );
    expect(result.resume_from).toBe('setup');
  });

  // Cross-machine regression (#499): a recovery run on a machine that has never seen the
  // worktree must still resume forward — resume verification is remote-first, and a local
  // worktree is a bonus signal, never a requirement.
  it('resumes at implement from setup+plan milestones when the worktree does not exist on this machine', () => {
    const result = computeResume(
      [gateDone, setupDone, planDone],
      probe({ dirExists: () => false })
    );
    expect(result.resume_from).toBe('implement');
    expect(result.local_worktree).toBe('absent');
  });

  it('resumes at review when the implement head verifies on origin', () => {
    const result = computeResume(
      [gateDone, setupDone, planDone, implementDone],
      probe({ headOnRemote: (_branch, head) => head === 'abc1234' })
    );
    expect(result.resume_from).toBe('review');
    expect(result.verified).toContain('head');
  });

  it('tolerates a -dirty suffix on the recorded head', () => {
    const dirty = m(
      'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
      'head=abc1234-dirty'
    );
    const result = computeResume(
      [gateDone, setupDone, dirty],
      probe({ headOnRemote: (_branch, head) => head === 'abc1234' })
    );
    expect(result.resume_from).toBe('review');
  });

  it('falls back to implement when the head cannot be verified on origin', () => {
    const result = computeResume(
      [gateDone, setupDone, planDone, implementDone],
      probe({ headOnRemote: () => false })
    );
    expect(result.resume_from).toBe('implement');
  });

  it('resumes at ship after a completed review', () => {
    expect(computeResume([gateDone, setupDone, reviewDone], probe()).resume_from).toBe('ship');
  });

  it('re-enters review when the review was partial', () => {
    const reviewPartial = m(
      'phase=review status=partial run=r-440-ab56 at=2026-08-24T10:04:00Z',
      'agents_pending=a11y',
      'head=abc1234'
    );
    const result = computeResume([gateDone, setupDone, reviewPartial], probe());
    expect(result.resume_from).toBe('review');
    expect(result.resume_context.agents_pending).toBe('a11y');
  });

  it('re-enters review when a partial review head cannot be verified on origin', () => {
    const reviewPartial = m(
      'phase=review status=partial run=r-440-ab56 at=2026-08-24T10:04:00Z',
      'agents_pending=a11y',
      'head=abc1234'
    );
    const result = computeResume(
      [gateDone, setupDone, reviewPartial],
      probe({ headOnRemote: () => false })
    );
    expect(result.resume_from).toBe('review');
  });

  it('falls back to review when a completed review head cannot be verified on origin', () => {
    const result = computeResume(
      [gateDone, setupDone, reviewDone],
      probe({ headOnRemote: () => false })
    );
    expect(result.resume_from).toBe('review');
  });

  it('routes awaiting-merge to ship-teardown once the PR is merged', () => {
    const shipWaiting = m(
      'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
      'pr=441'
    );
    const result = computeResume(
      [gateDone, setupDone, shipWaiting],
      probe({
        prState: () => ({ state: 'MERGED', mergedAt: '2026-08-24T11:00:00Z', mergeable: '' }),
      })
    );
    expect(result.resume_from).toBe('ship-teardown');
  });

  it('routes awaiting-merge to ship-wait while the PR is open and mergeable', () => {
    const shipWaiting = m(
      'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
      'pr=441'
    );
    const result = computeResume(
      [gateDone, setupDone, shipWaiting],
      probe({ prState: () => ({ state: 'OPEN', mergedAt: null, mergeable: 'MERGEABLE' }) })
    );
    expect(result.resume_from).toBe('ship-wait');
  });

  it('routes awaiting-merge back to ship when the PR conflicts', () => {
    const shipWaiting = m(
      'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
      'pr=441'
    );
    const result = computeResume(
      [gateDone, setupDone, shipWaiting],
      probe({ prState: () => ({ state: 'OPEN', mergedAt: null, mergeable: 'CONFLICTING' }) })
    );
    expect(result.resume_from).toBe('ship');
  });

  it('routes awaiting-merge back to ship when the PR cannot be read', () => {
    const shipWaiting = m(
      'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
      'pr=441'
    );
    const result = computeResume(
      [gateDone, setupDone, shipWaiting],
      probe({ prState: () => null })
    );
    expect(result.resume_from).toBe('ship');
  });

  it('resumes at report after ship done', () => {
    const shipDone = m('phase=ship status=done run=r-440-ab56 at=2026-08-24T10:06:00Z', 'pr=441');
    expect(computeResume([gateDone, shipDone], probe()).resume_from).toBe('report');
  });

  it('reports done when report finished and the issue is closed', () => {
    const reportDone = m('phase=report status=done run=r-440-ab56 at=2026-08-24T10:07:00Z');
    const result = computeResume([gateDone, reportDone], probe({ issueClosed: () => true }));
    expect(result.resume_from).toBe('done');
    expect(result.note).toBe('already complete');
  });

  it('re-runs report when the issue is still open', () => {
    const reportDone = m('phase=report status=done run=r-440-ab56 at=2026-08-24T10:07:00Z');
    expect(
      computeResume([gateDone, reportDone], probe({ issueClosed: () => false })).resume_from
    ).toBe('report');
  });

  describe('#582 stale report/done trail (dispatchedAt)', () => {
    const openProbe = probe({ issueClosed: () => false });
    const closedProbe = probe({ issueClosed: () => true });

    it('enters fresh with a new run id and prior_run when the milestone predates dispatch (AC1)', () => {
      const reportDone = m(
        'phase=report status=done run=r-440-ab56 at=2026-08-24T07:00:00Z' // T-3h
      );
      const result = computeResume(
        [gateDone, reportDone],
        openProbe,
        '2026-08-24T10:00:00Z' // T
      );
      expect(result.resume_from).toBe('none');
      expect(result.run_id).not.toBeNull();
      expect(result.run_id).not.toBe('r-440-ab56');
      expect(result.prior_run).toBe('r-440-ab56');
      expect(result.note).toBe('stale-report-trail');
    });

    it("resumes into report as today when the milestone is this run's own (AC2)", () => {
      const reportDone = m(
        'phase=report status=done run=r-440-ab56 at=2026-08-24T10:01:00Z' // T+1m
      );
      const result = computeResume(
        [gateDone, reportDone],
        openProbe,
        '2026-08-24T10:00:00Z' // T
      );
      expect(result.resume_from).toBe('report');
      expect(result.run_id).toBe('r-440-ab56');
      expect(result.prior_run).toBeUndefined();
    });

    it('resumes done when the issue is closed regardless of milestone age (AC3)', () => {
      const reportDone = m(
        'phase=report status=done run=r-440-ab56 at=2026-08-24T07:00:00Z' // T-3h
      );
      const result = computeResume(
        [gateDone, reportDone],
        closedProbe,
        '2026-08-24T10:00:00Z' // T
      );
      expect(result.resume_from).toBe('done');
      expect(result.note).toBe('already complete');
      expect(result.prior_run).toBeUndefined();
    });

    it('flags the ambiguity instead of silently asserting report when no dispatch time is given', () => {
      const reportDone = m('phase=report status=done run=r-440-ab56 at=2026-08-24T07:00:00Z');
      const result = computeResume([gateDone, reportDone], openProbe);
      expect(result.resume_from).toBe('report');
      expect(result.note).toContain('no --dispatched-at supplied');
      expect(result.prior_run).toBeUndefined();
    });

    it('tolerates a 60s clock skew as "not stale"', () => {
      const reportDone = m(
        'phase=report status=done run=r-440-ab56 at=2026-08-24T09:59:30Z' // 30s before T
      );
      const result = computeResume(
        [gateDone, reportDone],
        openProbe,
        '2026-08-24T10:00:00Z' // T
      );
      expect(result.resume_from).toBe('report');
      expect(result.prior_run).toBeUndefined();
    });

    it('resets generation to 0 for the freshly minted run, even when the OLD run was fenced', () => {
      const fence = m(
        `phase=implement status=${FENCE_STATUS} run=r-440-ab56 at=2026-08-24T08:00:00Z`,
        'gen=2',
        'takeover=slot-2-r1'
      );
      const reportDone = m('phase=report status=done run=r-440-ab56 at=2026-08-24T07:00:00Z');
      const result = computeResume(
        [gateDone, fence, reportDone],
        openProbe,
        '2026-08-24T10:00:00Z'
      );
      expect(result.resume_from).toBe('none');
      expect(result.note).toBe('stale-report-trail');
      expect(result.generation).toBe(DEFAULT_GENERATION);
    });

    it('does not mint a fresh run when the issue state could not be read (probe returns null)', () => {
      const unknownProbe = probe({ issueClosed: () => null });
      const reportDone = m('phase=report status=done run=r-440-ab56 at=2026-08-24T07:00:00Z');
      const result = computeResume([gateDone, reportDone], unknownProbe, '2026-08-24T10:00:00Z');
      expect(result.resume_from).toBe('report');
      expect(result.run_id).toBe('r-440-ab56');
      expect(result.note).toContain('could not be read');
      expect(result.prior_run).toBeUndefined();
    });

    it('falls back to report instead of minting a poisoned run id from a malformed run=', () => {
      const reportDone = m(
        'phase=report status=done run=not-a-real-run-id at=2026-08-24T07:00:00Z'
      );
      const result = computeResume([gateDone, reportDone], openProbe, '2026-08-24T10:00:00Z');
      expect(result.resume_from).toBe('report');
      expect(result.note).toContain('unusable run id');
      expect(result.prior_run).toBeUndefined();
    });

    it('flags the ambiguity instead of treating an unparseable at= as stale', () => {
      const reportDone = m('phase=report status=done run=r-440-ab56 at=not-a-date');
      const result = computeResume([gateDone, reportDone], openProbe, '2026-08-24T10:00:00Z');
      expect(result.resume_from).toBe('report');
      expect(result.note).toContain('no parseable at=');
      expect(result.prior_run).toBeUndefined();
    });
  });

  describe('#582 parseDispatchedAt strictness', () => {
    it('accepts a well-formed ISO instant with a Z suffix', () => {
      expect(parseDispatchedAt('2026-08-24T10:00:00Z')).toBe('2026-08-24T10:00:00.000Z');
    });

    it('accepts an ISO instant with an explicit numeric offset', () => {
      expect(parseDispatchedAt('2026-08-24T10:00:00+02:00')).toBe('2026-08-24T08:00:00.000Z');
    });

    it('rejects a locale-formatted date with no explicit zone', () => {
      expect(parseDispatchedAt('Aug 24 2026')).toBeNull();
    });

    it('rejects a zone-less date-time (would be read as local time)', () => {
      expect(parseDispatchedAt('2026-08-24T10:00:00')).toBeNull();
    });

    it('rejects a bare year', () => {
      expect(parseDispatchedAt('2026')).toBeNull();
    });

    it('rejects garbage', () => {
      expect(parseDispatchedAt('not-a-date')).toBeNull();
    });
  });

  it('resumes a blocked phase at that same phase', () => {
    const blocked = m(
      'phase=implement status=blocked run=r-440-ab56 at=2026-08-24T10:08:00Z',
      'reason=tests-red'
    );
    expect(computeResume([gateDone, setupDone, blocked], probe()).resume_from).toBe('implement');
  });

  it('hard-blocks on a resume loop', () => {
    const blocked = m(
      'phase=plan status=blocked run=r-440-ab56 at=2026-08-24T10:08:00Z',
      'reason=vague'
    );
    const result = computeResume([blocked, blocked, blocked], probe());
    expect(result.hard_block).toBe('resume-loop');
  });

  it('merges context across milestones so later phases still see setup keys', () => {
    const result = computeResume([gateDone, setupDone, planDone], probe());
    expect(result.resume_context.branch).toBe('feature/440');
    expect(result.resume_context.worktree).toBe('/repo/worktrees/feature-440');
    expect(result.resume_context.base_branch).toBe('main');
    expect(result.resume_context.planning).toBe('/repo/worktrees/feature-440/PLANNING-440.md');
  });

  // Comments are world-writable, and a newer dossier may post a phase this build has
  // never heard of. Neither may crash or be silently treated as a known phase.
  it('treats an unrecognised phase as not resumable rather than crashing', () => {
    const alien = m('phase=deploy status=done run=r-440-ab56 at=2026-08-24T10:09:00Z');
    const result = computeResume([gateDone, setupDone, alien], probe());
    expect(result.resume_from).toBe('none');
    expect(result.run_id).toBe('r-440-ab56');
    // Nothing was probed, so nothing may be claimed as verified.
    expect(result.verified).toEqual([]);
  });

  it('treats a milestone with no phase= line at all as not resumable', () => {
    const headless = milestone(`${RUNSTATE_MARKER}\nstatus=done run=r-440-ab56\nnext=x\n`);
    expect(computeResume([headless], probe()).resume_from).toBe('none');
  });

  // `verified` is emitted verbatim as the gate milestone's `verified=` key, so a repeated
  // entry would land in the posted comment. Recording is idempotent by construction — each
  // resolver calls setupOk at most once, and `pass` de-dupes — and this pins that, so a
  // resolver that starts re-checking cannot quietly begin emitting `branch,branch`.
  it.each<[string, ParsedMilestone[]]>([
    ['plan', [gateDone, setupDone, planDone]],
    ['implement', [gateDone, setupDone, planDone, implementDone]],
    ['review', [gateDone, setupDone, reviewDone]],
  ])('records each passed check once when resuming after %s', (_phase, trail) => {
    const { verified } = computeResume(trail, probe());
    expect(verified).toEqual([...new Set(verified)]);
    expect(verified).toContain('branch');
    expect(verified).toContain('head');
  });

  it("reports local_worktree='n/a' when no milestone recorded a worktree", () => {
    expect(computeResume([gateDone], probe()).local_worktree).toBe('n/a');
  });

  it("reports local_worktree='present' when the recorded worktree exists on this machine", () => {
    const result = computeResume([gateDone, setupDone], probe({ dirExists: () => true }));
    expect(result.local_worktree).toBe('present');
  });

  it("reports local_worktree='absent' without changing resume_from", () => {
    const result = computeResume([gateDone, setupDone], probe({ dirExists: () => false }));
    expect(result.local_worktree).toBe('absent');
    expect(result.resume_from).toBe('plan');
  });
});

describe('validateMilestone — values that would corrupt the posted comment', () => {
  const valid = {
    phase: 'report',
    status: 'done',
    run: 'r-440-ab56',
    keys: [
      ['pr', '441'],
      ['traps_added', '1'],
    ] as Array<[string, string]>,
  };

  it('rejects a newline in a normal value', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [...valid.keys, ['note', 'a\nb']],
    });
    expect(errors.some((e) => e.includes('contains a newline'))).toBe(true);
  });

  it('rejects a newline in an ac* value even though spaces are allowed there', () => {
    // Without this, `--kv ac1=$'ok\nnext=done'` forges a second next= line, and
    // parseMilestone's first-occurrence-wins makes the FORGED one the real one.
    const errors = validateMilestone({
      ...valid,
      keys: [...valid.keys, ['ac1', 'looks fine\nnext=done']],
    });
    expect(errors.some((e) => e.includes('contains a newline'))).toBe(true);
  });

  it('rejects a carriage return too', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [...valid.keys, ['ac1', 'a\rb']],
    });
    expect(errors.some((e) => e.includes('contains a newline'))).toBe(true);
  });

  it('rejects an oversized value by name and length', () => {
    const errors = validateMilestone({
      ...valid,
      keys: [...valid.keys, ['files', 'x'.repeat(MAX_VALUE_LENGTH + 1)]],
    });
    const line = errors.find((e) => e.includes("Key 'files'"));
    expect(line).toBeDefined();
    expect(line).toContain(String(MAX_VALUE_LENGTH + 1));
    expect(line).toContain(String(MAX_VALUE_LENGTH));
  });

  it('accepts a value right at the size cap', () => {
    expect(
      validateMilestone({
        ...valid,
        keys: [...valid.keys, ['files', 'x'.repeat(MAX_VALUE_LENGTH)]],
      })
    ).toEqual([]);
  });
});

describe('validateMilestone — --next override', () => {
  const valid = {
    phase: 'gate',
    status: 'done',
    run: 'r-440-ab56',
    keys: [
      ['base_branch', 'main'],
      ['warnings', '0'],
    ] as Array<[string, string]>,
  };

  it.each([...PHASES, 'done'])('accepts next=%s', (next) => {
    expect(validateMilestone({ ...valid, next })).toEqual([]);
  });

  it('rejects a typo and lists the legal values', () => {
    const errors = validateMilestone({ ...valid, next: 'implememt' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid --next 'implememt'");
    expect(errors[0]).toContain('implement');
  });

  it('rejects a next value that would corrupt the line', () => {
    expect(validateMilestone({ ...valid, next: 'ship\nworktree=/tmp/x' })).toHaveLength(1);
    expect(validateMilestone({ ...valid, next: '' })).toHaveLength(1);
  });
});

describe('isIssueNumber', () => {
  it.each(['1', '440', '999999'])('accepts %s', (v) => {
    expect(isIssueNumber(v)).toBe(true);
  });

  it.each([
    '',
    '0',
    '-1',
    '4.4',
    '#440',
    'https://github.com/o/r/issues/440',
    ' 440',
    'abc',
  ])('rejects %s', (v) => {
    expect(isIssueNumber(v)).toBe(false);
  });
});

/**
 * The #461 vocabulary, transcribed from the issue's acceptance criteria (RFC-0001
 * C.2/D.2). Kept as a literal so drifting the source tables away from the issue text
 * fails the suite, same as DOSSIER_SPEC above.
 */
describe('runstate spec table — classify and batch phases (#461)', () => {
  it('keeps the full-cycle line untouched', () => {
    expect(PHASES).toEqual(['gate', 'setup', 'plan', 'implement', 'review', 'ship', 'report']);
  });

  it('exposes classify with exactly the eight verdict keys on done', () => {
    expect(CLASSIFY_SPEC.statuses).toEqual(['done', 'blocked']);
    expect(requiredKeys('classify', 'done')).toEqual([
      'mode',
      'risk',
      'est_files',
      'est_diff',
      'areas',
      'test_scope',
      'deps',
      'confidence',
    ]);
  });

  it('exposes the batch line with exactly the issue’s status sets', () => {
    expect(BATCH_PHASES).toEqual([
      'batch-setup',
      'batch-validate',
      'batch-review',
      'batch-ship',
      'batch-report',
    ]);
    for (const phase of BATCH_PHASES) {
      expect(BATCH_SPECS[phase].statuses).toEqual(
        phase === 'batch-ship'
          ? ['awaiting-merge', 'done', 'blocked']
          : phase === 'batch-report'
            ? ['done']
            : ['done', 'blocked']
      );
      // Deliberately no phase-specific required keys — the scheduler dossier owns those.
      expect(requiredKeys(phase, 'done')).toEqual([]);
    }
  });

  it('isKnownPhase accepts classify and the batch line; isPhase accepts neither', () => {
    expect(isKnownPhase('classify')).toBe(true);
    expect(isKnownPhase('batch-ship')).toBe(true);
    expect(isPhase('classify')).toBe(false);
    expect(isPhase('batch-ship')).toBe(false);
    expect(isBatchPhase('batch-report')).toBe(true);
    expect(isBatchPhase('ship')).toBe(false);
  });

  it('pins the #465-facing value-grammar key set', () => {
    expect(Object.keys(KEY_VALUE_RULES).sort()).toEqual([
      'ac_met',
      'ac_total',
      'areas',
      'batch',
      'confidence',
      'deps',
      'est_diff',
      'est_files',
      'gen',
      'mode',
      'risk',
      'takeover',
      'test_scope',
    ]);
  });
});

describe('defaultNext — classify and batch phases (#461)', () => {
  it('ends a classify trail at done (the dispatched cycle mints its own run)', () => {
    expect(defaultNext('classify', 'done')).toBe('done');
  });

  it('ends a blocked classify trail at done like every blocked phase', () => {
    expect(defaultNext('classify', 'blocked')).toBe('done');
  });

  it('walks the batch line in order', () => {
    expect(defaultNext('batch-setup', 'done')).toBe('batch-validate');
    expect(defaultNext('batch-validate', 'done')).toBe('batch-review');
    expect(defaultNext('batch-review', 'done')).toBe('batch-ship');
    expect(defaultNext('batch-ship', 'done')).toBe('batch-report');
    expect(defaultNext('batch-report', 'done')).toBe('done');
  });

  it('keeps batch-ship awaiting-merge inside batch-ship (a second milestone follows)', () => {
    expect(defaultNext('batch-ship', 'awaiting-merge')).toBe('batch-ship');
  });

  it('allows batch phases as --next values but not classify — nothing transitions INTO classify', () => {
    expect(NEXT_VALUES).toContain('batch-ship');
    expect(NEXT_VALUES).toContain('batch-report');
    expect(NEXT_VALUES).not.toContain('classify');
    expect(
      validateMilestone({
        phase: 'gate',
        status: 'done',
        run: 'r-440-ab56',
        keys: [
          ['base_branch', 'main'],
          ['warnings', '0'],
        ],
        next: 'classify',
      })
    ).toEqual([expect.stringContaining("Invalid --next 'classify'")]);
  });
});

describe('validateMilestone — classify (#461)', () => {
  const verdict = (overrides: Record<string, string> = {}) => {
    const pairs: Array<[string, string]> = [
      ['mode', 'slot'],
      ['risk', 'low'],
      ['est_files', '3'],
      ['est_diff', '120'],
      ['areas', 'cli,docs'],
      ['test_scope', 'focused'],
      ['deps', 'none'],
      ['confidence', '0.85'],
    ];
    const base = new Map(pairs);
    for (const [k, v] of Object.entries(overrides)) base.set(k, v);
    return {
      phase: 'classify',
      status: 'done',
      run: 'r-440-ab56',
      keys: [...base.entries()],
    };
  };

  it('accepts a well-formed slot verdict', () => {
    expect(validateMilestone(verdict())).toEqual([]);
  });

  it('accepts a well-formed full verdict', () => {
    expect(validateMilestone(verdict({ mode: 'full' }))).toEqual([]);
  });

  it('names every missing verdict key in one line with a copy-pasteable fix', () => {
    const errors = validateMilestone({
      phase: 'classify',
      status: 'done',
      run: 'r-440-ab56',
      keys: [['mode', 'full']],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Phase 'classify' with status 'done' requires");
    for (const key of [
      'risk=',
      'est_files=',
      'est_diff=',
      'areas=',
      'test_scope=',
      'deps=',
      'confidence=',
    ]) {
      expect(errors[0]).toContain(key);
    }
  });

  it('requires reason= on a blocked classify milestone', () => {
    const errors = validateMilestone({
      phase: 'classify',
      status: 'blocked',
      run: 'r-440-ab56',
      keys: [],
    });
    expect(errors.join('\n')).toContain('reason=');
  });
});

describe('validateMilestone — batch phases (#461)', () => {
  it.each([
    ['batch-setup', 'done'],
    ['batch-validate', 'done'],
    ['batch-review', 'done'],
    ['batch-ship', 'awaiting-merge'],
    ['batch-ship', 'done'],
    ['batch-report', 'done'],
  ])('accepts %s/%s with no phase-specific keys', (phase, status) => {
    expect(validateMilestone({ phase, status, run: 'r-440-ab56', keys: [] })).toEqual([]);
  });

  it.each([
    ['batch-setup', 'awaiting-merge'],
    ['batch-report', 'blocked'],
    ['batch-review', 'partial'],
    ['batch-validate', 'awaiting-merge'],
  ])('rejects %s/%s — not in the phase’s status set', (phase, status) => {
    const errors = validateMilestone({ phase, status, run: 'r-440-ab56', keys: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`Status '${status}' is not valid for phase '${phase}'`);
  });

  it('requires reason= on a blocked batch milestone', () => {
    const errors = validateMilestone({
      phase: 'batch-validate',
      status: 'blocked',
      run: 'r-440-ab56',
      keys: [],
    });
    expect(errors.join('\n')).toContain('reason=');
  });

  it('lists classify and the batch line in the unknown-phase error', () => {
    const errors = validateMilestone({
      phase: 'clssify',
      status: 'done',
      run: 'r-440-ab56',
      keys: [],
    });
    expect(errors[0]).toContain('classify');
    expect(errors[0]).toContain('batch-setup');
    expect(errors[0]).toContain('batch-report');
  });
});

describe('validateMilestone — value grammars for the new keys (#461)', () => {
  const withKey = (key: string, value: string) => {
    const base = new Map<string, string>([
      ['mode', 'full'],
      ['risk', 'low'],
      ['est_files', '1'],
      ['est_diff', '1'],
      ['areas', 'cli'],
      ['test_scope', 'focused'],
      ['deps', 'none'],
      ['confidence', '0.5'],
    ]);
    base.set(key, value);
    return validateMilestone({
      phase: 'classify',
      status: 'done',
      run: 'r-440-ab56',
      keys: [...base.entries()],
    });
  };

  it.each([
    ['mode', 'full'],
    ['mode', 'slot'],
    ['risk', 'low'],
    ['risk', 'med'],
    ['risk', 'high'],
    ['test_scope', 'focused'],
    ['test_scope', 'broad'],
    ['test_scope', 'unknown'],
    ['est_files', '0'],
    ['est_files', '12'],
    ['est_diff', '400'],
    ['confidence', '0'],
    ['confidence', '0.6'],
    ['confidence', '0.85'],
    ['confidence', '1'],
    ['confidence', '1.0'],
    ['areas', 'cli'],
    ['areas', 'cli,docs,mcp-server'],
    ['deps', 'none'],
    ['deps', '474'],
    ['deps', '474,480'],
    ['batch', 'b-2026-08-29-01'],
    ['batch', 'b1'],
  ])('accepts %s=%s', (key, value) => {
    // `batch` is not one of classify's keys, so prove it on a phase that takes it free-form.
    if (key === 'batch') {
      expect(
        validateMilestone({
          phase: 'plan',
          status: 'done',
          run: 'r-440-ab56',
          keys: [
            ['planning', '/repo/PLANNING.md'],
            ['head', 'abc1234'],
            ['open_questions', '0'],
            ['visual_review', 'false'],
            [key, value],
          ],
        })
      ).toEqual([]);
      return;
    }
    expect(withKey(key, value)).toEqual([]);
  });

  it.each([
    ['mode', 'Slot'],
    ['mode', 'fulll'],
    ['risk', 'medium'],
    ['risk', 'extreme'],
    ['test_scope', 'huge'],
    ['est_files', '-1'],
    ['est_files', '3.5'],
    ['est_files', 'many'],
    ['est_diff', '-400'],
    ['est_diff', '1.5'],
    ['confidence', 'high'],
    ['confidence', '1.5'],
    ['confidence', '-0.1'],
    ['confidence', '.5'],
    ['confidence', '85%'],
    ['areas', 'CLI Docs'],
    ['areas', 'cli,'],
    ['deps', '12,a'],
    ['deps', '#12'],
    ['batch', 'b 1'],
    ['batch', '#b1'],
    ['batch', 'b/1'],
  ])('rejects %s=%s with one actionable line', (key, value) => {
    const errors = withKey(key, value);
    expect(errors).toHaveLength(1);
    // For a grammar-carrying key the key-specific message fires even when the value
    // also has a space — it shows the correct form, which is the more actionable answer.
    expect(errors[0]).toMatch(
      new RegExp(`Key '${key}' (has an invalid value|contains whitespace)`)
    );
    expect(errors[0]).toMatch(/— /);
  });

  it('prefers the grammar message over the generic whitespace message for a known key', () => {
    expect(withKey('areas', 'CLI Docs')).toEqual([
      expect.stringContaining("Key 'areas' has an invalid value 'CLI Docs' — expected"),
    ]);
  });

  it('validates mode and batch on the slot-cycle phases too, not just classify', () => {
    const errors = validateMilestone({
      phase: 'implement',
      status: 'done',
      run: 'r-440-ab56',
      keys: [
        ['head', 'abc1234'],
        ['files', '2'],
        ['tests_added', '1'],
        ['tests_run', '3'],
        ['ci_parity', 'pass'],
        ['mode', 'slots'],
        ['batch', 'b/1'],
      ],
    });
    expect(errors).toEqual([
      "Key 'mode' has an invalid value 'slots' — expected one of: full, slot",
      expect.stringContaining("Key 'batch' has an invalid value 'b/1'"),
    ]);
  });
});

describe('computeResume — golden regression table for existing phases (#461)', () => {
  const shipAwaiting = m(
    'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
    'pr=1',
    'head=abc1234',
    'ci_fix_attempts=0'
  );
  const shipDone = m(
    'phase=ship status=done run=r-440-ab56 at=2026-08-24T10:06:00Z',
    'pr=1',
    'merge_commit=def5678',
    'ci_fix_attempts=0',
    'cleanup=worktree_removed'
  );
  const reportDone = m(
    'phase=report status=done run=r-440-ab56 at=2026-08-24T10:07:00Z',
    'pr=1',
    'traps_added=0'
  );
  const gateDone2 = m(
    'phase=gate status=done run=r-440-ab56 at=2026-08-24T10:00:00Z',
    'base_branch=main'
  );
  const setupDone2 = m(
    'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:01:00Z',
    'branch=feature/440',
    'worktree=/repo/worktrees/feature-440'
  );
  const planDone2 = m(
    'phase=plan status=done run=r-440-ab56 at=2026-08-24T10:02:00Z',
    'planning=/repo/worktrees/feature-440/PLANNING-440.md',
    'head=abc1234'
  );
  const implementDone2 = m(
    'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
    'head=abc1234'
  );
  const reviewDone2 = m(
    'phase=review status=done run=r-440-ab56 at=2026-08-24T10:04:00Z',
    'head=abc1234'
  );

  const mergedPr = () => ({
    state: 'MERGED',
    mergedAt: '2026-08-24T10:05:30Z',
    mergeable: 'MERGEABLE',
  });
  const openMergeablePr = () => ({ state: 'OPEN', mergedAt: null, mergeable: 'MERGEABLE' });

  it.each([
    ['gate done → setup', [gateDone2], 'setup'],
    ['setup done (claims verify) → plan', [gateDone2, setupDone2], 'plan'],
    [
      'plan done (head verifies on origin) → implement',
      [gateDone2, setupDone2, planDone2],
      'implement',
    ],
    [
      'implement done (head verifies on origin) → review',
      [gateDone2, setupDone2, planDone2, implementDone2],
      'review',
    ],
    ['review done → ship', [gateDone2, setupDone2, planDone2, implementDone2, reviewDone2], 'ship'],
    [
      'ship awaiting-merge (merged) → ship-teardown',
      [gateDone2, setupDone2, planDone2, implementDone2, reviewDone2, shipAwaiting],
      'ship-teardown',
    ],
    [
      'ship done → report',
      [gateDone2, setupDone2, planDone2, implementDone2, reviewDone2, shipDone],
      'report',
    ],
    [
      'report done (issue closed) → done',
      [gateDone2, setupDone2, planDone2, implementDone2, reviewDone2, shipDone, reportDone],
      'done',
    ],
  ])('%s', (_name, trail, expected) => {
    const p = probe({
      prState: (pr) => (pr === '1' ? mergedPr() : openMergeablePr()),
      issueClosed: () => true,
    });
    expect(computeResume(trail as (typeof gateDone2)[], p).resume_from).toBe(expected);
  });

  it('keeps awaiting-merge routing for an open mergeable PR', () => {
    const trail = [gateDone2, setupDone2, planDone2, implementDone2, reviewDone2, shipAwaiting];
    expect(computeResume(trail, probe({ prState: () => openMergeablePr() })).resume_from).toBe(
      'ship-wait'
    );
  });
});

describe('computeResume — classify, batch, and slot-mode trails (#461)', () => {
  const classifyFull = m(
    'phase=classify status=done run=r-440-ab56 at=2026-08-24T09:00:00Z',
    'mode=full',
    'risk=low',
    'est_files=2',
    'est_diff=80',
    'areas=cli',
    'test_scope=focused',
    'deps=none',
    'confidence=0.9'
  );
  const classifySlot = m(
    'phase=classify status=done run=r-440-ab56 at=2026-08-24T09:00:00Z',
    'mode=slot',
    'risk=low',
    'est_files=2',
    'est_diff=80',
    'areas=cli',
    'test_scope=focused',
    'deps=none',
    'confidence=0.9'
  );
  const implementSlot = m(
    'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
    'head=abc1234',
    'mode=slot',
    'batch=b-2026-08-29-01'
  );
  const reviewSlotBatchKeyOnly = m(
    'phase=review status=done run=r-440-ab56 at=2026-08-24T10:04:00Z',
    'batch=b-2026-08-29-01'
  );
  const batchShipAwaiting = m(
    'phase=batch-ship status=awaiting-merge run=r-480-cd12 at=2026-08-24T10:05:00Z',
    'batch=b-2026-08-29-01'
  );

  it('treats a classify-full trail as a fresh entry with a note', () => {
    const result = computeResume([classifyFull], probe());
    expect(result.resume_from).toBe('none');
    expect(result.slot_trail).toBeUndefined();
    expect(result.note).toContain('classify');
  });

  it('flags a classify-slot trail with the slot signal', () => {
    const result = computeResume([classifySlot], probe());
    expect(result.resume_from).toBe('none');
    expect(result.slot_trail).toBe(true);
  });

  it('re-enters a slot-mode member fresh (mode=slot), with the distinguishable signal', () => {
    const result = computeResume([classifySlot, implementSlot], probe());
    expect(result.resume_from).toBe('none');
    expect(result.slot_trail).toBe(true);
    expect(result.note).toContain('slot-mode');
  });

  it('re-enters fresh on a batch= key alone, without mode=', () => {
    const result = computeResume([reviewSlotBatchKeyOnly], probe());
    expect(result.resume_from).toBe('none');
    expect(result.slot_trail).toBe(true);
  });

  it('treats a batch anchor trail as not-a-full-cycle-run, without the slot signal', () => {
    const result = computeResume([batchShipAwaiting], probe());
    expect(result.resume_from).toBe('none');
    expect(result.slot_trail).toBeUndefined();
    expect(result.note).toContain('batch anchor');
  });

  it('still resumes normally when slot milestones are history, not the last milestone', () => {
    const gateAfterEviction = m(
      'phase=gate status=done run=r-440-99aa at=2026-08-24T11:00:00Z',
      'base_branch=main'
    );
    const result = computeResume([implementSlot, gateAfterEviction], probe());
    expect(result.resume_from).toBe('setup');
    expect(result.slot_trail).toBeUndefined();
  });

  it('keeps the resume loop cap ahead of the slot/classify checks', () => {
    const blocked1 = m(
      'phase=classify status=blocked run=r-440-ab56 at=2026-08-24T09:00:00Z',
      'reason=escalation-cap'
    );
    const blocked2 = m(
      'phase=classify status=blocked run=r-440-ab56 at=2026-08-24T09:05:00Z',
      'reason=escalation-cap'
    );
    const blocked3 = m(
      'phase=classify status=blocked run=r-440-ab56 at=2026-08-24T09:10:00Z',
      'reason=escalation-cap'
    );
    const result = computeResume([blocked1, blocked2, blocked3], probe());
    expect(result.hard_block).toBe('resume-loop');
  });

  it('explains a fresh entry from an unknown phase rather than returning silently', () => {
    const triage = m('phase=triage status=done run=r-440-ab56 at=2026-08-24T09:00:00Z');
    const result = computeResume([triage], probe());
    expect(result.resume_from).toBe('none');
    expect(result.note).toContain("unknown phase 'triage'");
  });

  it('enters fresh (with the note) rather than resuming at a blocked milestone of an unknown phase', () => {
    const blockedTriage = m(
      'phase=triage status=blocked run=r-440-ab56 at=2026-08-24T09:00:00Z',
      'reason=x'
    );
    const result = computeResume([blockedTriage], probe());
    expect(result.resume_from).toBe('none');
    expect(result.note).toContain("unknown phase 'triage'");
  });
});

describe('run fencing — the protocol half (#504)', () => {
  const RUN = 'r-504-fc02';
  const OTHER_RUN = 'r-504-9999';

  const gateDone = m(
    `phase=gate status=done run=${RUN} at=2026-08-30T10:00:00Z`,
    'base_branch=main'
  );
  const implementFence = m(
    `phase=implement status=${FENCE_STATUS} run=${RUN} at=2026-08-30T11:00:00Z`,
    'gen=1',
    'takeover=slot-2-r1'
  );
  const secondFence = m(
    `phase=implement status=${FENCE_STATUS} run=${RUN} at=2026-08-30T12:00:00Z`,
    'gen=2',
    'takeover=slot-2-r2'
  );

  describe('generation arithmetic', () => {
    it('reads a run that was never fenced as the default generation', () => {
      expect(fenceGeneration([gateDone], RUN)).toBe(DEFAULT_GENERATION);
      expect(latestFence([gateDone], RUN)).toBeNull();
      expect(nextFenceGeneration([gateDone], RUN)).toBe(1);
    });

    it('reads the installed generation off a fence', () => {
      expect(fenceGeneration([gateDone, implementFence], RUN)).toBe(1);
      expect(nextFenceGeneration([gateDone, implementFence], RUN)).toBe(2);
    });

    it('takes the HIGHEST generation, not the last one posted', () => {
      // The zombie's own late post lands after the fence that superseded it; ordering by
      // position would read the older fence back and un-fence the trail.
      const zombieLatePost = m(
        `phase=implement status=done run=${RUN} at=2026-08-30T12:30:00Z`,
        'head=abc1234',
        'files=3',
        'tests_added=1',
        'tests_run=4',
        'ci_parity=pass'
      );
      const trail = [gateDone, implementFence, secondFence, zombieLatePost];
      expect(fenceGeneration(trail, RUN)).toBe(2);
      expect(latestFence(trail, RUN)?.keys.takeover).toBe('slot-2-r2');
    });

    it('ignores fences belonging to a different run', () => {
      const otherFence = m(
        `phase=plan status=${FENCE_STATUS} run=${OTHER_RUN} at=2026-08-30T11:30:00Z`,
        'gen=5',
        'takeover=elsewhere'
      );
      expect(fenceGeneration([gateDone, otherFence], RUN)).toBe(DEFAULT_GENERATION);
    });

    it('never matches an empty run id against a milestone missing its run', () => {
      const runless = m(`phase=plan status=${FENCE_STATUS} at=2026-08-30T11:00:00Z`, 'gen=1');
      expect(latestFence([runless], '')).toBeNull();
      expect(fenceGeneration([runless], '')).toBe(DEFAULT_GENERATION);
    });

    it('reports null — never generation 0 — for an absent or unreadable gen=', () => {
      // Reading a malformed fence as "generation 0" would silently downgrade it to
      // "never fenced", the one answer that must never be inferred from bad data.
      expect(generationOf(gateDone)).toBeNull();
      expect(
        generationOf(m(`phase=plan status=${FENCE_STATUS} run=${RUN} at=x`, 'gen=not-a-number'))
      ).toBeNull();
      expect(
        generationOf(m(`phase=plan status=${FENCE_STATUS} run=${RUN} at=x`, 'gen=99999'))
      ).toBeNull();
    });

    it('skips a malformed fence rather than counting it as generation 0', () => {
      const forged = m(
        `phase=implement status=${FENCE_STATUS} run=${RUN} at=2026-08-30T13:00:00Z`,
        'gen=9007199254740991',
        'takeover=forged'
      );
      // The forged fence is posted AFTER the real one and claims a higher number; if it
      // were honoured, the next generation would be unrepresentable and fencing would be
      // permanently disabled on this issue.
      const trail = [gateDone, implementFence, forged];
      expect(fenceGeneration(trail, RUN)).toBe(1);
      expect(latestFence(trail, RUN)?.keys.takeover).toBe('slot-2-r1');
    });

    it('refuses to mint a generation past the ceiling', () => {
      const atCeiling = m(
        `phase=implement status=${FENCE_STATUS} run=${RUN} at=2026-08-30T13:00:00Z`,
        `gen=${MAX_GENERATION}`,
        'takeover=deep'
      );
      expect(nextFenceGeneration([atCeiling], RUN)).toBeNull();
    });

    it('parses only non-negative integers as generations', () => {
      expect(parseGeneration('0')).toBe(0);
      expect(parseGeneration('7')).toBe(7);
      expect(parseGeneration('-1')).toBeNull();
      expect(parseGeneration('1.5')).toBeNull();
      expect(parseGeneration('')).toBeNull();
    });
  });

  describe('isFenced', () => {
    const trail = [gateDone, implementFence];

    it('fences every generation BELOW the installed one', () => {
      expect(isFenced(trail, RUN, 0)).toBe(true);
    });

    it('leaves the takeover itself live at exactly the fenced generation', () => {
      // `>` not `>=`: the takeover posts at the generation its own fence installed.
      expect(isFenced(trail, RUN, 1)).toBe(false);
    });

    it('leaves a run that was never fenced live', () => {
      expect(isFenced([gateDone], RUN, 0)).toBe(false);
    });

    it('fences generation 1 once a recovery-of-recovery installs generation 2', () => {
      const twice = [gateDone, implementFence, secondFence];
      expect(isFenced(twice, RUN, 1)).toBe(true);
      expect(isFenced(twice, RUN, 2)).toBe(false);
    });
  });

  describe('validateMilestone and the phase tables', () => {
    it.each([...PHASES, 'classify', ...BATCH_PHASES])('accepts a fence on phase %s', (phase) => {
      expect(statusAllowed(phase as never, FENCE_STATUS)).toBe(true);
      expect(
        validateMilestone({
          phase,
          status: FENCE_STATUS,
          run: RUN,
          keys: [
            ['gen', '1'],
            ['takeover', 'slot-2-r1'],
          ],
        })
      ).toEqual([]);
    });

    it('requires gen and takeover on a fence, not the phase’s ordinary keys', () => {
      expect(requiredKeys('implement', FENCE_STATUS)).toEqual(['gen', 'takeover']);
      const errors = validateMilestone({
        phase: 'implement',
        status: FENCE_STATUS,
        run: RUN,
        keys: [],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('requires gen= takeover=');
    });

    it('rejects a non-integer generation with the grammar message', () => {
      const errors = validateMilestone({
        phase: 'implement',
        status: FENCE_STATUS,
        run: RUN,
        keys: [
          ['gen', 'two'],
          ['takeover', 'slot-2-r1'],
        ],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('non-negative integer run generation');
    });

    it('rejects a takeover label that could be read as a flag', () => {
      const errors = validateMilestone({
        phase: 'implement',
        status: FENCE_STATUS,
        run: RUN,
        keys: [
          ['gen', '1'],
          ['takeover', '--repo=someone/else'],
        ],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('single token naming what took the run over');
    });

    it('hands the same phase to the takeover via next=', () => {
      expect(defaultNext('implement', FENCE_STATUS)).toBe('implement');
      expect(defaultNext('ship', FENCE_STATUS)).toBe('ship');
      // classify is not a `next=` value — nothing ever transitions INTO it.
      expect(defaultNext('classify', FENCE_STATUS)).toBe('done');
      expect(NEXT_VALUES).toContain(defaultNext('implement', FENCE_STATUS));
    });
  });

  describe('computeResume', () => {
    it('resumes a fence-terminated trail at the fenced phase, as the new generation', () => {
      const result = computeResume([gateDone, implementFence], probe());
      // AC4: the takeover may itself have died before posting anything, so a fence is a
      // resumable state — the work is re-entered at the phase it was taken over in.
      expect(result.resume_from).toBe('implement');
      expect(result.generation).toBe(1);
      expect(result.run_id).toBe(RUN);
      expect(result.note).toContain('slot-2-r1');
    });

    it('reports the owning generation even when the last milestone is ordinary work', () => {
      const takeoverProgress = m(
        `phase=implement status=done run=${RUN} at=2026-08-30T11:30:00Z`,
        'head=abc1234',
        'files=3',
        'tests_added=1',
        'tests_run=4',
        'ci_parity=pass',
        'gen=1'
      );
      const setupDone = m(
        `phase=setup status=done run=${RUN} at=2026-08-30T10:01:00Z`,
        'branch=feature/504',
        'worktree=/repo/worktrees/feature-504'
      );
      const result = computeResume(
        [gateDone, setupDone, implementFence, takeoverProgress],
        probe()
      );
      expect(result.resume_from).toBe('review');
      expect(result.generation).toBe(1);
    });

    it('reports generation 0 for a trail that was never fenced', () => {
      expect(computeResume([gateDone], probe()).generation).toBe(DEFAULT_GENERATION);
      expect(computeResume([], probe()).generation).toBe(DEFAULT_GENERATION);
    });
  });
});
