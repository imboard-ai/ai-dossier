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
    '_sk-proj-syntheticKey_',
    'credential_sk-12345678',
    `nsk-${'A'.repeat(48)}`,
    `0sk-${'A'.repeat(48)}`,
    String.raw`\nsk-proj-syntheticKey`,
    String.raw`\u0020sk-12345678`,
    'Bearer x',
    'Bearer\tx',
    'Bearer\nx',
    'Authorization: token x',
    'Authorization:\ttoken\tx',
    'Authorization : token x',
    'Authorization:\ntoken x',
    String.raw`Authorization:\ttoken\tx`,
    String.raw`Authorization:\x09token\x20x`,
    String.raw`Authorization:\u0009token\u0020x`,
    String.raw`Authorization:\040token\040x`,
    String.raw`Authorization:\011token\012x`,
    String.raw`Authorization:\x9token\u20x`,
    String.raw`Authorization:\U00000009token\U00000020x`,
    JSON.stringify({ header: 'Authorization:\ttoken\tx' }),
    JSON.stringify({ command: String.raw`curl -H $'Authorization:\ttoken\tx'` }),
    String.raw`Authorization:\ token\ syntheticOpaqueToken`,
    String.raw`Authorization:\0040token\0040syntheticOpaqueToken`,
    JSON.stringify({ command: 'Authoriza\\\ntion: token syntheticOpaqueToken' }),
    'Authorization:\\\n token syntheticOpaqueToken',
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
    'npm run task-validation',
    'risk-assessment',
    'fork:22:branch:task-validation',
    'https://github.com/o/task-readiness/issues/1',
    'token counts',
    'Authorization: public',
    'retry without credentials',
  ])('allows public facts: %s', (text) => {
    expect(() => assertNoSecrets(text)).not.toThrow();
  });

  it('exports an immutable pattern list and scans long non-matching text', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    expect(() => assertNoSecrets('authorization '.repeat(100000))).not.toThrow();
    expect(() => assertNoSecrets('\\'.repeat(100000))).not.toThrow();
  });
});
