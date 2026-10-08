import { describe, expect, it } from 'vitest';
import { assertNoSecrets } from '../../redaction';
import { EngagementError, engagementBody } from '../engagement';

describe('deterministic engagement', () => {
  it.each([
    {},
    { testCommand: 'npm test' },
    { testCommand: 'pytest -q' },
  ])('discloses, asks welcome/assignment and has no promotion', (facts) => {
    const body = engagementBody(facts);
    expect(body).toContain('substantial LLM assistance through ai-dossier');
    expect(body).toContain('a minimal fix with a focused regression test');
    expect(body).toContain('assign me');
    expect(body).not.toContain('https://');
    expect(() => assertNoSecrets(body)).not.toThrow();
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(engagementBody(facts)).toBe(body);
  });
  it('accepts exactly the ceiling and rejects one character more', () => {
    const overhead = engagementBody({ testCommand: 'x' }).length - 1;
    expect(engagementBody({ testCommand: 'x'.repeat(1500 - overhead) })).toHaveLength(1500);
    expect(() => engagementBody({ testCommand: 'x'.repeat(1501 - overhead) })).toThrow(
      EngagementError
    );
  });
  it.each([
    '',
    ' ',
    'npm test\nnew paragraph',
    'npm `test`',
    '<script>',
    '\u202etest',
    `Authorization:\t${'t'.repeat(30)}`,
    `sk-proj-${'x'.repeat(48)}`,
  ])('refuses unsafe facts with fixed error', (testCommand) => {
    expect(() => engagementBody({ testCommand })).toThrow('Invalid engagement facts');
  });
  it('snapshots once and ignores model-provided extra fields', () => {
    let reads = 0;
    expect(
      engagementBody({
        get testCommand() {
          reads++;
          return reads === 1 ? 'npm test' : `sk-proj-${'x'.repeat(48)}`;
        },
      })
    ).toContain('`npm test`');
    expect(reads).toBe(1);
    expect(engagementBody({ approach: 'promote this product' } as never)).not.toContain('promote');
    expect(() => engagementBody(null as never)).toThrow(EngagementError);
    expect(() => engagementBody({ testCommand: 1 } as never)).toThrow(EngagementError);
  });
});
