import { describe, expect, it } from 'vitest';
import {
  ATTACK_CATEGORIES,
  assertBoundaryHeld,
  BoundaryBreachError,
  type BoundaryInput,
  canaryForms,
  evaluateBoundary,
  isCleanHeldVerdict,
  type ProbeReport,
  parseReport,
  parseReports,
  REPORT_MARKER,
} from '../vm/evidence';

const CANARY = 'zt-canary-7f3a91c2d4e5b6a8';

function deniedReport(categories: readonly string[] = ATTACK_CATEGORIES): ProbeReport {
  return {
    probe: 'probe-1',
    phase: 'container',
    records: categories.map((category) => ({
      category,
      attempt: `try-${category}`,
      outcome: 'denied',
    })),
  };
}

function cleanInput(overrides: Partial<BoundaryInput> = {}): BoundaryInput {
  return {
    reports: [deniedReport(ATTACK_CATEGORIES.filter((c) => c !== 'broker-abuse'))],
    guestOutputs: ['build ok', 'tests passed'],
    canaries: [CANARY],
    listenerConnections: 0,
    brokerChecks: [{ attempt: 'path-traversal', rejected: true }],
    malformedReports: 0,
    ...overrides,
  };
}

describe('parseReports — untrusted marker lines', () => {
  it('extracts marker lines, including after prefix text', () => {
    const report = deniedReport(['dns']);
    const output = [
      'noise before',
      `${REPORT_MARKER}${JSON.stringify(report)}`,
      `[  12.345] guest: ${REPORT_MARKER}${JSON.stringify({ ...report, phase: 'vm-root' })}`,
      'trailing noise',
    ].join('\n');
    const { reports, malformed } = parseReports(output);
    expect(malformed).toBe(0);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual(report);
    expect(reports[1].phase).toBe('vm-root');
  });

  it('returns nothing for output without markers', () => {
    expect(parseReports('')).toEqual({ reports: [], malformed: 0 });
    expect(parseReports('ZT-PROBE-REPORT{}')).toEqual({ reports: [], malformed: 0 });
  });

  it('counts malformed JSON and schema-invalid records as malformed', () => {
    const lines = [
      `${REPORT_MARKER}{not json`,
      `${REPORT_MARKER}null`,
      `${REPORT_MARKER}"string"`,
      `${REPORT_MARKER}${JSON.stringify({ phase: 'p', records: [] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', records: [] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: {} })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: [null] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: ['r'] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: [{ attempt: 'a', outcome: 'denied' }] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: [{ category: 'dns', outcome: 'denied' }] })}`,
      `${REPORT_MARKER}${JSON.stringify({ probe: 'p', phase: 'x', records: [{ category: 'dns', attempt: 'a', outcome: 1 }] })}`,
      `${REPORT_MARKER}${JSON.stringify(deniedReport(['lan']))}`,
    ];
    const { reports, malformed } = parseReports(lines.join('\n'));
    expect(malformed).toBe(11);
    expect(reports).toHaveLength(1);
  });

  it('parseReport accepts an empty records list and rejects non-objects', () => {
    expect(parseReport({ probe: 'p', phase: 'x', records: [] }).records).toEqual([]);
    expect(() => parseReport(undefined)).toThrow('Malformed probe report');
    expect(() => parseReport(42)).toThrow('Malformed probe report');
  });

  it('parseReport accepts every attack category and the witness category', () => {
    const report = deniedReport([...ATTACK_CATEGORIES, 'witness']);
    expect(parseReport(report).records).toHaveLength(ATTACK_CATEGORIES.length + 1);
    expect(
      parseReport({
        probe: 'probe 1.2:x/y=z_-',
        phase: 'vm-root',
        records: [{ category: 'witness', attempt: 'a'.repeat(200), outcome: 'not_run-x' }],
      }).records
    ).toHaveLength(1);
  });

  const record = { category: ATTACK_CATEGORIES[0], attempt: 'try', outcome: 'denied' };
  it.each<[string, unknown]>([
    ['unknown category', { probe: 'p', phase: 'x', records: [{ ...record, category: 'other' }] }],
    ['non-string category', { probe: 'p', phase: 'x', records: [{ ...record, category: 1 }] }],
    ['empty probe', { probe: '', phase: 'x', records: [] }],
    ['probe with a newline', { probe: 'p\nq', phase: 'x', records: [] }],
    ['probe over 200 chars', { probe: 'p'.repeat(201), phase: 'x', records: [] }],
    ['phase with markup', { probe: 'p', phase: '<b>x</b>', records: [] }],
    ['phase not a string', { probe: 'p', phase: 3, records: [] }],
    [
      'attempt with a backtick',
      { probe: 'p', phase: 'x', records: [{ ...record, attempt: '`x`' }] },
    ],
    ['empty attempt', { probe: 'p', phase: 'x', records: [{ ...record, attempt: '' }] }],
    ['uppercase outcome', { probe: 'p', phase: 'x', records: [{ ...record, outcome: 'DENIED' }] }],
    ['empty outcome', { probe: 'p', phase: 'x', records: [{ ...record, outcome: '' }] }],
    ['long outcome', { probe: 'p', phase: 'x', records: [{ ...record, outcome: 'a'.repeat(33) }] }],
    [
      'outcome with a space',
      { probe: 'p', phase: 'x', records: [{ ...record, outcome: 'de nied' }] },
    ],
    ['non-string outcome', { probe: 'p', phase: 'x', records: [{ ...record, outcome: 0 }] }],
    ['null record', { probe: 'p', phase: 'x', records: [null] }],
  ])('parseReport rejects %s', (_label, value) => {
    expect(() => parseReport(value)).toThrow('Malformed probe report');
  });
});

