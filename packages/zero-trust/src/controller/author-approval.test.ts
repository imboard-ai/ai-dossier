import { describe, expect, it } from 'vitest';
import { AuthorApprovalError, requireAuthorApproval } from './author-approval';
import type { AuthorApproval } from './config';

const authorApproval: AuthorApproval = {
  userId: 12,
  login: 'contributor',
  name: 'Approved Name',
  email: '12+contributor@users.noreply.github.com',
  source: 'default',
  approvedAt: '2026-10-10T00:00:00.123Z',
};
describe('persisted author approval', () => {
  it('uses only the approved name/email/time and returns an immutable canonical identity', () => {
    const result = requireAuthorApproval(
      { contributor: 'Contributor', authorApproval },
      { userId: 12, login: 'CONTRIBUTOR' }
    );
    expect(result).toEqual({
      login: 'contributor',
      name: 'Approved Name',
      email: authorApproval.email,
      timestamp: '2026-10-10T00:00:00Z',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('never defaults a missing identity', () => {
    expect(() =>
      requireAuthorApproval({ contributor: 'contributor' }, { userId: 12, login: 'contributor' })
    ).toThrowError(new AuthorApprovalError('author_approval_missing'));
  });
  it.each([
    { userId: 13, login: 'contributor' },
    { userId: 12, login: 'other' },
    { userId: 0, login: 'contributor' },
    { userId: Number.NaN, login: 'contributor' },
  ])('refuses account mismatch %j', (identity) => {
    expect(() =>
      requireAuthorApproval({ contributor: 'contributor', authorApproval }, identity)
    ).toThrowError(new AuthorApprovalError('author_approval_mismatch'));
  });
  it('refuses an approval bound to a different configured contributor', () => {
    expect(() =>
      requireAuthorApproval(
        { contributor: 'other', authorApproval },
        { userId: 12, login: 'contributor' }
      )
    ).toThrowError(new AuthorApprovalError('author_approval_mismatch'));
  });
});
