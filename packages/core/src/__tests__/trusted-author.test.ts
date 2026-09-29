import { describe, expect, it } from 'vitest';
import { isTrustedAuthorAssociation } from '../trusted-author';

describe('isTrustedAuthorAssociation (#808)', () => {
  it('trusts OWNER, MEMBER and COLLABORATOR', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(isTrustedAuthorAssociation(a)).toBe(true);
    }
  });

  it('rejects every other GitHub association, BOT (not a real value), and non-strings', () => {
    for (const a of [
      'CONTRIBUTOR',
      'FIRST_TIMER',
      'FIRST_TIME_CONTRIBUTOR',
      'MANNEQUIN',
      'NONE',
      'BOT',
      'owner',
      '',
      undefined,
      null,
      7,
      {},
    ]) {
      expect(isTrustedAuthorAssociation(a)).toBe(false);
    }
  });
});
