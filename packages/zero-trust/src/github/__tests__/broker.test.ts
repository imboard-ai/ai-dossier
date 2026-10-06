import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Intent,
  IntentDriver,
  type IntentInput,
  type IntentState,
  idempotencyKey,
  replayIntents,
} from '../../intents';
import { Journal } from '../../journal';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../../state';
import { AppCredentials, type GitHubHttp } from '../app-auth';
import {
  type BrokerOptions,
  type CleanupReport,
  CredentialBrokerError,
  CredentialCleanupError,
  ForkCredentialBroker,
  MAX_REVOKE_ATTEMPTS,
  USE_WINDOW_MS,
} from '../broker';
import { replayTokens, type TokenStore, TokenVault } from '../token-journal';
import { CLIENT_ID, FORK_ID, GitHubFake, INSTALLATION_ID, OWNER, UPSTREAM_ID } from './github-fake';

const timestamp = '2026-10-06T00:00:00.000Z';
const shipping = [
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed,
].reduce(
  (run, reason) => transitionRun(run, reason, timestamp),
  createRun({ runId: 'run-1', contributor: OWNER, upstreamIssue: 'o/r#1' }, timestamp)
);
const sha = 'b'.repeat(40);
const pushInput: IntentInput = {
  contributionId: 'c-1',
  target: `fork:${FORK_ID}/refs/heads/fix`,
  operationKind: 'push_branch',
  candidateSha: sha,
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = new AppCredentials({
  appId: '12345',
  clientId: CLIENT_ID,
  clientSecret: 'fixture-client-secret',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

function intentsWith(attempts = 1, input: IntentInput = pushInput): IntentState {
  const key = idempotencyKey(input);
  const events: unknown[] = [
    { v: 1, type: 'run', run: shipping, contributionId: input.contributionId },
    { v: 1, type: 'intended', input },
    { v: 1, type: 'attempted', key },
  ];
  if (attempts === 2) events.push({ v: 1, type: 'absent', key }, { v: 1, type: 'attempted', key });
  return replayIntents(events);
}
const intentOf = (state: IntentState, input = pushInput) =>
  state.intents.get(idempotencyKey(input)) as Intent;

const dirs: string[] = [];
const journals: Journal[] = [];
afterEach(() => {
  for (const j of journals.splice(0)) j.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function journal(dir?: string): { journal: Journal; dir: string } {
  const where = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'zt-broker-'));
  if (!dir) dirs.push(where);
  const j = new Journal(where);
  journals.push(j);
  return { journal: j, dir: where };
}

class Clock {
  ms = Date.parse('2026-10-06T12:00:00.000Z');
  timers: { at: number; fire: () => void; live: boolean }[] = [];
  now = () => this.ms;
  setTimer = (ms: number, fire: () => void) => {
    const timer = { at: this.ms + ms, fire, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  async advance(ms: number): Promise<void> {
    this.ms += ms;
    for (const timer of this.timers)
      if (timer.live && timer.at <= this.ms) {
        timer.live = false;
        timer.fire();
      }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Rig {
  broker: ForkCredentialBroker;
  fake: GitHubFake;
  clock: Clock;
  store: TokenStore & { journal: Journal; dir: string };
  vault: TokenVault;
  readonly intents: IntentState;
  /** Moves the push intent to its second (retry) attempt and returns it. */
  retry(): Intent;
  blocked: CleanupReport[];
}
function rig(
  overrides: Partial<BrokerOptions> & {
    fake?: GitHubFake;
    clock?: Clock;
    dir?: string;
    intents?: IntentState;
  } = {}
): Rig {
  const clock = overrides.clock ?? new Clock();
  const fake = overrides.fake ?? new GitHubFake(clock.now);
  const { journal: j, dir } = journal(overrides.dir);
  const store = Object.assign(
    { read: () => j.read(), append: (e: unknown) => j.append(e) },
    { journal: j, dir }
  );
  const vault = overrides.vault ?? new TokenVault();
  let intents = overrides.intents ?? intentsWith();
  const blocked: CleanupReport[] = [];
  const broker = new ForkCredentialBroker({
    store: overrides.store ?? store,
    http: overrides.http ?? fake.http,
    app,
    fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
    intents: () => intents,
    vault,
    now: clock.now,
    setTimer: clock.setTimer,
    sleep: async () => undefined,
    onCleanupBlocked: (report) => {
      blocked.push(report);
      overrides.onCleanupBlocked?.(report);
    },
  });
  return {
    broker,
    fake,
    clock,
    store,
    vault,
    get intents() {
      return intents;
    },
    retry() {
      intents = intentsWith(2);
      return intentOf(intents);
    },
    blocked,
  };
}
async function ready(overrides: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(overrides);
  expect(await r.broker.recover()).toEqual({ admitted: true });
  return r;
}
const ledgerOf = (r: Rig) => replayTokens(r.store.journal.read());
const refusal = (code: string) => expect.objectContaining({ name: 'CredentialBrokerError', code });

describe('AC1 per-operation tokens narrowed to the verified fork', () => {
  it('mints one installation token bound to the journaled intent attempt, by fork id', async () => {
    const r = await ready();
    const intent = intentOf(r.intents);
    const lease = await r.broker.mintForkPush(intent, { repositoryId: FORK_ID });
    const mint = r.fake.calls.find((c) => c.path.endsWith('/access_tokens'));
    expect(mint?.body).toEqual({ repository_ids: [FORK_ID], permissions: { contents: 'write' } });
    const token = ledgerOf(r).tokens.get(lease.tokenId);
    expect(token).toMatchObject({
      kind: 'installation',
      intentKey: intent.key,
      attempt: 1,
      repositoryId: FORK_ID,
      status: 'live',
    });
    // A second token for the same attempt is refused; a retry attempt gets its own.
    await expect(r.broker.mintForkPush(intent, { repositoryId: FORK_ID })).rejects.toEqual(
      refusal('duplicate_mint')
    );
  });

  it('gives a retry attempt its own token', async () => {
    const r = await ready({ intents: intentsWith(2) });
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    expect(ledgerOf(r).tokens.get(lease.tokenId)?.attempt).toBe(2);
  });

  it('refuses any other repository, non-push or unjournaled intents before a network call', async () => {
    const r = await ready();
    const intent = intentOf(r.intents);
    await expect(r.broker.mintForkPush(intent, { repositoryId: UPSTREAM_ID })).rejects.toEqual(
      refusal('repository_not_fork')
    );
    const forged = { ...intent, candidateSha: 'c'.repeat(40) };
    await expect(r.broker.mintForkPush(forged, { repositoryId: FORK_ID })).rejects.toEqual(
      refusal('invalid_intent')
    );
    const prInput: IntentInput = { ...pushInput, operationKind: 'pr_create' };
    const prState = intentsWith(1, prInput);
    const pr = rig({ intents: prState });
    await pr.broker.recover();
    await expect(
      pr.broker.mintForkPush(intentOf(prState, prInput), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('invalid_intent'));
    expect(r.fake.calls).toEqual([]);
    expect(pr.fake.calls).toEqual([]);
  });

  it('revokes and refuses a token GitHub issued broader than requested', async () => {
    const r = await ready();
    const wide = r.fake.issue('installation');
    r.fake.override('POST /app/installations', {
      status: 201,
      json: {
        token: wide,
        expires_at: new Date(r.clock.ms + 3600_000).toISOString(),
        permissions: { contents: 'write', pull_requests: 'write' },
        repositories: [{ id: FORK_ID }],
      },
    });
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('overbroad_token'));
    expect(r.fake.live(wide)).toBe(false);
  });

  it('journals a refused mint and blocks cleanup on an uncertain one', async () => {
    const r = await ready();
    r.fake.override('POST /app/installations', { status: 422, json: null });
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('mint_refused'));
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('mint_failed');

    const u = await ready({ intents: intentsWith(2) });
    u.fake.override('POST /app/installations', 'throw');
    await expect(
      u.broker.mintForkPush(intentOf(u.intents), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('mint_uncertain'));
    expect(u.blocked).toHaveLength(1);
    expect(u.broker.status().admissions).toBe('cleanup_blocked');
  });
});

describe('AC2 15-minute use window', () => {
  it('sets the deadline from the request time, never from GitHub expiry', async () => {
    const r = await ready();
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    const token = ledgerOf(r).tokens.get(lease.tokenId);
    expect(Date.parse(lease.useBy) - r.clock.ms).toBe(USE_WINDOW_MS);
    expect(Date.parse(token?.expiresAt as string) - r.clock.ms).toBe(3600_000);
  });

  it('refuses to hand out a token after the window', async () => {
    const r = await ready();
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    r.clock.ms += USE_WINDOW_MS;
    expect(() => r.broker.take(lease)).toThrow(refusal('window_expired'));
  });

  it('revokes at the deadline even while the operation is still running', async () => {
    const r = await ready();
    let observedAbort = false;
    let release: () => void = () => undefined;
    let value = '';
    const run = r.broker.withForkPush(
      intentOf(r.intents),
      { repositoryId: FORK_ID },
      async (credential, signal) => {
        value = r.fake.calls.at(-1)?.token ?? '';
        signal.addEventListener('abort', () => {
          observedAbort = true;
        });
        expect(credential.env().GIT_CONFIG_COUNT).toBe('9');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'pushed';
      }
    );
    await r.clock.advance(1);
    const issued = [...r.fake.tokens.keys()].find((k) => k.startsWith('ghs_')) as string;
    expect(r.fake.live(issued)).toBe(true);
    await r.clock.advance(USE_WINDOW_MS);
    expect(r.fake.live(issued)).toBe(false);
    expect(observedAbort).toBe(true);
    expect(value).not.toBe(issued); // the mint call carried the App JWT, not the token
    release();
    await expect(run).resolves.toBe('pushed');
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('revoked');
  });
});

describe('AC3 revoke on every exit path', () => {
  it.each([
    ['success', async () => 'ok'],
    [
      'thrown error',
      async () => {
        throw new Error('push failed');
      },
    ],
  ])('revokes after %s', async (_label, operation) => {
    const r = await ready();
    await r.broker
      .withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, operation)
      .catch(() => undefined);
    const token = [...ledgerOf(r).tokens.values()][0];
    expect(token).toMatchObject({ status: 'revoked', verified: true });
    expect(r.fake.count('DELETE /installation/token')).toBe(1);
    expect(r.broker.status().admissions).toBe('open');
  });

  it('revokes immediately on cancellation', async () => {
    const r = await ready();
    const cancel = new AbortController();
    const run = r.broker.withForkPush(
      intentOf(r.intents),
      { repositoryId: FORK_ID },
      (_credential, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')));
          cancel.abort();
        }),
      cancel.signal
    );
    await expect(run).rejects.toThrow('cancelled');
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('revoked');
  });

  it('retries a failed revocation, then succeeds', async () => {
    const r = await ready();
    r.fake.override('DELETE /installation/token', { status: 502, json: null });
    await r.broker.withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, async () => 'ok');
    const events = r.store.journal.read() as { type: string }[];
    expect(events.filter((e) => e.type === 'token_revoke_failed')).toHaveLength(1);
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('revoked');
  });

  it('journals each failure and ends the run in blocked_cleanup after the retry budget', async () => {
    let run: RunRecord = shipping;
    const r = await ready({
      onCleanupBlocked: () => {
        run = transitionRun(run, ReasonCode.CleanupFailed, timestamp);
      },
    });
    r.fake.override('DELETE /installation/token', { status: 500, json: null }, MAX_REVOKE_ATTEMPTS);
    await expect(
      r.broker.withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, async () => 'ok')
    ).rejects.toBeInstanceOf(CredentialCleanupError);
    const events = r.store.journal.read() as { type: string; reason?: string }[];
    expect(events.filter((e) => e.type === 'token_revoke_failed')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'admissions_disabled', reason: 'cleanup_blocked' });
    expect(run.state).toBe('blocked_cleanup');
    await expect(r.broker.mintForkPush(r.retry(), { repositoryId: FORK_ID })).rejects.toEqual(
      refusal('admission_closed')
    );
  });

  it('counts a token still readable after DELETE as not revoked', async () => {
    const r = await ready();
    r.fake.override('DELETE /installation/token', { status: 204, json: null }, 3);
    await expect(
      r.broker.withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, async () => 'ok')
    ).rejects.toBeInstanceOf(CredentialCleanupError);
    expect(r.fake.count('GET /installation/repositories')).toBe(3);
  });

  it('serves pushes for intents admitted by the IntentDriver', async () => {
    const { journal: intentJournal } = journal();
    let driver: IntentDriver | undefined;
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const { journal: tokenJournal } = journal();
    const broker = new ForkCredentialBroker({
      store: tokenJournal,
      http: fake.http,
      app,
      fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
      intents: () => (driver as IntentDriver).snapshot(),
      now: clock.now,
      setTimer: clock.setTimer,
      sleep: async () => undefined,
    });
    await broker.recover();
    driver = new IntentDriver(
      intentJournal,
      {
        reconcile: async () => ({ kind: 'absent' }),
        mutate: (intent) =>
          broker.withForkPush(intent, { repositoryId: FORK_ID }, async (credential) => {
            expect(credential.env().GIT_CONFIG_KEY_8).toBe('http.https://github.com/.extraheader');
            return { artifactRef: 'refs/heads/fix', remoteSha: sha };
          }),
      },
      { run: shipping, contributionId: 'c-1' },
      () => timestamp
    );
    await expect(driver.execute(pushInput)).resolves.toBe('refs/heads/fix');
    expect(broker.status().tokens).toEqual([
      expect.objectContaining({ kind: 'installation', status: 'revoked', verified: true }),
    ]);
  });
});

describe('AC4 refuse reuse', () => {
  it('never hands out a used or revoked token again', async () => {
    const r = await ready();
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    r.broker.take(lease);
    expect(() => r.broker.take(lease)).toThrow(refusal('token_reused'));
    await r.broker.revoke(lease);
    expect(() => r.broker.take(lease)).toThrow(refusal('token_reused'));
    // Live post-revocation probe expected 401.
    const probe = r.fake.calls.at(-1);
    expect(`${probe?.method} ${probe?.path}`).toBe('GET /installation/repositories');
    expect(ledgerOf(r).tokens.get(lease.tokenId)).toMatchObject({
      status: 'revoked',
      verified: true,
    });
  });
});

describe('AC5 crash recovery', () => {
  it('admits nothing before recovery', async () => {
    const r = rig();
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('not_recovered'));
  });

  it('crash between mint and revoke: restart revokes held tokens before admission', async () => {
    const first = await ready();
    const user = first.fake.authorizeUser();
    first.broker.registerUserToken(user, new Date(first.clock.ms + 8 * 3600_000).toISOString());
    const lease = await first.broker.mintForkPush(intentOf(first.intents), {
      repositoryId: FORK_ID,
    });
    const child = await first.broker.mintForkPush(first.retry(), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    first.store.journal.close();
    const second = rig({
      dir: first.store.dir,
      vault: first.vault,
      fake: first.fake,
      clock: first.clock,
    });
    await expect(second.broker.recover()).resolves.toEqual({ admitted: true });
    const tokens = ledgerOf(second).tokens;
    expect(tokens.get(lease.tokenId)?.status).toBe('revoked');
    // The scoped child is revoked on its own, not through its parent.
    expect(tokens.get(child.tokenId)).toMatchObject({ status: 'revoked', revokedVia: 'token' });
    expect(second.fake.count(`DELETE /applications/${CLIENT_ID}/token`)).toBe(2);
    // The held user token was revoked too, which ends its refresh chain.
    expect(ledgerOf(second).reauthorizationRequired).toBe(true);
  });

  it('crash between revoke and journal write: recovery re-checks and records the revocation', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const { journal: j, dir } = journal();
    let crash = true;
    const store: TokenStore = {
      read: () => j.read(),
      append: (event) => {
        if (crash && (event as { type: string }).type === 'token_revoked')
          throw new Error('controller crashed');
        j.append(event);
      },
    };
    const vault = new TokenVault();
    const first = rig({ store, vault, fake, clock });
    await first.broker.recover();
    await expect(
      first.broker.withForkPush(
        intentOf(first.intents),
        { repositoryId: FORK_ID },
        async () => 'ok'
      )
    ).rejects.toThrow('controller crashed');
    crash = false;
    j.close();
    const second = rig({ dir, vault, fake, clock });
    await expect(second.broker.recover()).resolves.toEqual({ admitted: true });
    expect([...ledgerOf(second).tokens.values()][0]).toMatchObject({
      status: 'revoked',
      verified: true,
    });
  });

  it('full process crash: lost scoped children are ended through the grant', async () => {
    const first = await ready();
    const user = first.fake.authorizeUser();
    const expires = new Date(first.clock.ms + 8 * 3600_000).toISOString();
    first.broker.registerUserToken(user, expires);
    await first.broker.mintForkPush(intentOf(first.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const child = [...first.fake.tokens.entries()].find(([, t]) => t.kind === 'user_scoped')?.[0];
    first.store.journal.close();
    // New process: empty vault. The contributor authorizes again.
    const second = rig({ dir: first.store.dir, fake: first.fake, clock: first.clock });
    const fresh = second.fake.authorizeUser();
    second.broker.registerUserToken(fresh, expires);
    await expect(second.broker.recover()).resolves.toEqual({ admitted: true });
    expect(second.fake.live(child as string)).toBe(false);
    const ledger = ledgerOf(second);
    expect([...ledger.tokens.values()].every((t) => t.status === 'revoked')).toBe(true);
    expect(ledger.reauthorizationRequired).toBe(true);
  });

  it('full process crash: an installation token with a lost value blocks cleanup, never "revoked"', async () => {
    const first = await ready();
    await first.broker.mintForkPush(intentOf(first.intents), { repositoryId: FORK_ID });
    first.store.journal.close();
    const second = rig({ dir: first.store.dir, fake: first.fake, clock: first.clock });
    const result = await second.broker.recover();
    expect(result.admitted).toBe(false);
    expect(result.report?.action).toBe('operator_revoke_or_suspend_installation');
    expect(second.blocked).toHaveLength(1);
    expect([...ledgerOf(second).tokens.values()][0]?.status).toBe('unrevocable');
  });

  it('a crash after the mint request but before the response blocks cleanup', async () => {
    const first = await ready();
    first.fake.override('POST /app/installations', 'throw');
    await first.broker
      .mintForkPush(intentOf(first.intents), { repositoryId: FORK_ID })
      .catch(() => undefined);
    first.store.journal.close();
    const second = rig({ dir: first.store.dir, fake: first.fake, clock: first.clock });
    expect((await second.broker.recover()).admitted).toBe(false);
  });

  it('lost user-chain tokens without a live user token stay unresolved', async () => {
    const first = await ready();
    first.broker.registerUserToken(
      first.fake.authorizeUser(),
      new Date(first.clock.ms + 3600_000).toISOString()
    );
    first.store.journal.close();
    const second = rig({ dir: first.store.dir, fake: first.fake, clock: first.clock });
    const result = await second.broker.recover();
    expect(result).toMatchObject({
      admitted: false,
      report: { action: 'contributor_reauthorization_then_kill_switch_or_manual_revoke' },
    });
  });
});

describe('AC6/AC12 kill switch', () => {
  it('deletes the grant with a live token BEFORE revoking anything else', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    r.broker.registerUserToken(user, new Date(r.clock.ms + 8 * 3600_000).toISOString());
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const install = await r.broker.mintForkPush(r.retry(), {
      repositoryId: FORK_ID,
    });
    const before = r.fake.calls.length;
    const report = await r.broker.killAll();
    const after = r.fake.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    expect(after[0]).toBe(`DELETE /applications/${CLIENT_ID}/grant`);
    expect(after).not.toContain(`DELETE /applications/${CLIENT_ID}/token`);
    expect(report).toEqual({
      admissionsDisabled: true,
      grant: { deleted: true, via: expect.any(String) },
      installationTokens: { revoked: [install.tokenId], failed: [] },
      scopedTokens: { revoked: [], failed: [] },
      complete: true,
    });
    const tokens = ledgerOf(r).tokens;
    expect(tokens.get(child.tokenId)).toMatchObject({ status: 'revoked', revokedVia: 'grant' });
    expect([...r.fake.tokens.values()].every((t) => !t.live)).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(r.broker.status().admissions).toBe('kill_switch');
    expect(() => r.broker.registerUserToken(r.fake.authorizeUser(), timestamp)).toThrow(
      refusal('admission_closed')
    );
  });

  it('reports a needed re-authorization when no live user token is held', async () => {
    const r = await ready();
    await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    const report = await r.broker.killAll();
    expect(report.grant).toEqual({
      deleted: false,
      action: 'contributor_reauthorization_or_manual_revoke',
    });
    expect(report.complete).toBe(false);
    expect(r.fake.count(`DELETE /applications/${CLIENT_ID}/grant`)).toBe(0);
  });

  it('treats 404 as "grant not deleted" and skips expired candidates', async () => {
    const r = await ready();
    const stale = r.fake.authorizeUser();
    // Journal says this user token already expired: never a grant candidate.
    r.broker.registerUserToken(stale, new Date(r.clock.ms + 1000).toISOString());
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    r.clock.ms += 2000;
    r.fake.override(`DELETE /applications/${CLIENT_ID}/grant`, { status: 404, json: null });
    const report = await r.broker.killAll();
    const grantCalls = r.fake.calls.filter((c) => c.path.endsWith('/grant'));
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]?.token).not.toBe(stale);
    expect(report.grant.deleted).toBe(false);
    // Without the grant, the child is ended on its own; the parent stays for a later attempt.
    expect(report.scopedTokens).toEqual({ revoked: [child.tokenId], failed: [] });
    expect(ledgerOf(r).tokens.get(child.tokenId)).toMatchObject({
      status: 'revoked',
      revokedVia: 'token',
    });
    expect(r.fake.live(stale)).toBe(true);
    expect(report.complete).toBe(false);
    expect(r.blocked).toHaveLength(1);
  });
});

