import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  APP_CREDENTIAL_ENV,
  AppCredentials,
  appCredentialsFromEnv,
  deleteGrant,
  deleteToken,
  fetchGitHubHttp,
  GitHubAuthError,
  GitHubTransportError,
  mintInstallationToken,
  probeToken,
  scopeUserToken,
} from '../app-auth';
import { CLIENT_ID, FORK_ID, GitHubFake, INSTALLATION_ID, OWNER, UPSTREAM_ID } from './github-fake';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const env = {
  [APP_CREDENTIAL_ENV.appId]: '12345',
  [APP_CREDENTIAL_ENV.clientId]: CLIENT_ID,
  [APP_CREDENTIAL_ENV.clientSecret]: 'fixture-client-secret',
  [APP_CREDENTIAL_ENV.privateKey]: pem.replace(/\n/gu, '\\n'),
};
const now = Date.parse('2026-10-06T12:00:00.000Z');

describe('App credentials', () => {
  it('reads secrets from the environment and signs a verifiable RS256 App JWT', () => {
    const app = appCredentialsFromEnv(env);
    const [header, claims, signature] = app.appJwt(now).split('.');
    expect(JSON.parse(Buffer.from(header as string, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims as string, 'base64url').toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: '12345',
    });
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, signature as string, 'base64url')).toBe(true);
    expect(app.clientAuthorization()).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:fixture-client-secret`).toString('base64')}`
    );
  });

  it('never serializes secrets and refuses missing or malformed values', () => {
    const app = appCredentialsFromEnv(env);
    for (const text of [JSON.stringify({ app }), inspect(app), `${Object.keys(app)}`])
      expect(text).not.toMatch(/fixture-client-secret|PRIVATE KEY/u);
    expect(() => appCredentialsFromEnv({ ...env, [APP_CREDENTIAL_ENV.clientSecret]: ' ' })).toThrow(
      GitHubAuthError
    );
    expect(() => appCredentialsFromEnv({ ...env, [APP_CREDENTIAL_ENV.appId]: 'x1' })).toThrow(
      GitHubAuthError
    );
    const broken = new AppCredentials({
      appId: '1',
      clientId: CLIENT_ID,
      clientSecret: 's',
      privateKey: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----',
    });
    expect(() => broken.appJwt(now)).toThrow(GitHubAuthError);
  });
});

describe('fetchGitHubHttp', () => {
  it('sends versioned JSON requests and parses responses', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = fetchGitHubHttp('https://api.example.test', (async (
      url: string,
      init: RequestInit
    ) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch);
    await expect(
      http({ method: 'POST', path: '/x', authorization: 'Bearer abc', body: { a: 1 } })
    ).resolves.toEqual({ status: 201, json: { ok: true } });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(seen[0]?.url).toBe('https://api.example.test/x');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['Content-Type']).toBe('application/json');
    expect(seen[0]?.init.redirect).toBe('error');
  });

  it('tolerates empty and non-JSON bodies and hides transport details', async () => {
    const empty = fetchGitHubHttp(
      'https://api.example.test',
      (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    );
    await expect(
      empty({ method: 'DELETE', path: '/t', authorization: 'Basic x' })
    ).resolves.toEqual({
      status: 204,
      json: null,
    });
    const html = fetchGitHubHttp(
      'https://api.example.test',
      (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    );
    await expect(html({ method: 'GET', path: '/t', authorization: 'Basic x' })).resolves.toEqual({
      status: 502,
      json: null,
    });
    const down = fetchGitHubHttp('https://api.example.test', (async () => {
      throw new Error('connect failed for Bearer ghs_secretvalue');
    }) as unknown as typeof fetch);
    const error = await down({ method: 'GET', path: '/t', authorization: 'Bearer x' }).catch(
      (e: Error) => e
    );
    expect(error).toBeInstanceOf(GitHubTransportError);
    expect(String((error as Error).message)).not.toContain('ghs_');
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('recorded-response fake matches the gate-3 probe evidence', () => {
  // Redacted live evidence; the fake must reproduce each recorded status code.
  const evidence = fs
    .readFileSync(
      path.join(
        __dirname,
        '../../../../../docs/reports/evidence/ztfc-github-credentials-probe.jsonl'
      ),
      'utf8'
    )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { step: string; status: number | string });
  const recorded = (step: string) => evidence.find((e) => e.step === step)?.status;

  it('reproduces mint, narrowing, revocation, scoping and grant statuses', async () => {
    const clock = () => now;
    const fake = new GitHubFake(clock);
    const app = appCredentialsFromEnv(env);
    const results: [string, number][] = [];

    const ghs = await mintInstallationToken(fake.http, app, INSTALLATION_ID, FORK_ID, now);
    expect(ghs.kind).toBe('issued');
    results.push(['Q4b mint installation token narrowed to fork, contents:write', 201]);
    const upstream = await mintInstallationToken(fake.http, app, INSTALLATION_ID, UPSTREAM_ID, now);
    results.push([
      'Q4 negative: installation token for upstream repo id',
      (upstream as { status: number }).status,
    ]);
    const value = ghs.kind === 'issued' ? ghs.token.value : '';
    results.push([
      'revoke installation token',
      await deleteToken(fake.http, app, 'installation', value),
    ]);
    results.push([
      'reuse revoked installation token (expect 401)',
      await probeToken(fake.http, 'installation', value),
    ]);

    const t1 = fake.authorizeUser();
    const child = await scopeUserToken(fake.http, app, t1, OWNER, FORK_ID);
    results.push(['Q3 scoped child of t1', child.kind === 'issued' ? 200 : 0]);
    const childValue = child.kind === 'issued' ? child.token.value : '';
    const grandchild = await scopeUserToken(fake.http, app, childValue, OWNER, FORK_ID);
    results.push([
      'Q3 scoped grandchild (scoped from a scoped token)',
      (grandchild as { status: number }).status,
    ]);
    const owner = await scopeUserToken(fake.http, app, t1, 'upstream-owner', FORK_ID);
    results.push(['Q2 scoped aimed at upstream owner', (owner as { status: number }).status]);
    results.push([
      'Q3 DELETE /applications/{client_id}/token on t1',
      await deleteToken(fake.http, app, 'user', t1),
    ]);
    results.push([
      'Q3 revoked access token reuse (expect 401)',
      await probeToken(fake.http, 'user', t1),
    ]);
    results.push([
      'Q3 scoped child of t1 after parent revoked',
      await probeToken(fake.http, 'user', childValue),
    ]);
    results.push([
      'Q3 DELETE /applications/{client_id}/grant using a live child',
      await deleteGrant(fake.http, app, childValue),
    ]);
    results.push([
      'Q3 child after grant deletion (expect 401)',
      await probeToken(fake.http, 'user', childValue),
    ]);
    results.push([
      'Q3 DELETE /applications/{client_id}/grant (final)',
      await deleteGrant(fake.http, app, t1),
    ]);

    for (const [step, status] of results) expect([step, status]).toEqual([step, recorded(step)]);
  });
});
