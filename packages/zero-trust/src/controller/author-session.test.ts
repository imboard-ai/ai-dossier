import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET } from '../github/__tests__/github-fake';
import { Journal } from '../journal';
import { assertSecretFree } from '../redaction';
import { rig } from './__tests__/composition-fixture';
import { compositionHooks } from './__tests__/composition-hooks';
import { RunStore } from './run-store';
import { createController, prepareAuthorSession } from './wiring';

compositionHooks();

async function prepare(h: ReturnType<typeof rig>) {
  const pages: string[] = [];
  const callbacks: Promise<Response>[] = [];
  const onAuthorizationUrl = (value: string) => {
    pages.push(value);
    const page = new URL(value);
    const redirect = new URL(page.searchParams.get('redirect_uri') as string);
    redirect.searchParams.set('state', page.searchParams.get('state') as string);
    redirect.searchParams.set('code', h.fake.grantCode());
    callbacks.push(fetch(redirect));
  };
  const session = await prepareAuthorSession(h.config, {}, { ...h.edges, onAuthorizationUrl });
  await Promise.all(callbacks);
  return { session, pages, onAuthorizationUrl };
}

describe('one process author authorization', () => {
  it.each([
    'before-disposal',
    'during-delete',
  ] as const)('ends the refresh chain when access expires %s', async (when) => {
    const h = rig();
    const { session } = await prepare(h);
    if (when === 'before-disposal') {
      h.advanceClock(9 * 60 * 60 * 1000);
      for (const token of h.fake.tokens.values()) token.live = false;
    } else h.fake.override(`DELETE /applications/${CLIENT_ID}/token`, { status: 404, json: null });
    await session.dispose();
    await session.dispose();
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    expect(h.fake.oauthCalls.filter((call) => call.grant_type === 'refresh_token')).toHaveLength(1);
    for (const refresh of h.fake.refreshTokens.keys()) {
      expect(
        (
          await h.fake.oauth({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refresh,
          })
        ).json
      ).toEqual({ error: 'bad_refresh_token' });
    }
  });

  it('refuses account-only session selection before opening OAuth', async () => {
    const h = rig();
    await expect(
      prepareAuthorSession(h.config, { userId: 12 } as never, h.edges)
    ).rejects.toMatchObject({ code: 'invalid_options' });
    expect(h.fake.oauthCalls).toEqual([]);
    expect(h.fake.tokens.size).toBe(0);
  });

  it('shared authorization reaches terminal merge and leaves neither access nor refresh live', async () => {
    const h = rig();
    const { session, pages, onAuthorizationUrl } = await prepare(h);
    const config = { ...h.config, authorApproval: session.approval };
    const controller = createController(config, { ...h.edges, onAuthorizationUrl }, session);
    const run = await controller.start(config);
    expect(run.state).toBe('awaiting_contributor');
    expect(pages).toHaveLength(1);
    h.submit(run.runId);
    await controller.resume(run.runId);
    const pr = h.pr();
    if (!pr) throw new Error('missing PR');
    pr.merged_at = h.edges.now().toISOString();
    pr.state = 'closed';
    expect((await controller.resume(run.runId)).state).toBe('merged');
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    for (const refresh of h.fake.refreshTokens.keys()) {
      expect(
        (
          await h.fake.oauth({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refresh,
          })
        ).json
      ).toEqual({ error: 'bad_refresh_token' });
    }
  }, 60000);

  it('refreshes consent that aged during confirmation and fresh-process authorize requires fresh identity', async () => {
    const h = rig({ checkpoint: 'plan' });
    const { session, pages, onAuthorizationUrl } = await prepare(h);
    h.advanceClock(9 * 60 * 60 * 1000);
    const config = { ...h.config, authorApproval: session.approval };
    const first = createController(config, { ...h.edges, onAuthorizationUrl }, session);
    const run = await first.start(config);
    expect(run.state).toBe('paused_user');
    expect(pages).toHaveLength(1);
    expect(h.fake.oauthCalls.some((call) => call.grant_type === 'refresh_token')).toBe(true);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    const fresh = createController(config, { ...h.edges, onAuthorizationUrl });
    await fresh.authorize(run.runId);
    expect(pages).toHaveLength(2);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
  }, 60000);

  it('shares one actual OAuth callback through gate, fork readiness and broker, with no durable secrets', async () => {
    const h = rig({ checkpoint: 'plan' });
    const { session, pages, onAuthorizationUrl } = await prepare(h);
    const config = { ...h.config, authorApproval: session.approval };
    const controller = createController(config, { ...h.edges, onAuthorizationUrl }, session);
    const run = await controller.start(config);
    expect(run.state).toBe('paused_user');
    expect(pages).toHaveLength(1);
    expect(
      h.fake.oauthCalls.filter((call) => call.grant_type === 'authorization_code')
    ).toHaveLength(1);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    assertSecretFree(JSON.stringify(session));
    assertSecretFree(inspect(session));
    const store = RunStore.open(path.join(config.executionProfile.stateDir, 'runs'), run.runId, {
      readOnly: true,
    });
    try {
      const journal = new Journal(store.storeDirectory('tokens'));
      try {
        const events = journal.read();
        expect(events.some((row) => (row as { type: string }).type === 'token_minted')).toBe(true);
        const values = [...h.fake.tokens.keys(), ...h.fake.refreshTokens.keys()];
        const visit = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) {
              const bytes = fs.readFileSync(file).toString();
              for (const value of values) expect(bytes).not.toContain(value);
            }
          }
        };
        visit(path.join(config.executionProfile.stateDir, 'runs'));
      } finally {
        journal.close();
      }
    } finally {
      store.close();
      await session.dispose();
    }
  }, 60000);

  it('revokes unused and policy-refused sessions without opening another page', async () => {
    const h = rig({ policy: 'ban' });
    const { session, pages, onAuthorizationUrl } = await prepare(h);
    const config = { ...h.config, authorApproval: session.approval };
    const run = await createController(config, { ...h.edges, onAuthorizationUrl }, session).start(
      config
    );
    expect(run.state).toBe('blocked');
    expect(pages).toHaveLength(1);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    await session.dispose();
  }, 60000);

  it('keeps a disposable owner after construction fails and refuses changed consent before broker registration', async () => {
    const h = rig();
    const { session } = await prepare(h);
    const config = { ...h.config, authorApproval: session.approval };
    expect(() =>
      createController(
        {
          ...config,
          executionProfile: { ...config.executionProfile, proxyEndpointsFile: '/missing-proxy' },
        },
        h.edges,
        session
      )
    ).toThrow('invalid_proxy_file');
    const register = {
      status: () => ({ admissions: 'open' }),
      registerUserToken: () => {
        throw new Error('must not register');
      },
    };
    expect(() =>
      session.adopt(register as never, {} as never, {
        ...config,
        authorApproval: { ...session.approval, userId: session.approval.userId + 1 },
      })
    ).toThrow('author_approval_mismatch');
    await session.dispose();
    await session.dispose();
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
  });
});