describe('AC9 scoped user tokens are independent credentials', () => {
  it('keeps a child journaled live after its parent is revoked or rotated', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    const expires = new Date(r.clock.ms + 8 * 3600_000).toISOString();
    const parentId = r.broker.registerUserToken(user, expires);
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    await r.broker.revoke(parentId);
    expect(ledgerOf(r).tokens.get(child.tokenId)?.status).toBe('live');
    const childValue = [...r.fake.tokens.entries()].find(([, t]) => t.kind === 'user_scoped')?.[0];
    expect(r.fake.live(childValue as string)).toBe(true);
    // Each child is revoked on its own with DELETE /applications/{client_id}/token.
    await r.broker.revoke(child);
    expect(r.fake.calls.at(-2)).toMatchObject({
      method: 'DELETE',
      path: `/applications/${CLIENT_ID}/token`,
      token: childValue,
    });
  });

  it('marks a rotated parent only once observed dead; children stay live', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    const expires = new Date(r.clock.ms + 8 * 3600_000).toISOString();
    const parentId = r.broker.registerUserToken(user, expires);
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const next = r.fake.refresh(user);
    await r.broker.rotateUserToken(next, expires);
    const tokens = ledgerOf(r).tokens;
    expect(tokens.get(parentId)?.status).toBe('rotated');
    expect(tokens.get(child.tokenId)?.status).toBe('live');
  });
});

