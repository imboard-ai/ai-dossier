import { describe, expect, it } from 'vitest';
import type { PolicyAssessment } from '../classify';
import {
  applyOperatorPolicy,
  assessmentInputDigest,
  type OperatorPolicy,
  parseOperatorPolicy,
  validateOperatorPolicy,
} from '../operator';

const DIGEST = 'a'.repeat(64);
const base = (over: Partial<PolicyAssessment> = {}): PolicyAssessment => ({
  ai: 'unclear',
  assignment: 'unclear',
  directPr: 'unclear',
  draftRequired: false,
  receiptBlockAllowed: false,
  baselineFailuresPermitted: false,
  citations: [],
  ...over,
});
const policy = (decisions: OperatorPolicy['decisions']): OperatorPolicy => ({
  decisions,
  note: 'CONTRIBUTING.md:58 invites coding agents',
  operator: 'yuvaldim',
  inputDigest: DIGEST,
});

describe('parseOperatorPolicy', () => {
  it('reads a closed dimension=value list', () => {
    expect(parseOperatorPolicy('ai=welcomed,directPr=welcomed')).toEqual({
      ai: 'welcomed',
      directPr: 'welcomed',
    });
  });
  it.each([
    'ai=banned',
    'ai=unclear',
    'draftRequired=true',
    'ai=welcomed,ai=welcomed',
    'ai',
    'ai=welcomed=1',
    '',
    'assignment=welcomed',
  ])('refuses %j', (spec) => {
    expect(() => parseOperatorPolicy(spec)).toThrow('invalid_policy_decision');
  });
});

describe('validateOperatorPolicy', () => {
  it('accepts a complete record', () => {
    expect(validateOperatorPolicy(policy({ assignment: 'not_required' }))).toEqual(
      policy({ assignment: 'not_required' })
    );
  });
  it.each([
    ['empty decisions', { ...policy({}) }],
    ['blank note', { ...policy({ ai: 'welcomed' }), note: '  ' }],
    ['padded note', { ...policy({ ai: 'welcomed' }), note: ' why' }],
    ['long note', { ...policy({ ai: 'welcomed' }), note: 'x'.repeat(1001) }],
    ['bad digest', { ...policy({ ai: 'welcomed' }), inputDigest: 'nope' }],
    ['bad login', { ...policy({ ai: 'welcomed' }), operator: '-bad' }],
    ['extra key', { ...policy({ ai: 'welcomed' }), applied: [] }],
    ['non-string value', { ...policy({}), decisions: { ai: true } }],
  ])('refuses %s', (_name, value) => {
    expect(() => validateOperatorPolicy(value)).toThrow();
  });
});

describe('applyOperatorPolicy', () => {
  it('replaces only unclear dimensions', () => {
    const result = applyOperatorPolicy(
      base({ assignment: 'required' }),
      policy({ ai: 'welcomed', assignment: 'not_required', directPr: 'welcomed' })
    );
    expect(result.applied).toEqual(['ai', 'directPr']);
    expect(result.assessment).toMatchObject({
      ai: 'welcomed',
      assignment: 'required',
      directPr: 'welcomed',
    });
  });
  it('never touches a banned assessment', () => {
    const banned = base({ ai: 'banned' });
    expect(applyOperatorPolicy(banned, policy({ directPr: 'welcomed' }))).toEqual({
      assessment: banned,
      applied: [],
    });
  });
  it('leaves silent AI alone', () => {
    expect(applyOperatorPolicy(base({ ai: 'silent' }), policy({ ai: 'welcomed' })).applied).toEqual(
      []
    );
  });
});

describe('assessmentInputDigest', () => {
  const decision = (inputDigest: string) =>
    ({ inputDigest }) as NonNullable<PolicyAssessment['decisions']>['ai'];
  it('returns the shared digest', () => {
    expect(
      assessmentInputDigest(
        base({ decisions: { ai: decision(DIGEST), directPr: decision(DIGEST) } })
      )
    ).toBe(DIGEST);
  });
  it('is undefined without decisions or with mixed inputs', () => {
    expect(assessmentInputDigest(base())).toBeUndefined();
    expect(
      assessmentInputDigest(
        base({ decisions: { ai: decision(DIGEST), directPr: decision('b'.repeat(64)) } })
      )
    ).toBeUndefined();
  });
});
