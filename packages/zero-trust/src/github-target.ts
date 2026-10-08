import { isGitHubLogin } from './github-login';

/** Credential-free GitHub target syntax; validation never grants write authority. */
export function isRepoName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9._-]{1,100}$/u.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}
export function isRepositoryTarget(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && isGitHubLogin(parts[0]) && isRepoName(parts[1]);
}
export function isPullRequestTarget(value: unknown, upstream?: string): value is string {
  if (typeof value !== 'string') return false;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,15})$/u.exec(value);
  if (
    !match ||
    !isRepositoryTarget(`${match[1]}/${match[2]}`) ||
    !Number.isSafeInteger(Number(match[3]))
  )
    return false;
  return (
    upstream === undefined || `${match[1]}/${match[2]}`.toLowerCase() === upstream.toLowerCase()
  );
}
