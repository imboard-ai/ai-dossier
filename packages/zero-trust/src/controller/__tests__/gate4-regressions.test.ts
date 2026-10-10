/** Gate-4 regressions kept separate from the upstream revision composition suite. */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_ID, OWNER } from '../../github/__tests__/github-fake';
import { Journal } from '../../journal';
import { requestControl } from '../control';
import { RunStore } from '../run-store';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, noShipping } from './composition-hooks';

compositionHooks();
describe('gate 4 composed cleanup regressions', () => {
  function request(h: ReturnType<typeof rig>, kind: 'pause' | 'cancel') {
    const store = RunStore.open(
      path.join(h.config.executionProfile.stateDir, 'runs'),
      h.controller.snapshot().runId,
      { readOnly: true, observe: true }
    );
    try {
      return requestControl(store, { kind, reason: 'User control' }, new Date(TIME));
    } finally {
      store.close();
    }
  }
  it.each([
    'pause',
    'cancel',
  ] as const)('revokes the refresh chain when %s outlives the native access token', async (kind) => {
    const h = rig({ activeControl: 'write', oauthExpiresIn: 1 });
    const task = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    h.advanceClock(2000);
    request(h, kind);
    expect(((await task) as { state: string }).state).toBe(
      kind === 'pause' ? 'paused_user' : 'cancelled'
    );
    expect(h.fake.oauthCalls.filter((form) => form.grant_type === 'refresh_token')).toHaveLength(1);
    expect([...h.fake.tokens.values()].filter((token) => token.live || token.refreshAlive)).toEqual(
      []
    );
    expect([...h.fake.refreshTokens.values()].filter((token) => token.live)).toEqual([]);
    noShipping();
  }, 60000);
  it.each([
    404, 401,
  ])('access expiry during DELETE %s never fabricates refresh-chain cleanup', async (status) => {
    const h = rig({ checkpoint: 'plan', oauthExpiresIn: 1 });
    const http = h.fake.http;
    let expired = false;
    vi.spyOn(h.fake, 'http').mockImplementation(async (req) => {
      if (!expired && req.method === 'DELETE' && req.path === `/applications/${CLIENT_ID}/token`) {
        expired = true;
        h.advanceClock(2000);
        h.fake.override(`DELETE /applications/${CLIENT_ID}/token`, { status, json: null }, 3);
      }
      return http(req);
    });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toThrow('cleanup_incomplete');
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.store.run.state).toBe('blocked_cleanup');
    const tokens = new Journal(a.store.storeDirectory('tokens'));
    expect(tokens.read()).toContainEqual(
      expect.objectContaining({ type: 'token_revoke_failed', status, id: expect.any(String) })
    );
    tokens.close();
    a.close();
    noShipping();
  }, 60000);
  it('credential cleanup fails before bound-fork policy refusal can commit a terminal state', async () => {
    let h!: ReturnType<typeof rig>;
    let missing = false;
    h = rig({
      beforeRead: async (p) => {
        if (
          !missing &&
          p === `/repos/${OWNER}/fixture` &&
          h.controller.snapshot().state === 'shipping'
        ) {
          missing = true;
          h.forkMissing();
          h.fake.override(
            `DELETE /applications/${CLIENT_ID}/token`,
            { status: 503, json: null },
            6
          );
        }
      },
    });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toThrow();
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.store.run.state).toBe('blocked_cleanup');
    expect(a.store.run.history.some((e) => e.to === 'blocked')).toBe(false);
    const tokens = new Journal(a.store.storeDirectory('tokens'));
    expect(tokens.read()).toContainEqual(
      expect.objectContaining({ type: 'token_revoke_failed', status: 503, id: expect.any(String) })
    );
    tokens.close();
    a.close();
    noShipping();
  }, 60000);
  it('publishes the final cleanup block to snapshots and observers when release fails', async () => {
    const h = rig({ checkpoint: 'plan' });
    h.fake.override(`DELETE /applications/${CLIENT_ID}/token`, { status: 503, json: null }, 3);
    await expect(h.authorize(h.controller.start(h.config))).rejects.toThrow('cleanup_incomplete');
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(h.controller.snapshot()).toEqual(a.store.run);
    a.close();
    expect((await h.controller.resume(h.controller.snapshot().runId)).state).toBe(
      'blocked_cleanup'
    );
    noShipping();
  }, 60000);
  it('does not repeatedly refresh the current token because an older token probe was unavailable', async () => {
    let h!: ReturnType<typeof rig>;
    let expired = false;
    h = rig({
      oauthExpiresIn: 1,
      beforeRead: async (p) => {
        if (
          !expired &&
          p === `/repos/${OWNER}/fixture` &&
          h.controller.snapshot().state === 'shipping'
        ) {
          expired = true;
          h.advanceClock(2000);
          h.fake.override(`GET /applications/${CLIENT_ID}/token`, { status: 503, json: null }, 1);
        }
      },
    });
    expect(((await h.authorize(h.controller.start(h.config))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    expect(h.fake.oauthCalls.filter((form) => form.grant_type === 'refresh_token')).toHaveLength(1);
    expect([...h.fake.refreshTokens.values()].filter((token) => token.live)).toEqual([]);
  }, 60000);
});