describe('evaluateBoundary', () => {
  it('holds when every attempt is denied, coverage is full and outputs are clean', () => {
    const evidence = evaluateBoundary(cleanInput());
    expect(evidence.violations).toEqual([]);
    expect(evidence.held).toBe(true);
    expect(evidence.attempts).toBe(ATTACK_CATEGORIES.length);
    for (const category of ATTACK_CATEGORIES) expect(evidence.coverage[category]).toBe(1);
  });

  it.each(['allowed', 'observed', 'error', '', 'DENIED'])('fails on outcome %j', (outcome) => {
    const report = deniedReport();
    const records = report.records.map((r, i) => (i === 0 ? { ...r, outcome } : r));
    const evidence = evaluateBoundary(cleanInput({ reports: [{ ...report, records }] }));
    expect(evidence.held).toBe(false);
    expect(evidence.violations).toContain(`probe-1/container: host-env try-host-env -> ${outcome}`);
  });

  it('accepts observed only for the witness category', () => {
    const witness: ProbeReport = {
      probe: 'w',
      phase: 'container',
      records: [{ category: 'witness', attempt: 'sees-self', outcome: 'observed' }],
    };
    expect(evaluateBoundary(cleanInput({ reports: [deniedReport(), witness] })).held).toBe(true);
    const witnessAllowed: ProbeReport = {
      ...witness,
      records: [{ category: 'witness', attempt: 'sees-self', outcome: 'allowed' }],
    };
    expect(evaluateBoundary(cleanInput({ reports: [deniedReport(), witnessAllowed] })).held).toBe(
      false
    );
    const nonWitness: ProbeReport = {
      ...witness,
      records: [{ category: 'dns', attempt: 'resolve', outcome: 'observed' }],
    };
    expect(evaluateBoundary(cleanInput({ reports: [deniedReport(), nonWitness] })).held).toBe(
      false
    );
  });

  it('fails on missing category coverage', () => {
    const evidence = evaluateBoundary(
      cleanInput({ reports: [deniedReport(['host-env', 'host-file'])] })
    );
    expect(evidence.held).toBe(false);
    expect(evidence.violations).toContain('missing coverage: metadata');
    expect(evidence.violations).toContain('missing coverage: container-escape');
    expect(evidence.violations).not.toContain('missing coverage: host-env');
  });

  it('broker-abuse coverage can only come from host checks or reports', () => {
    const evidence = evaluateBoundary(cleanInput({ brokerChecks: [] }));
    expect(evidence.violations).toEqual(['missing coverage: broker-abuse']);
  });

  it('an accepted broker check is a violation', () => {
    const evidence = evaluateBoundary(
      cleanInput({
        brokerChecks: [
          { attempt: 'path-traversal', rejected: true },
          { attempt: 'oversized-frame', rejected: false },
        ],
      })
    );
    expect(evidence.held).toBe(false);
    expect(evidence.violations).toEqual(['host: broker-abuse oversized-frame -> accepted']);
    expect(evidence.coverage['broker-abuse']).toBe(2);
  });

  it.each([
    1,
    3,
    -1,
    Number.NaN,
    0.5,
    Number.POSITIVE_INFINITY,
  ])('malformedReports %s fails', (n) => {
    const evidence = evaluateBoundary(cleanInput({ malformedReports: n }));
    expect(evidence.held).toBe(false);
    expect(evidence.violations[0]).toBe(`malformed probe reports: ${n}`);
  });

  it('fails on a short canary', () => {
    const evidence = evaluateBoundary(cleanInput({ canaries: ['short-canary'] }));
    expect(evidence.held).toBe(false);
    expect(evidence.violations).toContain('canary too short to be meaningful');
    expect(evaluateBoundary(cleanInput({ canaries: ['x'.repeat(16)] })).held).toBe(true);
  });

  it('holds with no canaries configured', () => {
    expect(evaluateBoundary(cleanInput({ canaries: [] })).held).toBe(true);
  });

  describe('canary leaks', () => {
    const leaked = (out: string) =>
      evaluateBoundary(cleanInput({ guestOutputs: ['clean', `xx${out}yy`] }));

    it('detects a raw leak', () => {
      const evidence = leaked(CANARY);
      expect(evidence.held).toBe(false);
      expect(evidence.violations).toEqual(['canary value leaked into guest output']);
    });

    it('detects a hex leak (lower and upper case)', () => {
      const hex = Buffer.from(CANARY).toString('hex');
      expect(leaked(hex).held).toBe(false);
      expect(leaked(hex.toUpperCase()).held).toBe(false);
    });

    it.each([0, 1, 2, 3, 4])('detects base64 at prefix length %i inside a longer blob', (n) => {
      const blob = Buffer.concat([
        Buffer.from('P'.repeat(n)),
        Buffer.from(CANARY),
        Buffer.from('-suffix-bytes'),
      ]).toString('base64');
      expect(blob).not.toContain(CANARY);
      const evidence = leaked(blob);
      expect(evidence.held).toBe(false);
      expect(evidence.violations).toContain('canary value leaked into guest output');
    });

    it('detects base64 of the canary alone, with padding', () => {
      expect(leaked(Buffer.from(CANARY).toString('base64')).held).toBe(false);
    });

    it('detects a leak of any one of several canaries', () => {
      const second = 'second-canary-0123456789abcdef';
      const evidence = evaluateBoundary(
        cleanInput({ canaries: [CANARY, second], guestOutputs: [`env: ${second}`] })
      );
      expect(evidence.violations).toEqual(['canary value leaked into guest output']);
    });
  });

  it.each([1, 2])('fails when host listeners accepted %i connection(s)', (n) => {
    const evidence = evaluateBoundary(cleanInput({ listenerConnections: n }));
    expect(evidence.held).toBe(false);
    expect(evidence.violations).toEqual([`host listeners accepted ${n} connection(s)`]);
  });

  it('requiredCategories overrides the default category set', () => {
    const input = cleanInput({
      reports: [deniedReport(['dns'])],
      brokerChecks: [],
      requiredCategories: ['dns'],
    });
    expect(evaluateBoundary(input).held).toBe(true);
    expect(
      evaluateBoundary({ ...input, requiredCategories: ['dns', 'custom'] }).violations
    ).toEqual(['missing coverage: custom']);
  });

  it('accumulates coverage across multiple reports', () => {
    const evidence = evaluateBoundary(
      cleanInput({ reports: [deniedReport(), deniedReport(['dns'])] })
    );
    expect(evidence.coverage.dns).toBe(2);
    expect(evidence.attempts).toBe(ATTACK_CATEGORIES.length + 1 + 1);
  });
});