describe('AC10 narrowing is one level deep', () => {
  it('refuses to scope from a scoped token before any call', async () => {
    const r = await ready();
    r.broker.registerUserToken(
      r.fake.authorizeUser(),
      new Date(r.clock.ms + 8 * 3600_000).toISOString()
    );
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const calls = r.fake.calls.length;
    await expect(
      r.broker.mintForkPush(r.retry(), { repositoryId: FORK_ID, via: 'user_scoped' }, child.tokenId)
    ).rejects.toEqual(refusal('scope_from_scoped'));
    expect(r.fake.calls.length).toBe(calls);
    expect(ledgerOf(r).tokens.size).toBe(2);
  });

  it('scopes every child from the unscoped user token', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    const parentId = r.broker.registerUserToken(
      user,
      new Date(r.clock.ms + 8 * 3600_000).toISOString()
    );
    const lease = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const scoped = r.fake.calls.find((c) => c.path.endsWith('/token/scoped'));
    expect(scoped?.token).toBe(user);
    expect(scoped?.body).toMatchObject({
      target: OWNER,
      repository_ids: [FORK_ID],
      permissions: { contents: 'write' },
    });
    expect(ledgerOf(r).tokens.get(lease.tokenId)?.parentId).toBe(parentId);
  });
});

describe('AC11 the user token is revoked only at run end', () => {
  it('keeps it across operations and revokes it last at run end', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    const parentId = r.broker.registerUserToken(
      user,
      new Date(r.clock.ms + 8 * 3600_000).toISOString()
    );
    await r.broker.withForkPush(
      intentOf(r.intents),
      { repositoryId: FORK_ID, via: 'user_scoped' },
      async () => 'ok'
    );
    expect(r.fake.live(user)).toBe(true);
    expect(ledgerOf(r).tokens.get(parentId)?.status).toBe('live');
    await r.broker.mintForkPush(r.retry(), { repositoryId: FORK_ID });
    await r.broker.endRun();
    const deletes = r.fake.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.at(-1)?.token).toBe(user);
    expect(r.fake.tokens.get(user)?.refreshAlive).toBe(false);
    const ledger = ledgerOf(r);
    expect(ledger.reauthorizationRequired).toBe(true);
    expect([...ledger.tokens.values()].every((t) => t.status === 'revoked')).toBe(true);
    expect(r.broker.status().admissions).toBe('run_ended');
  });

  it('ends the run in blocked_cleanup when a revocation cannot be completed', async () => {
    const r = await ready();
    await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    r.fake.override('DELETE /installation/token', 'throw', MAX_REVOKE_ATTEMPTS);
    await expect(r.broker.endRun()).rejects.toBeInstanceOf(CredentialCleanupError);
    expect(r.blocked).toHaveLength(1);
  });
});

