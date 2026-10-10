import type { ContributorApproval } from '../canonical/reconstruct';
import { sameLogin } from '../github/handoff';
import type { RunConfig } from './config';

export class AuthorApprovalError extends Error {
  constructor(readonly code: 'author_approval_missing' | 'author_approval_mismatch') {
    super(`Contributor authorship refused (${code})`);
    this.name = 'AuthorApprovalError';
  }
}

/** Account observation is authenticated, never the repository or model's author text.
 * The start CLI owns default computation, verified overrides and explicit consent. */
export function requireAuthorApproval(
  config: Pick<RunConfig, 'contributor' | 'authorApproval'>,
  identity: { readonly login: string; readonly userId: number }
): ContributorApproval {
  const approved = config.authorApproval;
  if (!approved) throw new AuthorApprovalError('author_approval_missing');
  if (
    !Number.isSafeInteger(identity.userId) ||
    identity.userId <= 0 ||
    identity.userId !== approved.userId ||
    !sameLogin(identity.login, approved.login) ||
    !sameLogin(identity.login, config.contributor)
  )
    throw new AuthorApprovalError('author_approval_mismatch');
  return Object.freeze({
    login: approved.login,
    name: approved.name,
    email: approved.email,
    timestamp: approved.approvedAt.replace(/\.\d{3}Z$/u, 'Z'),
  });
}
