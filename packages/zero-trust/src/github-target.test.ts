import { describe, expect, it } from 'vitest';
import { isPullRequestTarget, isRepoName, isRepositoryTarget } from './github-target';

describe('credential-free target syntax', () => {
  it('preserves repository rules and binds PR URLs case-insensitively', () => {
    expect(isRepoName('repo._-')).toBe(true);
    expect(isRepositoryTarget('Owner/Repo')).toBe(true);
    expect(isPullRequestTarget('https://github.com/Owner/Repo/pull/1', 'owner/repo')).toBe(true);
    expect(isPullRequestTarget('https://github.com/owner/repo/pull/1')).toBe(true);
    for (const value of [null, [], '', '.', '..', 'a'.repeat(101), 'a/b'])
      expect(isRepoName(value)).toBe(false);
    for (const value of [null, [], 'not a repo', 'a/b/c', 'a--b/repo', 'owner/..'])
      expect(isRepositoryTarget(value)).toBe(false);
    for (const value of [
      null,
      [],
      'not a URL',
      'https://github.com/owner/repo/pull/0',
      'https://github.com/owner/repo/pull/9007199254740992',
      'https://github.com/other/repo/pull/1',
      'https://github.com/owner/../pull/1',
    ])
      expect(isPullRequestTarget(value, 'owner/repo')).toBe(false);
  });
});