describe('AC7 secrecy', () => {
  it('keeps token values out of the journal, status, errors and inspection', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    r.broker.registerUserToken(user, new Date(r.clock.ms + 8 * 3600_000).toISOString());
    let credentialText = '';
    let envText = '';
    await r.broker
      .withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, async (credential) => {
        credentialText = `${JSON.stringify(credential)} ${inspect(credential)} ${String(credential)}`;
        envText = credential.env().GIT_CONFIG_VALUE_8;
        throw new Error('push rejected');
      })
      .catch((error: Error) => {
        expect(error.message).toBe('push rejected');
      });
    const secrets = [...r.fake.tokens.keys()];
    const journalBytes = fs.readFileSync(path.join(r.store.dir, 'events.jsonl'), 'utf8');
    const surfaces = [
      journalBytes,
      JSON.stringify(r.broker.status()),
      credentialText,
      inspect(r.vault),
      JSON.stringify(r.vault),
      inspect(app),
      JSON.stringify(app),
    ];
    for (const secret of secrets) for (const text of surfaces) expect(text).not.toContain(secret);
    expect(journalBytes).not.toMatch(/gh[su]_/u);
    expect(envText).toMatch(/^Authorization: Basic /u);
    const error = await r.broker
      .mintForkPush(intentOf(r.intents), { repositoryId: UPSTREAM_ID })
      .catch((e: Error) => e);
    expect(String((error as Error).message)).toBe('Credential broker refused: repository_not_fork');
  });

  it('supplies git credentials only through env config with helpers and global config off', async () => {
    const r = await ready();
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    const env = r.broker.take(lease).env();
    const value = [...r.fake.tokens.keys()].find((k) => k.startsWith('ghs_')) as string;
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TRACE_REDACT: '1',
      GIT_CONFIG_COUNT: '9',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      // Repository config and hooks cannot redirect, proxy or read the header.
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'http.sslVerify',
      GIT_CONFIG_VALUE_3: 'true',
      GIT_CONFIG_KEY_4: 'http.proxy',
      GIT_CONFIG_VALUE_4: '',
      GIT_CONFIG_KEY_5: 'http.followRedirects',
      GIT_CONFIG_VALUE_5: 'false',
      GIT_CONFIG_KEY_6: 'protocol.allow',
      GIT_CONFIG_VALUE_6: 'never',
      GIT_CONFIG_KEY_7: 'protocol.https.allow',
      GIT_CONFIG_VALUE_7: 'always',
      GIT_CONFIG_KEY_8: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_8: `Authorization: Basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`,
    });
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('broker construction', () => {
  it('rejects an unverified fork binding', () => {
    const clock = new Clock();
    const { journal: j } = journal();
    expect(
      () =>
        new ForkCredentialBroker({
          store: j,
          http: new GitHubFake(clock.now).http,
          app,
          fork: { repositoryId: 0, installationId: INSTALLATION_ID, owner: OWNER },
          intents: () => intentsWith(),
        })
    ).toThrow(CredentialBrokerError);
  });

  it('latches closed when the journal fails', async () => {
    const r = await ready();
    const spy = vi.spyOn(r.store.journal, 'append').mockImplementation(() => {
      throw new Error('disk gone');
    });
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID })
    ).rejects.toThrow('disk gone');
    spy.mockRestore();
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('admission_closed'));
    expect(r.broker.status().admissions).toBe('journal_failed');
  });
});

