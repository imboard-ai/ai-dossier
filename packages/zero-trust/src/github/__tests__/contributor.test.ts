/** #1065 contributor authorization against the stateful GitHub fake (probe-observed status
 * codes and token shapes). No network beyond a loopback socket. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createRun, ReasonCode, transitionRun } from '../../state';
import { AppCredentials } from '../app-auth';
import { CredentialBrokerError, ForkCredentialBroker } from '../broker';
import {
  AUTHORIZATION_WINDOW_MS,
  appInstallationFor,
  ContributorAuthError,
  ContributorAuthorization,
  installationSource,
  isLoopbackRedirect,
  listenLoopback,
} from '../contributor';
import { checkForkReadiness } from '../fork';
import type { TokenStore } from '../token-journal';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FORK_ID,
  GitHubFake,
  INSTALLATION_ID,
  OWNER,
  UPSTREAM_ID,
  USER_ID,
} from './github-fake';

const time = '2026-10-06T00:00:00.000Z';
const ISSUE = 'https://github.com/upstream-org/fixture/issues/1';
const SLUG = 'ztfc-contributor';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const run = createRun({ runId: 'run-1', upstreamIssue: ISSUE, contributor: OWNER }, time);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = new AppCredentials({
  appId: '12345',
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

function memoryStore(): TokenStore & { events: unknown[] } {
  const events: unknown[] = [];
  return { events, read: () => [...events], append: (event) => events.push(event) };
}

function setup() {
  let ms = Date.parse('2026-10-06T12:00:00.000Z');
  const clock = {
    now: () => ms,
    advance: (by: number) => {
      ms += by;
    },
  };
  const fake = new GitHubFake(clock.now);
  const store = memoryStore();
  const broker = new ForkCredentialBroker({
    store,
    http: fake.http,
    app,
    fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
    intents: () => ({ intents: new Map() }) as never,
    now: clock.now,
    sleep: async () => undefined,
  });
  const auth = new ContributorAuthorization({
    app,
    http: fake.http,
    oauth: fake.oauth,
    broker,
    contributor: OWNER,
    appSlug: SLUG,
    now: clock.now,
  });
  return { clock, fake, store, broker, auth };
}

/** The contributor approves the page: GitHub redirects back with a code and the state. */
function approve(env: ReturnType<typeof setup>) {
  const { url } = env.auth.begin(REDIRECT);
  const state = new URL(url).searchParams.get('state') as string;
  return { url, state, code: env.fake.grantCode() };
}

async function authorized() {
  const env = setup();
  const { code, state } = approve(env);
  const outcome = await env.auth.complete({ code, state }, run);
  expect(outcome).toEqual({ kind: 'bound', login: OWNER, userId: USER_ID });
  return env;
}

/** Every token and refresh token the fake issued; none may appear in any output. */
function secrets(env: ReturnType<typeof setup>): string[] {
  return [...env.fake.tokens.keys(), ...env.fake.refreshTokens.keys(), ...env.fake.codes];
}

