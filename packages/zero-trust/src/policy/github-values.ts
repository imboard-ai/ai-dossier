import { isPositiveId } from '../github/fork';
import { isGitHubLogin } from '../github/handoff';

/** Strict credential-free REST primitives shared by policy readers. No coercion. */
export function githubRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  if ('truncated' in record && record.truncated !== false) throw new Error();
  return record;
}
export function githubPositiveId(value: unknown): number {
  if (!isPositiveId(value)) throw new Error();
  return value;
}
export function githubArray(value: unknown, cap: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > cap ||
    ('truncated' in value && value.truncated !== false)
  )
    throw new Error();
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) throw new Error();
  return value;
}
export function isGitHubActorLogin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((value.endsWith('[bot]') && isGitHubLogin(value.slice(0, -5))) || isGitHubLogin(value))
  );
}
export function githubActor(value: unknown): { readonly login: string; readonly url: string } {
  const user = githubRecord(value);
  const { login, html_url: url, type, url: apiUrl } = user;
  if (!isGitHubActorLogin(login) || typeof url !== 'string') throw new Error();
  const bot = login.endsWith('[bot]');
  const expected = bot
    ? `https://github.com/apps/${login.slice(0, -5)}`
    : `https://github.com/${login}`;
  if (
    (bot ? type !== 'Bot' : type !== undefined && type !== 'User') ||
    url.toLowerCase() !== expected.toLowerCase()
  )
    throw new Error();
  if (
    apiUrl !== undefined &&
    (typeof apiUrl !== 'string' ||
      apiUrl.toLowerCase() !==
        `https://api.github.com/users/${encodeURIComponent(login)}`.toLowerCase())
  )
    throw new Error();
  return Object.freeze({ login, url });
}