/** An HTTP wrapper that holds requests matching `match` until released. */
function gated(fake: GitHubFake, match: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const http: GitHubHttp = async (request) => {
    if (`${request.method} ${request.path}`.startsWith(match)) {
      entered();
      await gate;
    }
    return fake.http(request);
  };
  return { http, release, reached };
}

describe('review regressions: races and fail-closed paths', () => {
  it('a cancel that arrives during the mint revokes the token and runs nothing', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const g = gated(fake, 'POST /app/installations');
    const r = await ready({ fake, clock, http: g.http });
    const cancel = new AbortController();
    let ran = false;
    const run = r.broker.withForkPush(
      intentOf(r.intents),
      { repositoryId: FORK_ID },
      async () => {
        ran = true;
      },
      cancel.signal
    );
    await g.reached;
    cancel.abort();
    g.release();
    await expect(run).rejects.toEqual(refusal('cancelled'));
    expect(ran).toBe(false);
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('revoked');
  });

  it('the kill switch waits for an in-flight mint, then revokes its token', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const g = gated(fake, 'POST /app/installations');
    const r = await ready({ fake, clock, http: g.http });
    const mint = r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    await g.reached;
    const kill = r.broker.killAll();
    g.release();
    await expect(mint).rejects.toEqual(refusal('admission_closed'));
    const report = await kill;
    expect([...fake.tokens.values()].some((t) => t.live)).toBe(false);
    expect([...ledgerOf(r).tokens.values()][0]?.status).toBe('revoked');
    expect(report.installationTokens.failed).toEqual([]);
    expect(r.broker.status().admissions).toBe('kill_switch');
  });

  it('refuses to hand out a credential whose revocation is in flight', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const g = gated(fake, 'DELETE /installation/token');
    const r = await ready({ fake, clock, http: g.http });
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    const revoking = r.broker.revoke(lease);
    await g.reached;
    expect(() => r.broker.take(lease)).toThrow(refusal('token_reused'));
    g.release();
    await revoking;
  });

  it('a grant deletion during an individual revocation does not latch the broker', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const g = gated(fake, `DELETE /applications/${CLIENT_ID}/token`);
    const r = await ready({ fake, clock, http: g.http });
    r.broker.registerUserToken(
      fake.authorizeUser(),
      new Date(clock.ms + 8 * 3600_000).toISOString()
    );
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    const revoking = r.broker.revoke(child);
    await g.reached;
    const report = await r.broker.killAll();
    g.release();
    await expect(revoking).resolves.toBeUndefined();
    expect(report.complete).toBe(true);
    expect(ledgerOf(r).tokens.get(child.tokenId)).toMatchObject({ revokedVia: 'grant' });
    expect(r.broker.status().admissions).toBe('kill_switch');
  });

  it('a DELETE answered 204 still fails when the liveness read is not 401', async () => {
    const r = await ready();
    const lease = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    r.fake.override('GET /installation/repositories', { status: 500, json: null }, 3);
    await expect(r.broker.revoke(lease)).rejects.toBeInstanceOf(CredentialCleanupError);
    const failures = (
      r.store.journal.read() as { type: string; stage?: string; status?: number }[]
    ).filter((e) => e.type === 'token_revoke_failed');
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({ stage: 'probe', status: 500 });
    expect(r.blocked).toHaveLength(1);
  });

  it('an App key that cannot sign is refused without a request or a cleanup block', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const { journal: j } = journal();
    const broker = new ForkCredentialBroker({
      store: j,
      http: fake.http,
      app: new AppCredentials({
        appId: '1',
        clientId: CLIENT_ID,
        clientSecret: 's',
        privateKey: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----',
      }),
      fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
      intents: () => intentsWith(),
      now: clock.now,
    });
    await broker.recover();
    await expect(
      broker.mintForkPush(intentOf(intentsWith()), { repositoryId: FORK_ID })
    ).rejects.toEqual(refusal('app_credentials_invalid'));
    expect(fake.calls).toEqual([]);
    expect(broker.status()).toMatchObject({
      admissions: 'open',
      tokens: [expect.objectContaining({ status: 'mint_failed' })],
    });
  });

  it('refuses a scoped token GitHub did not confirm as repository-selected', async () => {
    const r = await ready();
    r.broker.registerUserToken(
      r.fake.authorizeUser(),
      new Date(r.clock.ms + 8 * 3600_000).toISOString()
    );
    const wide = r.fake.issue('user_scoped');
    r.fake.override(`POST /applications/${CLIENT_ID}/token/scoped`, {
      status: 200,
      json: {
        token: wide,
        expires_at: new Date(r.clock.ms + 8 * 3600_000).toISOString(),
        installation: {
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'all',
        },
      },
    });
    await expect(
      r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID, via: 'user_scoped' })
    ).rejects.toEqual(refusal('overbroad_token'));
    expect(r.fake.live(wide)).toBe(false);
  });

  it('a rotation that finishes after the kill switch holds no new token', async () => {
    const clock = new Clock();
    const fake = new GitHubFake(clock.now);
    const g = gated(fake, 'GET /user');
    const r = await ready({ fake, clock, http: g.http });
    const user = fake.authorizeUser();
    const expires = new Date(clock.ms + 8 * 3600_000).toISOString();
    r.broker.registerUserToken(user, expires);
    const rotation = r.broker.rotateUserToken(fake.refresh(user), expires);
    await g.reached;
    await r.broker.killAll();
    g.release();
    await expect(rotation).rejects.toEqual(refusal('admission_closed'));
    expect(ledgerOf(r).tokens.size).toBe(1);
  });

  it('run end deletes the grant while the parent lives when a child will not die', async () => {
    const r = await ready();
    const user = r.fake.authorizeUser();
    r.broker.registerUserToken(user, new Date(r.clock.ms + 8 * 3600_000).toISOString());
    const child = await r.broker.mintForkPush(intentOf(r.intents), {
      repositoryId: FORK_ID,
      via: 'user_scoped',
    });
    r.fake.override(`DELETE /applications/${CLIENT_ID}/token`, { status: 500, json: null }, 3);
    await r.broker.endRun();
    const ledger = ledgerOf(r);
    expect(ledger.tokens.get(child.tokenId)).toMatchObject({
      status: 'revoked',
      revokedVia: 'grant',
    });
    expect([...r.fake.tokens.values()].every((t) => !t.live)).toBe(true);
    expect(ledger.reauthorizationRequired).toBe(true);
  });

  it('recovery after a closed run admits nothing', async () => {
    const first = await ready();
    await first.broker.endRun();
    first.store.journal.close();
    const second = rig({ dir: first.store.dir, fake: first.fake, clock: first.clock });
    await expect(second.broker.recover()).resolves.toEqual({
      admitted: false,
      closedBy: 'run_ended',
    });
  });

  it('keeps the operation error when cleanup also fails', async () => {
    const r = await ready();
    r.fake.override('DELETE /installation/token', { status: 500, json: null }, 3);
    const error = await r.broker
      .withForkPush(intentOf(r.intents), { repositoryId: FORK_ID }, async () => {
        throw new Error('push failed');
      })
      .catch((e: CredentialCleanupError) => e);
    expect(error).toBeInstanceOf(CredentialCleanupError);
    expect((error as CredentialCleanupError).operationError).toEqual(new Error('push failed'));
    expect((error as CredentialCleanupError).report?.outstanding).toHaveLength(1);
    expect(Object.keys(error as object)).not.toContain('operationError');
  });

  it('a closed broker cannot write to the journal its successor owns', async () => {
    const first = await ready();
    await first.broker.mintForkPush(intentOf(first.intents), { repositoryId: FORK_ID });
    first.broker.close();
    await first.clock.advance(USE_WINDOW_MS);
    expect([...ledgerOf(first).tokens.values()][0]?.status).toBe('live');
    expect(first.fake.count('DELETE')).toBe(0);
  });

  it('refuses to scope from an installation token without latching', async () => {
    const r = await ready();
    r.broker.registerUserToken(
      r.fake.authorizeUser(),
      new Date(r.clock.ms + 8 * 3600_000).toISOString()
    );
    const install = await r.broker.mintForkPush(intentOf(r.intents), { repositoryId: FORK_ID });
    await expect(
      r.broker.mintForkPush(
        r.retry(),
        { repositoryId: FORK_ID, via: 'user_scoped' },
        install.tokenId
      )
    ).rejects.toEqual(refusal('no_user_token'));
    expect(r.broker.status().admissions).toBe('open');
    expect(() => r.broker.registerUserToken(r.fake.authorizeUser(), timestamp)).toThrow(
      refusal('user_token_held')
    );
  });
});