describe('authorization web flow', () => {
  it('begins with a fresh state, PKCE S256, the run login hint and a loopback redirect', () => {
    const env = setup();
    const first = new URL(env.auth.begin(REDIRECT).url);
    const second = new URL(env.auth.begin(REDIRECT).url);
    expect(first.origin + first.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(first.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(first.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(first.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.searchParams.get('login')).toBe(OWNER);
    expect((first.searchParams.get('state') as string).length).toBeGreaterThanOrEqual(43);
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'));
    expect(first.toString()).not.toContain(CLIENT_SECRET);
  });

  it.each([
    'https://127.0.0.1:8080/callback',
    'http://localhost:8080/callback',
    'http://example.com:8080/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:8080/callback?next=x',
    'http://user@127.0.0.1:8080/callback',
    'not a url',
  ])('refuses the non-loopback redirect %s', (redirect) => {
    expect(isLoopbackRedirect(redirect)).toBe(false);
    expect(() => setup().auth.begin(redirect)).toThrow(ContributorAuthError);
  });

  it('accepts the IPv6 loopback literal', () => {
    expect(isLoopbackRedirect('http://[::1]:8080/callback')).toBe(true);
  });

  it('exchanges the code with the verifier, holds the token in the broker only (AC1)', async () => {
    const env = setup();
    const { url, state, code } = approve(env);
    const outcome = await env.auth.complete({ code, state }, run);
    expect(outcome).toEqual({ kind: 'bound', login: OWNER, userId: USER_ID });
    const form = env.fake.oauthCalls[0] as Record<string, string>;
    expect(form).toMatchObject({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    const challenge = createHash('sha256')
      .update(form.code_verifier as string)
      .digest('base64url');
    expect(new URL(url).searchParams.get('code_challenge')).toBe(challenge);
    const held = env.broker.status().tokens.filter((t) => t.kind === 'user' && t.status === 'live');
    expect(held).toHaveLength(1);
    expect(env.auth.status().authorization).toBe('authorized');
    // AC8: no token, refresh token or code in anything the module returns or prints.
    const printed = [
      JSON.stringify(outcome),
      JSON.stringify(env.auth),
      inspect(env.auth),
      JSON.stringify(env.auth.status()),
      JSON.stringify(env.broker.status()),
      JSON.stringify(env.store.events),
    ].join('\n');
    for (const secret of [...secrets(env), code, state]) expect(printed).not.toContain(secret);
  });

  it('refuses a wrong state without any exchange, and the attempt is spent', async () => {
    const env = setup();
    const { code } = approve(env);
    await expect(env.auth.complete({ code, state: 'forged' }, run)).rejects.toMatchObject({
      code: 'state_mismatch',
    });
    await expect(env.auth.complete({ code, state: 'forged' }, run)).rejects.toMatchObject({
      code: 'no_pending_authorization',
    });
    expect(env.fake.oauthCalls).toHaveLength(0);
  });

  it('a replayed callback finds nothing pending', async () => {
    const env = await authorized();
    await expect(env.auth.complete({ code: 'again', state: 'again' }, run)).rejects.toMatchObject({
      code: 'no_pending_authorization',
    });
  });

  it('refuses expired, denied, malformed and failed exchanges without echoing the code', async () => {
    const env = setup();
    let { code, state } = approve(env);
    env.clock.advance(AUTHORIZATION_WINDOW_MS);
    await expect(env.auth.complete({ code, state }, run)).rejects.toMatchObject({
      code: 'authorization_expired',
    });
    ({ code, state } = approve(env));
    await expect(env.auth.complete({ state, error: 'access_denied' }, run)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    ({ state } = approve(env));
    await expect(env.auth.complete({ code: 'bad code!', state }, run)).rejects.toMatchObject({
      code: 'invalid_callback',
    });
    ({ state } = approve(env));
    await expect(env.auth.complete(null as never, run)).rejects.toMatchObject({
      code: 'invalid_callback',
    });
    ({ code, state } = approve(env));
    env.fake.override('OAUTH', 'throw');
    const failure = await env.auth.complete({ code, state }, run).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(ContributorAuthError);
    expect((failure as ContributorAuthError).code).toBe('exchange_failed');
    expect((failure as Error).message).not.toContain(code);
    ({ state } = approve(env));
    await expect(env.auth.complete({ code: 'not-granted', state }, run)).rejects.toMatchObject({
      code: 'exchange_failed',
    });
    expect(env.broker.status().tokens).toEqual([]);
  });

  it('a second live authorization is refused and its token revoked at once', async () => {
    const env = await authorized();
    const { code, state } = approve(env);
    await expect(env.auth.complete({ code, state }, run)).rejects.toBeInstanceOf(
      CredentialBrokerError
    );
    const users = [...env.fake.tokens].filter(([, t]) => t.kind === 'user');
    expect(users.filter(([, t]) => t.live)).toHaveLength(1);
  });

  it('rejects a bad contributor login or App slug at construction', () => {
    const env = setup();
    const options = { app, http: env.fake.http, oauth: env.fake.oauth, broker: env.broker };
    expect(
      () => new ContributorAuthorization({ ...options, contributor: '-bad', appSlug: SLUG })
    ).toThrow(ContributorAuthError);
    expect(
      () => new ContributorAuthorization({ ...options, contributor: OWNER, appSlug: 'Bad Slug' })
    ).toThrow(ContributorAuthError);
  });
});

describe('login binding (AC1, scenario 17)', () => {
  it('another account authorizing blocks the run and revokes its authorization', async () => {
    const env = setup();
    env.fake.login = 'mallory';
    const { code, state } = approve(env);
    const outcome = await env.auth.complete({ code, state }, run);
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'contributor_mismatch' });
    const blocked = outcome as Extract<typeof outcome, { kind: 'blocked' }>;
    expect(blocked.run.state).toBe('blocked');
    expect(blocked.run.reasonCode).toBe(ReasonCode.PolicyBlocked);
    expect([...env.fake.tokens.values()].some((t) => t.live)).toBe(false);
    expect(env.auth.status().authorization).toBe('reauthorization_required');
    expect(env.fake.oauthCalls).toHaveLength(1);
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    expect(env.fake.oauthCalls).toHaveLength(1);
  });

  it('on resume, a changed login or account id blocks', async () => {
    const renamed = await authorized();
    renamed.fake.userId = USER_ID + 1;
    expect(await renamed.auth.bindLogin(run)).toMatchObject({
      kind: 'blocked',
      reason: 'contributor_mismatch',
    });
    const other = await authorized();
    other.fake.login = 'mallory';
    expect(await other.auth.bindLogin(run, USER_ID)).toMatchObject({ kind: 'blocked' });
    const recorded = await authorized();
    expect(await recorded.auth.bindLogin(run, USER_ID)).toMatchObject({ kind: 'bound' });
  });

  it('a recorded contributor that differs from the authorization target blocks', async () => {
    const env = await authorized();
    const otherRun = createRun(
      { runId: 'run-2', upstreamIssue: ISSUE, contributor: 'mallory' },
      time
    );
    env.fake.login = 'mallory';
    expect(await env.auth.bindLogin(otherRun)).toMatchObject({ kind: 'blocked' });
  });

  it('without a live user token the next action is reauthorize; unreadable is unknown', async () => {
    const env = setup();
    expect(await env.auth.bindLogin(run)).toMatchObject({ kind: 'reauthorize' });
    const live = await authorized();
    live.fake.override('GET /user', { status: 200, json: { login: OWNER } });
    expect(await live.auth.bindLogin(run)).toMatchObject({ kind: 'unknown' });
    live.fake.override('GET /user', 'throw');
    expect(await live.auth.bindLogin(run)).toMatchObject({ kind: 'unknown' });
    live.fake.override('GET /user', { status: 401, json: null });
    expect(await live.auth.bindLogin(run)).toMatchObject({ kind: 'reauthorize' });
  });
});

describe('refresh rotation (AC6, AC7)', () => {
  it('rotates atomically: the broker holds the new token before the refresh token changes', async () => {
    const env = await authorized();
    const first = [...env.fake.refreshTokens.keys()][0] as string;
    const outcome = await env.auth.refresh();
    expect(outcome).toMatchObject({ kind: 'refreshed' });
    expect(env.fake.oauthCalls[1]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: first,
    });
    // The rotated refresh token is the one used next; the first is dead (would fail).
    expect(await env.auth.refresh()).toMatchObject({ kind: 'refreshed' });
    expect(env.fake.oauthCalls[2]?.refresh_token).not.toBe(first);
    const live = env.broker.status().tokens.filter((t) => t.kind === 'user' && t.status === 'live');
    expect(live).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toMatch(/gh[ur]_/u);
  });

  it('concurrent refreshes share one exchange (a second use would kill the chain)', async () => {
    const env = await authorized();
    const [a, b] = await Promise.all([env.auth.refresh(), env.auth.refresh()]);
    expect(a).toEqual(b);
    expect(a.kind).toBe('refreshed');
    expect(env.fake.oauthCalls).toHaveLength(2);
  });

  it('bad_refresh_token leads to re-authorization, never a retry loop', async () => {
    const env = await authorized();
    env.fake.override('OAUTH', { status: 200, json: { error: 'bad_refresh_token' } });
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    expect(env.fake.oauthCalls).toHaveLength(2);
    expect(env.auth.status().nextPermittedAction).toMatch(/^reauthorize: /u);
  });

  it('after the broker revokes the user token, status says reauthorize without trying the dead refresh token', async () => {
    const env = await authorized();
    await env.broker.endRun('completed');
    const status = env.auth.status();
    expect(status.authorization).toBe('reauthorization_required');
    expect(status.nextPermittedAction).toMatch(/^reauthorize: /u);
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    // Only the original code exchange ever reached the token endpoint.
    expect(env.fake.oauthCalls).toHaveLength(1);
  });

  it('a later process holds no refresh token and must authorize again', async () => {
    const env = setup();
    expect(env.auth.status()).toMatchObject({ authorization: 'not_authorized' });
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    expect(env.fake.oauthCalls).toHaveLength(0);
  });

  it('no answer keeps the stored refresh token; the next explicit refresh uses it', async () => {
    const env = await authorized();
    env.fake.override('OAUTH', 'throw');
    expect(await env.auth.refresh()).toEqual({ kind: 'unavailable' });
    env.fake.override('OAUTH', { status: 200, json: { access_token: 'nope' } });
    expect(await env.auth.refresh()).toEqual({ kind: 'unavailable' });
    expect(await env.auth.refresh()).toMatchObject({ kind: 'refreshed' });
  });

  it('a token the broker cannot accept is revoked and the chain dropped', async () => {
    const env = await authorized();
    const killed = await env.broker.killAll();
    expect(killed.grant.deleted).toBe(true);
    expect(await env.auth.refresh()).toMatchObject({ kind: 'reauthorize' });
    expect(env.fake.oauthCalls).toHaveLength(1);
  });
});

describe('installation reads', () => {
  it('reads the selected repositories through the broker, paging', async () => {
    const env = await authorized();
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    env.fake.selected.set(INSTALLATION_ID, ids);
    const source = installationSource({ http: env.fake.http, app, contributor: env.auth });
    expect(await source.selectedRepositories(INSTALLATION_ID)).toEqual(ids);
    expect(await source.selectedRepositories(0)).toBeNull();
    // Unknown installation, malformed body, an unreadable transport.
    expect(await source.selectedRepositories(5)).toBeNull();
    env.fake.override('GET /user/installations', { status: 200, json: { repositories: [{}] } });
    expect(await source.selectedRepositories(INSTALLATION_ID)).toBeNull();
    env.fake.override('GET /user/installations', 'throw');
    expect(await source.selectedRepositories(INSTALLATION_ID)).toBeNull();
    env.fake.override('GET /user/installations', { status: 401, json: null });
    expect(await source.selectedRepositories(INSTALLATION_ID)).toBe('authorize');
    env.fake.selected.set(
      INSTALLATION_ID,
      Array.from({ length: 1000 }, (_, i) => i + 1)
    );
    expect(await source.selectedRepositories(INSTALLATION_ID)).toBeNull();
  });

  it('answers authorize without a contributor or after the token was revoked', async () => {
    const env = await authorized();
    expect(await installationSource({ http: env.fake.http, app }).selectedRepositories(1)).toBe(
      'authorize'
    );
    await env.broker.endRun('completed');
    expect(await env.auth.selectedRepositories(INSTALLATION_ID)).toBe('authorize');
  });

  it('the broker read is limited to the contributor endpoints', async () => {
    const env = await authorized();
    await expect(env.broker.readAsContributor('/repos/upstream-org/fixture')).rejects.toMatchObject(
      { code: 'read_not_allowed' }
    );
    await expect(env.broker.readAsContributor('/user?x=1')).rejects.toMatchObject({
      code: 'read_not_allowed',
    });
  });

  it('reads an installation with the App JWT', async () => {
    const env = setup();
    env.fake.appInstallations.set('contributor/fixture', {
      id: INSTALLATION_ID,
      account: { login: OWNER },
      repository_selection: 'selected',
      permissions: { contents: 'write', metadata: 'read' },
      suspended_at: null,
    });
    expect(await appInstallationFor(env.fake.http, app, { owner: OWNER, repo: 'fixture' })).toEqual(
      {
        id: INSTALLATION_ID,
        account: OWNER,
        repositorySelection: 'selected',
        permissions: { contents: 'write', metadata: 'read' },
        suspended: false,
      }
    );
    expect(
      await appInstallationFor(env.fake.http, app, { owner: 'upstream-org', repo: 'fixture' })
    ).toBe('none');
    env.fake.override('GET /repos/contributor', { status: 200, json: { id: 'x' } });
    expect(
      await appInstallationFor(env.fake.http, app, { owner: OWNER, repo: 'fixture' })
    ).toBeNull();
    env.fake.override('GET /repos/contributor', 'throw');
    expect(
      await appInstallationFor(env.fake.http, app, { owner: OWNER, repo: 'fixture' })
    ).toBeNull();
    const call = env.fake.calls.find((c) => c.path === '/repos/contributor/fixture/installation');
    expect(call?.token?.split('.')).toHaveLength(3);
  });

  it('end to end: authorization required, then ready, from fixtures only', async () => {
    const env = setup();
    env.fake.appInstallations.set('contributor/fixture', {
      id: INSTALLATION_ID,
      account: { login: OWNER },
      repository_selection: 'selected',
      permissions: { contents: 'write', metadata: 'read' },
      suspended_at: null,
    });
    env.fake.selected.set(INSTALLATION_ID, [FORK_ID]);
    const read = async (path: string) =>
      path === '/repos/contributor/fixture'
        ? {
            status: 200,
            body: {
              id: FORK_ID,
              full_name: 'contributor/fixture',
              fork: true,
              owner: { login: OWNER },
              parent: { id: UPSTREAM_ID },
            },
          }
        : { status: 404, body: null };
    const shipping = [
      ReasonCode.GatePassed,
      ReasonCode.PlanApproved,
      ReasonCode.CandidateReady,
      ReasonCode.VerificationPassed,
    ].reduce((r, reason) => transitionRun(r, reason, time), run);
    const input = {
      run: shipping,
      upstreamId: UPSTREAM_ID,
      appSlug: SLUG,
      declaredPermissions: { contents: 'write', metadata: 'read' } as const,
    };
    const before = await checkForkReadiness(input, {
      read,
      installations: installationSource({ http: env.fake.http, app }),
      now: () => time,
    });
    expect(before).toMatchObject({
      kind: 'authorization_required',
      fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
    });
    const { code, state } = approve(env);
    expect(await env.auth.complete({ code, state }, shipping)).toMatchObject({ kind: 'bound' });
    const after = await checkForkReadiness(input, {
      read,
      installations: installationSource({ http: env.fake.http, app, contributor: env.auth }),
      now: () => time,
    });
    expect(after).toMatchObject({ kind: 'ready', fork: { installationId: INSTALLATION_ID } });
  });
});

describe('loopback receiver', () => {
  it('receives one callback, echoes nothing and sends no referrer', async () => {
    const receiver = await listenLoopback();
    expect(isLoopbackRedirect(receiver.redirectUri)).toBe(true);
    const miss = await fetch(new URL('/other', receiver.redirectUri));
    expect(miss.status).toBe(404);
    const response = await fetch(`${receiver.redirectUri}?code=secret-code-123&state=st&extra=1`);
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(page).not.toContain('secret-code-123');
    expect(await receiver.callback).toEqual({ code: 'secret-code-123', state: 'st' });
    receiver.close();
  });

  it('carries a denial and times out when nobody returns', async () => {
    const denied = await listenLoopback({ path: '/cb' });
    await fetch(`${denied.redirectUri}?error=access_denied&state=s`);
    expect(await denied.callback).toEqual({ error: 'access_denied', state: 's' });
    const idle = await listenLoopback({ timeoutMs: 5 });
    await expect(idle.callback).rejects.toMatchObject({ code: 'authorization_expired' });
    expect(() => listenLoopback({ path: 'no-slash' })).toThrow(ContributorAuthError);
  });
});