describe('assertBoundaryHeld', () => {
  it('passes a held boundary', () => {
    expect(() => assertBoundaryHeld(evaluateBoundary(cleanInput()))).not.toThrow();
  });

  it('throws BoundaryBreachError carrying the violations', () => {
    const evidence = evaluateBoundary(cleanInput({ listenerConnections: 1 }));
    try {
      assertBoundaryHeld(evidence);
      throw new Error('expected breach');
    } catch (error) {
      expect(error).toBeInstanceOf(BoundaryBreachError);
      const breach = error as BoundaryBreachError;
      expect(breach.violations).toEqual(evidence.violations);
      expect(breach.name).toBe('BoundaryBreachError');
      expect(breach.message).toContain('no shipping authorization');
    }
  });
});

describe('canaryForms', () => {
  it('contains raw, lower hex, upper hex and three base64 alignments', () => {
    const forms = canaryForms(CANARY);
    const hex = Buffer.from(CANARY).toString('hex');
    expect(forms).toContain(CANARY);
    expect(forms).toContain(hex);
    expect(forms).toContain(hex.toUpperCase());
    expect(forms).toHaveLength(6);
    const plain = Buffer.from(CANARY).toString('base64');
    // Alignment 0 fragment is a prefix of the plain encoding without the last partial char.
    expect(plain.startsWith(forms[3])).toBe(true);
    for (const form of forms.slice(3)) expect(form.length).toBeGreaterThan(CANARY.length);
  });

  it('dedupes forms that coincide', () => {
    // Digits-only canaries share no form; just confirm the Set removes nothing it should keep.
    const forms = canaryForms('1234567890123456');
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('handles multi-byte canaries by bytes', () => {
    const canary = 'ünïcödé-canary-värde';
    const forms = canaryForms(canary);
    expect(forms).toContain(Buffer.from(canary, 'utf8').toString('hex'));
  });
});

describe('isCleanHeldVerdict / assertBoundaryHeld (#1076)', () => {
  const clean = { held: true, violations: [], coverage: {}, attempts: 1, runId: 'run-1' };
  it('accepts only a held verdict with no violations and at least one attempt', () => {
    expect(isCleanHeldVerdict(clean)).toBe(true);
    for (const bad of [
      null,
      'held',
      { ...clean, held: false },
      { ...clean, violations: ['x'] },
      { ...clean, violations: 'none' },
      { ...clean, attempts: 0 },
      { ...clean, attempts: 1.5 },
    ])
      expect(isCleanHeldVerdict(bad)).toBe(false);
  });

  it('assertBoundaryHeld refuses a hand-made held flag that carries violations or no attempts', () => {
    expect(() => assertBoundaryHeld({ ...clean, violations: ['x'] })).toThrow(BoundaryBreachError);
    try {
      assertBoundaryHeld({ ...clean, attempts: 0 });
    } catch (error) {
      expect((error as BoundaryBreachError).violations).toEqual([
        'boundary verdict is not a clean held verdict',
      ]);
    }
    expect(() => assertBoundaryHeld({ ...clean, attempts: 0 })).toThrow(BoundaryBreachError);
    expect(() => assertBoundaryHeld(clean)).not.toThrow();
  });

  it('carries the run it was gathered for', () => {
    const input = {
      reports: [],
      guestOutputs: [],
      canaries: [],
      listenerConnections: 0,
      brokerChecks: [{ attempt: 'x', rejected: true }],
      malformedReports: 0,
      requiredCategories: ['broker-abuse'],
    };
    expect(evaluateBoundary({ ...input, runId: 'run-7' }).runId).toBe('run-7');
    expect(evaluateBoundary(input).runId).toBeNull();
  });
});
