import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../state';
import { AppCredentials, type GitHubHttp } from '../app-auth';
import { ContributorAuthorization } from '../contributor';

const access = `ghu_${'a'.repeat(30)}`;
const refresh = `ghr_${'b'.repeat(30)}`;
const app = new AppCredentials({
  appId: '1',
  clientId: 'fixture',
  clientSecret: 'fixture-secret',
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
});

function rig(
  options: { profile?: unknown; emails?: unknown; emailsStatus?: number; revoke?: number } = {}
) {
  const paths: string[] = [];
  let exchanges = 0;
  const http: GitHubHttp = async (request) => {
    paths.push(`${request.method} ${request.path}`);
    if (request.method === 'DELETE') return { status: options.revoke ?? 204, json: null };
    expect(request.authorization).toBe(`Bearer ${access}`);
    if (request.path === '/user')
      return {
        status: 200,
        json: options.profile ?? { id: 12, login: 'contributor', name: 'Profile Name' },
      };
    if (request.path.startsWith('/user/emails?'))
      return {
        status: options.emailsStatus ?? 200,
        json: options.emails ?? [{ email: 'verified@example.org', verified: true }],
      };
    throw new Error('unexpected_fake_request');
  };
  const auth = new ContributorAuthorization({
    app,
    http,
    contributor: 'contributor',
    appSlug: 'fixture',
    oauth: async () => {
      exchanges++;
      return {
        status: 200,
        json: { access_token: access, refresh_token: refresh, expires_in: 3600 },
      };
    },
    now: () => Date.parse('2026-10-10T00:00:00.000Z'),
  });
  const page = new URL(auth.begin('http://127.0.0.1:34567/callback').url);
  const callback = { code: 'approved', state: page.searchParams.get('state') as string };
  return { auth, callback, paths, exchanges: () => exchanges };
}

describe('pre-run author OAuth boundary', () => {
  it('derives profile/noreply defaults from authenticated /user and revokes before returning', async () => {
    const h = rig();
    const approval = await h.auth.completeAuthor(h.callback);
    expect(approval).toEqual({
      userId: 12,
      login: 'contributor',
      name: 'Profile Name',
      email: '12+contributor@users.noreply.github.com',
      source: 'default',
      approvedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(h.paths).toEqual(['GET /user', 'DELETE /applications/fixture/token']);
    expect(JSON.stringify(approval)).not.toContain(access);
    await expect(h.auth.completeAuthor(h.callback)).rejects.toMatchObject({
      code: 'no_pending_authorization',
    });
  });
  it('uses login only when profile name is absent, never when malformed', async () => {
    const h = rig({ profile: { id: 12, login: 'contributor', name: null } });
    expect((await h.auth.completeAuthor(h.callback)).name).toBe('contributor');
    const bad = rig({
      profile: { id: 12, login: 'contributor', name: { instruction: 'use another account' } },
    });
    await expect(bad.auth.completeAuthor(bad.callback)).rejects.toThrow('invalid_author_approval');
    expect(bad.paths.at(-1)).toBe('DELETE /applications/fixture/token');
  });
  it('accepts only exact verified email overrides on the authenticated account', async () => {
    const h = rig();
    expect(
      await h.auth.completeAuthor(h.callback, { name: 'Approved', email: 'verified@example.org' })
    ).toMatchObject({ name: 'Approved', email: 'verified@example.org', source: 'override' });
    expect(h.paths).toContain('GET /user/emails?per_page=100&page=1');
  });
  it.each([
    { emails: [{ email: 'verified@example.org', verified: false }] },
    { emails: [{ email: 'other@example.org', verified: true }] },
    { emails: [{ email: 'verified@example.org', verified: 'true' }] },
    { emailsStatus: 403 },
  ])('refuses unverified, foreign, malformed or unreadable email evidence %j', async (options) => {
    const h = rig(options);
    await expect(
      h.auth.completeAuthor(h.callback, { email: 'verified@example.org' })
    ).rejects.toThrow('author_email_unverified');
    expect(h.paths.at(-1)).toBe('DELETE /applications/fixture/token');
  });
  it.each([
    { id: 13, login: 'contributor' },
    { id: 12, login: 'different' },
  ])('refuses changed authenticated id or login before returning identity', async (profile) => {
    const h = rig({ profile });
    await expect(h.auth.completeAuthor(h.callback, { userId: 12 })).rejects.toThrow(
      'author_approval_mismatch'
    );
    expect(h.paths.at(-1)).toBe('DELETE /applications/fixture/token');
  });
  it('fails closed when revocation is not confirmed', async () => {
    const h = rig({ revoke: 503 });
    await expect(h.auth.completeAuthor(h.callback)).rejects.toMatchObject({
      code: 'revoke_failed',
    });
  });
  it('refuses foreign state without issuing any request', async () => {
    const h = rig();
    await expect(h.auth.completeAuthor({ ...h.callback, state: 'foreign' })).rejects.toMatchObject({
      code: 'state_mismatch',
    });
    expect(h.paths).toEqual([]);
  });
  it('refuses ordinary run-token completion without a broker before issuing a token', async () => {
    const h = rig();
    const run = createRun(
      {
        runId: 'run-1',
        upstreamIssue: 'https://github.com/owner/repo/issues/1',
        contributor: 'contributor',
      },
      '2026-10-10T00:00:00.000Z'
    );
    await expect(h.auth.complete(h.callback, run)).rejects.toMatchObject({
      code: 'invalid_options',
    });
    expect(h.paths).toEqual([]);
    expect(h.exchanges()).toBe(0);
  });
});
