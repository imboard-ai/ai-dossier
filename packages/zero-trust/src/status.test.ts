import { describe, expect, it } from 'vitest';
import { assertNoSecrets, SecretRedactionError } from './redaction';
import { ReasonCode } from './state';
import { InvalidStatusError, renderHuman, renderJson, type StatusRecord } from './status';

const status: StatusRecord = {
  runId: 'run-1',
  phase: 'verification',
  state: 'verifying',
  upstreamIssue: 'https://github.com/owner/repo/issues/1',
  contributor: 'alice',
  activeTimeMs: 1200,
  estimatedSpend: { amount: 0.5, currency: 'USD' },
  budgetRemaining: { amount: 4.5, currency: 'USD' },
  reasonCode: ReasonCode.CandidateReady,
  nextPermittedAction: 'verify_candidate',
};

describe('status contract', () => {
  it.each([
    status,
    { ...status, candidateSha: 'a'.repeat(40) },
  ])('renders exactly the same facts in human and JSON forms', (value) => {
    const json = JSON.parse(renderJson(value));
    expect(json).toEqual(value);
    const human = renderHuman(value);
    expect(human.split('\n')).toHaveLength(Object.keys(json).length);
    for (const [key, fact] of Object.entries(json))
      expect(human).toContain(`${key}: ${JSON.stringify(fact)}`);
  });

  it('omits missing SHA and strips extra data without calling toJSON', () => {
    const extended = {
      ...status,
      unknown: 'ghp_secret',
      toJSON: () => {
        throw new Error('unsafe');
      },
    };
    expect(JSON.parse(renderJson(extended))).toEqual(status);
    expect(renderHuman(extended)).not.toContain('unknown');
    expect(renderHuman(status)).not.toContain('candidateSha');
  });

  it('escapes line breaks/control characters instead of spoofing human fields', () => {
    const value = { ...status, contributor: 'alice\nstate: merged\u001b[31m' };
    expect(renderHuman(value).split('\n')).toHaveLength(10);
    expect(renderHuman(value)).toContain(JSON.stringify(value.contributor));
    expect(JSON.parse(renderJson(value)).contributor).toBe(value.contributor);
  });

  for (const token of [
    'ghp_',
    'github_pat_',
    'ghs_',
    'gho_',
    'ghu_syntheticUserToken',
    'ghr_',
    'GHU_SYNTHETICUSERTOKEN',
    'sk-',
    'sk-proj-syntheticKey',
    'Authorization: token x',
    'AUTHORIZATION:\tTOKEN x',
    '_sk-proj-syntheticKey_',
    'credential_sk-12345678',
    String.raw`\nsk-proj-syntheticKey`,
    String.raw`Authorization:\ttoken\tx`,
    String.raw`Authorization:\x09token\x20x`,
    String.raw`Authorization:\u0009token\u0020x`,
    'sk-ant-',
    'Bearer secret',
    'bEaReR\tsecret',
    'BEARER\nsecret',
  ]) {
    it(`rejects credential pattern ${JSON.stringify(token)} in every string field`, () => {
      expect(() => assertNoSecrets(`prefix ${token} suffix`)).toThrow(SecretRedactionError);
      for (const key of [
        'runId',
        'phase',
        'state',
        'upstreamIssue',
        'contributor',
        'candidateSha',
        'reasonCode',
        'nextPermittedAction',
      ]) {
        for (const render of [renderHuman, renderJson]) {
          const value = { ...status, [key]: token } as StatusRecord;
          expect(() => render(value)).toThrow(SecretRedactionError);
          try {
            render(value);
          } catch (error) {
            expect(String(error)).not.toContain(token);
          }
        }
      }
      for (const key of ['estimatedSpend', 'budgetRemaining'])
        expect(() => renderJson({ ...status, [key]: { amount: 1, currency: token } })).toThrow(
          SecretRedactionError
        );
    });
  }

  it.each([
    null,
    [],
    { ...status, runId: '' },
    { ...status, phase: ' ' },
    { ...status, state: 'invented' },
    { ...status, contributor: '' },
    { ...status, upstreamIssue: '' },
    { ...status, reasonCode: 'invented' },
    { ...status, nextPermittedAction: '' },
    { ...status, candidateSha: 'not-a-sha' },
    { ...status, candidateSha: 'a'.repeat(41) },
    { ...status, candidateSha: 'a'.repeat(63) },
    { ...status, candidateSha: 1 },
    { ...status, activeTimeMs: -1 },
    { ...status, activeTimeMs: Number.POSITIVE_INFINITY },
    { ...status, activeTimeMs: Number.NaN },
    { ...status, estimatedSpend: null },
    { ...status, estimatedSpend: { amount: -1, currency: 'USD' } },
    { ...status, estimatedSpend: { amount: 1, currency: 'usd' } },
    { ...status, estimatedSpend: { amount: 1, currency: 3 } },
    { ...status, budgetRemaining: { amount: 1, currency: 'EUR' } },
  ])('rejects invalid status without leaking input %#', (value) => {
    for (const render of [renderHuman, renderJson])
      expect(() => render(value as StatusRecord)).toThrow(InvalidStatusError);
  });

  it('supports zero incremental estimates and SHA-256 candidates', () => {
    const value = {
      ...status,
      candidateSha: 'b'.repeat(64),
      activeTimeMs: 0,
      estimatedSpend: { amount: 0, currency: 'USD' },
    };
    expect(JSON.parse(renderJson(value))).toEqual(value);
    expect(() => assertNoSecrets('public facts only')).not.toThrow();
  });

  it('snapshots getter-backed facts once before validation and secret detection', () => {
    for (const render of [renderJson, renderHuman]) {
      let reads = 0;
      const value = {
        ...status,
        get contributor() {
          reads++;
          return reads === 1 ? 'alice' : 'ghp_secret';
        },
      };
      expect(render(value)).not.toContain('ghp_');
      expect(reads).toBe(1);
      expect(() =>
        render({
          ...status,
          get contributor() {
            return 'ghp_secret';
          },
        })
      ).toThrow(SecretRedactionError);
    }
  });
});
