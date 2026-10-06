import { describe, expect, it } from 'vitest';
import { assertNoSecrets, SECRET_PATTERNS, SecretRedactionError } from './redaction';

describe('shared credential rejection policy', () => {
  it.each([
    'gho_',
    'ghu_',
    'ghr_',
    'ghs_',
    'ghp_',
    'github_pat_',
    'sk-ant-',
    'sk-',
    'sk-proj-',
    'sk-12345678',
    'Bearer x',
    'Bearer\tx',
    'Bearer\nx',
    'Authorization: token x',
    'Authorization:\ttoken\tx',
    'Authorization : token x',
    'Authorization:\ntoken x',
  ])('rejects synthetic credential %# without echoing input', (credential) => {
    for (const text of [credential, credential.toUpperCase(), `prefix ${credential} suffix`]) {
      // Repeated calls must not depend on a global/sticky regex lastIndex.
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => assertNoSecrets(text)).toThrow(SecretRedactionError);
        try {
          assertNoSecrets(text);
        } catch (error) {
          expect(String(error)).toBe(
            'SecretRedactionError: Record contains a prohibited credential pattern'
          );
          expect(String(error)).not.toContain(text);
        }
      }
    }
  });

  it.each([
    'public facts only',
    'task-ready',
    'risk-budget',
    'token counts',
    'Authorization: public',
    'retry without credentials',
  ])('allows public facts: %s', (text) => {
    expect(() => assertNoSecrets(text)).not.toThrow();
  });

  it('exports an immutable pattern list and scans long non-matching text', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    expect(() => assertNoSecrets('authorization '.repeat(100000))).not.toThrow();
  });
});
