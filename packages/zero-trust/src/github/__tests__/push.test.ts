/** #1066: verified expected-SHA (CAS) push. Git mechanics run against a local bare
 * repository standing in for the fork (`push-rig.ts`); ref reads go through an HTTP fake
 * that answers from that repository. No network, no real credentials. */
import { describe, expect, it, vi } from 'vitest';
import { TrustedGit } from '../../canonical/trusted-git';
import {
  type Intent,
  idempotencyKey,
  MutationDeferredError,
  MutationUncertainError,
  MutationVoidedError,
  ReconcileDeferredError,
  replayIntents,
  WriteBlockedError,
} from '../../intents';
import { Journal } from '../../journal';
import { ReceiptNonceStore } from '../../receipt/nonces';
import { ReceiptError } from '../../receipt/schema';
import { evaluateBoundary } from '../../vm/evidence';
import { CredentialBrokerError, type ForkCredentialBroker } from '../broker';
import { ForkRefError, forkTarget, parseForkTarget, readForkBranch } from '../fork-ref';
import type { HandoffAdmission } from '../handoff-driver';
import { ForkPushError, replayPushes } from '../push';
import type { GitHubRead, GitHubResponse } from '../reconcile';
import { FORK_ID, OWNER, UPSTREAM_ID } from './github-fake';
import {
  BRANCH,
  C1,
  C2,
  DIGEST,
  FORK,
  type Grant,
  HELD_BOUNDARY,
  journals,
  MINT,
  pushOf,
  Rig,
  rig,
  SHA1,
  SHA2,
  TARGET,
  temp,
} from './push-rig';

/** The credential reached git, but the push died before anything was sent (the process
 * was lost mid-flight): the outcome is genuinely ambiguous until reconciled. */
const lostInFlight =
  (inner: ForkCredentialBroker['withForkPush']): ForkCredentialBroker['withForkPush'] =>
  (intent, target, operation, cancel) =>
    inner(intent, target, (credential) => operation(credential, AbortSignal.abort()), cancel);

describe('verified CAS push to the fork (#1066)', () => {
  it('pushes exactly the candidate under a fork-only lease, persisting expected first (AC2/AC4)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    let ledgerAtPush: string[] = [];
    r.wrap = (inner) => async (intent, target, operation, cancel) =>
      inner(
        intent,
        target,
        (credential, signal) => {
          ledgerAtPush = r.events();
          return operation(credential, signal);
        },
        cancel
      );
    const exec = vi.spyOn(TrustedGit.prototype, 'execAsync');
    expect(r.pusher.expectedRemoteSha(pushOf(SHA1))).toBeNull();
    const ref = await r.driver.execute(pushOf(SHA1));
    expect(ref).toBe(`${TARGET}@${SHA1}`);
    expect(r.fork.sha()).toBe(SHA1);
    expect(ledgerAtPush).toEqual(['push_intended']);
    expect(r.events()).toEqual(['push_intended', 'push_verified']);
    expect(r.ledger.read()[0]).toMatchObject({
      branch: BRANCH,
      candidateSha: SHA1,
      expectedRemoteSha: null,
      attempt: 1,
    });
    const push = exec.mock.calls.map(([args]) => args).find((args) => args[0] === 'push') ?? [];
    expect(push).toEqual([
      'push',
      '--porcelain',
      '--no-verify',
      '--no-follow-tags',
      `--force-with-lease=refs/heads/${BRANCH}:`,
      `file://${r.fork.dir}`,
      `${SHA1}:refs/heads/${BRANCH}`,
    ]);
    expect(push.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('+'))).toBe(
      false
    );
    // One fork-limited token, revoked after use.
    expect(r.mints()).toBe(1);
    expect(r.broker.status().tokens.map((t) => t.status)).toEqual(['revoked']);
    expect(r.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.status).toBe('confirmed');
    // Idempotent: a confirmed push is never repeated.
    expect(await r.driver.execute(pushOf(SHA1))).toBe(ref);
    expect(r.mints()).toBe(1);
  });

  it('confirms without a token when the remote already holds the candidate', async () => {
    const r = await rig();
    r.fork.git(['index-pack', '--stdin'], C1.pack);
    r.fork.git(['update-ref', `refs/heads/${BRANCH}`, SHA1]);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.mints()).toBe(0);
    // Nothing to push, so nothing was authorized: the receipt is still unspent.
    expect(r.events()).toEqual(['push_verified']);
    expect(r.grants).toHaveLength(1);
  });

  it('blocks remote_diverged at preflight and pushes nothing (scenario 18, AC3)', async () => {
    const r = await rig();
    const other = r.fork.outOfBand();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteBlockedError);
    expect((error as Error).cause).toMatchObject({ detail: `expected=absent,observed=${other}` });
    expect(r.driver.snapshot().blockedReason).toBe('remote_diverged');
    expect(r.fork.sha()).toBe(other);
    expect(r.mints()).toBe(0);
    expect(replayIntents(journals[2]?.read() ?? [])).toEqual(r.driver.snapshot());
  });

  it('a stale lease is rejected when the branch moves after preflight (decision row 4b)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    let other = '';
    r.wrap = (inner) => async (intent, target, operation, cancel) =>
      inner(
        intent,
        target,
        async (credential, signal) => {
          // Out-of-band commit between the preflight read and the push.
          other = r.fork.outOfBand();
          return operation(credential, signal);
        },
        cancel
      );
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('remote_diverged');
    // The lease held: the remote stays at the out-of-band SHA.
    expect(r.fork.sha()).toBe(other);
    expect(r.mints()).toBe(1);
    expect(r.broker.status().tokens.map((t) => t.status)).toEqual(['revoked']);
  });

  it('push-then-crash before the journal write reconciles as done (AC5)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap =
      (inner) =>
      async (...args) => {
        await inner(...args);
        throw new Error('controller lost the push response');
      };
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    expect(r.fork.sha()).toBe(SHA1);
    expect(r.events()).toEqual(['push_intended']);
    const restarted = await r.restart();
    await restarted.driver.resume();
    expect(restarted.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.status).toBe(
      'confirmed'
    );
    expect(await restarted.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(restarted.events()).toEqual(['push_intended', 'push_verified']);
    // No second push: the restarted broker never minted.
    expect(restarted.mints()).toBe(0);
  });

  it('remote still at expected after a lost response retries once, with a fresh receipt (AC5)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = lostInFlight;
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    const restarted = await r.restart();
    await restarted.driver.resume();
    const intent = restarted.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1))) as Intent;
    expect(intent).toMatchObject({ status: 'ambiguous', retryReady: true, attempts: 1 });
    restarted.grants.push({ candidate: C1, expected: null, nonce: 'nonce-2' });
    expect(await restarted.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(restarted.fork.sha()).toBe(SHA1);
    expect(restarted.ledger.read()).toMatchObject([
      { type: 'push_intended', attempt: 1, expectedRemoteSha: null },
      { type: 'push_intended', attempt: 2, expectedRemoteSha: null },
      { type: 'push_verified', remoteSha: SHA1 },
    ]);
  });

  it('a retry with the already-consumed receipt is a replay and is refused before minting', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = lostInFlight;
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.wrap = (inner) => inner;
    await r.driver.resume();
    const minted = r.mints();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect((error as Error).cause).toMatchObject({ detail: 'replayed_nonce' });
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.fork.sha()).toBeNull();
    expect(r.mints()).toBe(minted);
  });

  it('a lost response with unexpected remote content blocks on resume (scenario 18)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = lostInFlight;
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.fork.outOfBand();
    const restarted = await r.restart();
    await expect(restarted.driver.resume()).rejects.toThrow(WriteBlockedError);
    expect(restarted.driver.snapshot().blockedReason).toBe('remote_diverged');
  });

  it('rewrites a revision with the same CAS against the previously verified SHA (AC6)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    // The rebased revision expects exactly the previously verified SHA.
    expect(r.pusher.expectedRemoteSha(pushOf(SHA2))).toBe(SHA1);
    const exec = vi.spyOn(TrustedGit.prototype, 'execAsync');
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    expect(await r.driver.execute(pushOf(SHA2))).toBe(`${TARGET}@${SHA2}`);
    expect(r.fork.sha()).toBe(SHA2);
    const push = exec.mock.calls.map(([args]) => args).find((args) => args[0] === 'push');
    expect(push).toContain(`--force-with-lease=refs/heads/${BRANCH}:${SHA1}`);
    expect(r.pusher.expectedRemoteSha({ ...pushOf(SHA1), candidateSha: 'd'.repeat(40) })).toBe(
      SHA2
    );
  });

  it('refuses a rewrite whose receipt does not bind the previously verified SHA (no blind force)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    r.grants.push({ candidate: C2, expected: null, nonce: 'nonce-2' });
    await expect(r.driver.execute(pushOf(SHA2))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.fork.sha()).toBe(SHA1);
    expect(r.mints()).toBe(1);
  });

  it.each<[string, string, (g: Grant) => Grant]>([
    [
      'wrong parent',
      'wrong_baseSha',
      (g) => ({ ...g, receipt: { baseSha: 'e'.repeat(40), parentSha: 'e'.repeat(40) } }),
    ],
    [
      'wrong contributor',
      'wrong_contributor',
      (g) => ({ ...g, receipt: { contributor: 'mallory' } }),
    ],
    ['changed candidate SHA', 'invalid_candidate', (g) => ({ ...g, candidate: C2 })],
    [
      'candidate on another parent',
      'invalid_candidate',
      (g) => ({ ...g, context: { parentSha: 'e'.repeat(40) } }),
    ],
    [
      'wrong fork',
      'wrong_forkRepositoryId',
      (g) => ({ ...g, receipt: { forkRepositoryId: FORK_ID + 1 } }),
    ],
    [
      'wrong upstream',
      'wrong_upstreamRepositoryId',
      (g) => ({ ...g, receipt: { upstreamRepositoryId: UPSTREAM_ID + 1 } }),
    ],
    [
      'unverified candidate (failed check)',
      'unverified',
      (g) => ({
        ...g,
        receipt: {
          commands: [
            {
              id: 'regression',
              command: 'npm test',
              required: true,
              status: 'failed',
              exitStatus: 1,
              suites: 3,
              sanitizedLogDigest: DIGEST,
            },
          ],
        },
      }),
    ],
    [
      'policy denies shipping',
      'policy_denied',
      (g) => ({ ...g, context: { policyPermitsShipping: false } }),
    ],
    [
      'the isolation boundary was breached (#1076)',
      'boundary_not_held',
      (g) => ({
        ...g,
        context: {
          boundaryEvidence: evaluateBoundary({ ...HELD_BOUNDARY, listenerConnections: 1 }),
        },
      }),
    ],
    [
      'a probe report was malformed (#1076)',
      'boundary_not_held',
      (g) => ({
        ...g,
        context: { boundaryEvidence: evaluateBoundary({ ...HELD_BOUNDARY, malformedReports: 1 }) },
      }),
    ],
    [
      "the boundary evidence is another run's (#1076)",
      'boundary_wrong_run',
      (g) => ({
        ...g,
        context: { boundaryEvidence: evaluateBoundary({ ...HELD_BOUNDARY, runId: 'other-run' }) },
      }),
    ],
    [
      'the boundary evidence is missing (#1076)',
      'boundary_evidence_missing',
      (g) => ({ ...g, context: { boundaryEvidence: null as never } }),
    ],
  ])('refuses %s before minting a token (scenarios 10/17, AC1/AC7)', async (_name, code, mutate) => {
    const r = await rig();
    r.grants.push(mutate({ candidate: C1, expected: null, nonce: 'nonce-1' }));
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteBlockedError);
    expect((error as Error).cause).toMatchObject({ reason: 'authorization_refused', detail: code });
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.mints()).toBe(0);
    expect(r.fork.sha()).toBeNull();
    expect(r.events()).toEqual([]);
  });

  it('consumes the single-use nonce for the journaled attempt (AC1)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    const rows = new Journal(r.dirs.nonces);
    journals.push(rows);
    expect(rows.read().slice(1)).toEqual([
      expect.objectContaining({
        nonce: 'nonce-1',
        operationKey: idempotencyKey(pushOf(SHA1)),
        attempt: 1,
      }),
    ]);
  });

  it('reads back from the git server, so a trailing API read cannot fail a landed push', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    // The API keeps answering "absent" after the preflight; ls-remote sees the push.
    r.fork.overrides.push((p) =>
      p.includes('/git/ref/') && r.fork.refReads() > 1 ? { status: 404, body: null } : undefined
    );
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.fork.refReads()).toBe(1);
  });

  it('an aborted lease kills the push and leaves the attempt to reconciliation', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = (inner) => async (intent, target, operation, cancel) =>
      inner(intent, target, (credential) => operation(credential, AbortSignal.abort()), cancel);
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationUncertainError);
    expect((error as Error).cause).toMatchObject({ code: 'push_uncertain', detail: 'killed' });
    expect(r.fork.sha()).toBeNull();
    expect(r.events()).toEqual(['push_intended']);
    // The remote still holds the expected value: the one retry is admitted.
    await r.driver.resume();
    expect(r.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.retryReady).toBe(true);
  });

  it('transient failures before the write never spend the retry budget or block', async () => {
    const r = await rig();
    const key = idempotencyKey(pushOf(SHA1));
    const unspent = () =>
      expect(r.driver.snapshot().intents.get(key)).toMatchObject({
        status: 'intended',
        attempts: 0,
      });
    // 1. Rate-limited preflight, three times in a row.
    let limited = 3;
    r.fork.overrides.push((p) =>
      p.includes('/git/ref/') && limited-- > 0
        ? { status: 403, body: { message: 'rate limit' } }
        : undefined
    );
    for (let i = 0; i < 3; i++)
      await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow('ref_unknown:403');
    unspent();
    // 2. The controller could not produce an authorization.
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationDeferredError);
    unspent();
    // 3. The nonce store's lock was busy: nothing was consumed.
    const consume = vi.spyOn(ReceiptNonceStore.prototype, 'consume').mockImplementationOnce(() => {
      throw new ReceiptError('store_locked');
    });
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow('store_locked');
    unspent();
    consume.mockRestore();
    expect(r.driver.snapshot().blockedReason).toBeUndefined();
    expect(r.mints()).toBe(0);
    expect(replayIntents(journals[2]?.read() ?? [])).toEqual(r.driver.snapshot());
    // Then it goes through on the first counted attempt, with the same nonce.
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.driver.snapshot().intents.get(key)?.attempts).toBe(1);
  });

  it('a failing nonce store never exhausts the retry: a failed append is ambiguous once, then defers', async () => {
    const r = await rig();
    const key = idempotencyKey(pushOf(SHA1));
    // The append itself fails (the nonce may be consumed): one counted, ambiguous attempt.
    const consume = vi.spyOn(ReceiptNonceStore.prototype, 'consume').mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    await r.driver.resume();
    // The store stays poisoned: every later attempt is refused before any append.
    consume.mockImplementation(() => {
      throw new ReceiptError('persistence_uncertain');
    });
    for (let i = 0; i < 3; i++) {
      r.grants.push({ candidate: C1, expected: null, nonce: `nonce-${i + 2}` });
      await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationDeferredError);
      await r.driver.resume();
    }
    expect(r.driver.snapshot().intents.get(key)).toMatchObject({ attempts: 1, retryReady: true });
    expect(r.driver.snapshot().blockedReason).toBeUndefined();
    expect(r.mints()).toBe(0);
    consume.mockRestore();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-9' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
  });

  it('never pushes to a repository whose id is not the bound fork', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.fork.overrides.push((p) =>
      p === `/repos/${OWNER}/fixture` ? { status: 200, body: { id: FORK_ID + 1 } } : undefined
    );
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('fork_unverified');
    expect(r.mints()).toBe(0);
    expect(r.fork.sha()).toBeNull();
  });

  it('an unreadable remote on resume defers without journaling or blocking', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = lostInFlight;
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.wrap = (inner) => inner;
    let limited = true;
    r.fork.overrides.push((p) =>
      limited && p.includes('/git/ref/')
        ? { status: 403, body: { message: 'rate limit' } }
        : undefined
    );
    const before = journals.map((j) => j.read().length);
    await expect(r.driver.resume()).rejects.toThrow(ReconcileDeferredError);
    await expect(r.driver.resume()).rejects.toThrow('ref_unknown:403');
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(ReconcileDeferredError);
    expect(r.driver.snapshot().blockedReason).toBeUndefined();
    expect(journals.map((j) => j.read().length)).toEqual(before);
    limited = false;
    r.fork.overrides.push((p) => (p === `/repos/${OWNER}/fixture` ? 'throw' : undefined));
    await expect(r.driver.resume()).rejects.toThrow(ReconcileDeferredError);
    r.fork.overrides.pop();
    // Readable again: still absent, so the one retry is admitted.
    await r.driver.resume();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-2' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
  });

  it('failed token mints void the attempt: unblocked, budget kept, fresh receipt required', async () => {
    const r = await rig();
    const key = idempotencyKey(pushOf(SHA1));
    // GitHub refuses the installation-token mint twice in a row.
    r.fake.override(MINT, { status: 422, json: { message: 'synthetic refusal' } }, 2);
    for (const nonce of ['nonce-1', 'nonce-2']) {
      r.grants.push({ candidate: C1, expected: null, nonce });
      const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MutationVoidedError);
      expect((error as MutationVoidedError).reason).toBe('mint:mint_refused');
      expect((error as Error).cause).toMatchObject({ code: 'mint_refused' });
      await r.driver.resume();
    }
    expect(r.driver.snapshot().blockedReason).toBeUndefined();
    expect(r.driver.snapshot().intents.get(key)).toMatchObject({
      status: 'ambiguous',
      retryReady: true,
      attempts: 2,
      voided: 2,
    });
    expect(r.fork.sha()).toBeNull();
    // A spent receipt is not reusable: its nonce was consumed by the voided attempt.
    const replay = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(MutationDeferredError); // no authorization prepared yet
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-3' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.driver.snapshot().intents.get(key)).toMatchObject({ attempts: 3, voided: 2 });
    expect(replayIntents(journals[2]?.read() ?? [])).toEqual(r.driver.snapshot());
  });

  it('a broker invariant failure before hand-out is not voided: it counts', async () => {
    const r = await rig();
    r.wrap = () => async () => {
      throw new CredentialBrokerError('duplicate_mint');
    };
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MutationUncertainError);
    expect((error as Error).cause).toMatchObject({ code: 'duplicate_mint' });
    expect(r.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.voided).toBeUndefined();
  });

  it('a voided attempt never accepts its spent receipt again', async () => {
    const r = await rig();
    r.fake.override(MINT, { status: 422, json: { message: 'synthetic refusal' } }, 1);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationVoidedError);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    const error = await r.driver.execute(pushOf(SHA1)).catch((e: unknown) => e);
    expect((error as Error).cause).toMatchObject({ detail: 'replayed_nonce' });
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.mints()).toBe(1);
    expect(r.fork.sha()).toBeNull();
  });

  it('voided attempts are bounded: once every attempt number is spent the run blocks', async () => {
    const r = await rig();
    r.fake.override(MINT, { status: 422, json: { message: 'synthetic refusal' } }, 3);
    for (let i = 1; i <= 3; i++) {
      r.grants.push({ candidate: C1, expected: null, nonce: `nonce-${i}` });
      await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationVoidedError);
    }
    // Two attempt numbers remain (the budget); a lost one still allows the retry.
    r.wrap = lostInFlight;
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-4' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.wrap = (inner) => inner;
    await r.driver.resume();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-5' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))).toMatchObject({
      attempts: 5,
      voided: 3,
    });
  });

  it('a second lost response exhausts the single retry and blocks (scenario 18)', async () => {
    const r = await rig();
    r.wrap = lostInFlight;
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    await r.driver.resume();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-2' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    await expect(r.driver.resume()).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('retry_exhausted');
    expect(r.fork.sha()).toBeNull();
  });

  it('a lost push ledger fails closed: the rewrite expects absent and the remote diverges', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    // A restart with the same fork, intents, tokens and nonces, but the push ledger is gone.
    r.broker.close();
    for (const j of journals.splice(0)) j.close();
    const lost = await new Rig({
      fork: r.fork,
      dirs: { ...r.dirs, pushes: temp('zt-pushes-lost-') },
    } as Rig).start();
    expect(lost.pusher.expectedRemoteSha(pushOf(SHA2))).toBeNull();
    lost.grants.push({ candidate: C2, expected: null, nonce: 'nonce-2' });
    await expect(lost.driver.execute(pushOf(SHA2))).rejects.toThrow(WriteBlockedError);
    expect(lost.driver.snapshot().blockedReason).toBe('remote_diverged');
    expect(lost.fork.sha()).toBe(SHA1);
  });

  it('provides the hand-off read-back: verified SHA, null when absent, refused otherwise', async () => {
    const r = await rig();
    const admission: HandoffAdmission['remoteBranchSha'] = r.pusher.handoffReadBack(TARGET);
    expect(await admission()).toBeNull();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    expect(await admission()).toBe(SHA1);
    r.fork.outOfBand();
    await expect(admission()).rejects.toThrow(ForkPushError);
    await expect(r.pusher.remoteBranchSha(`fork:${FORK_ID + 1}:branch:${BRANCH}`)).rejects.toThrow(
      ForkRefError
    );
  });

  it('only handles push_branch and rejects a corrupt or foreign ledger', async () => {
    const r = await rig();
    const intended = {
      v: 1,
      type: 'push_intended',
      key: 'k',
      repositoryId: FORK_ID,
      attempt: 1,
      branch: BRANCH,
      candidateSha: SHA1,
      expectedRemoteSha: null,
    };
    expect(() =>
      r.pusher.expectedRemoteSha({ ...pushOf(SHA1), operationKind: 'pr_update' })
    ).toThrow(ForkPushError);
    expect(() =>
      replayPushes(
        [
          intended,
          {
            v: 1,
            type: 'push_verified',
            key: 'k',
            repositoryId: FORK_ID,
            branch: BRANCH,
            remoteSha: SHA2,
          },
        ],
        FORK_ID
      )
    ).toThrow('invalid_ledger (event 1)');
    expect(() =>
      replayPushes([{ v: 1, type: 'push_forced', key: 'k', repositoryId: FORK_ID }], FORK_ID)
    ).toThrow(ForkPushError);
    // A ledger written for another fork never drives this one's lease or read-back.
    expect(replayPushes([intended], FORK_ID).intended.size).toBe(1);
    expect(() => replayPushes([intended], FORK_ID + 1)).toThrow(ForkPushError);
    // A retry must repeat its first attempt's branch, candidate and expected SHA.
    expect(() =>
      replayPushes([intended, { ...intended, attempt: 2, expectedRemoteSha: SHA2 }], FORK_ID)
    ).toThrow(ForkPushError);
    expect(() => replayPushes([intended, intended], FORK_ID)).toThrow(ForkPushError);
  });
});

describe('credential-free fork ref reads', () => {
  const read =
    (answers: Record<string, GitHubResponse>): GitHubRead =>
    async (p) =>
      answers[p] ?? { status: 404, body: null };
  const repo = `/repos/${OWNER}/fixture`;
  const at = { fork: FORK, branch: 'feature/x' };

  it('binds targets to the fork id and safe branch names', () => {
    expect(forkTarget(FORK, 'feature/x')).toBe(`fork:${FORK_ID}:branch:feature/x`);
    expect(parseForkTarget(`fork:${FORK_ID}:branch:feature/x`, FORK)).toEqual(at);
    for (const target of [
      `fork:${FORK_ID + 1}:branch:x`,
      `fork:${FORK_ID}:branch:../x`,
      `fork:${FORK_ID}:branch:x y`,
      `fork:${FORK_ID}:branch:*`,
      'o/r/pulls',
    ])
      expect(() => parseForkTarget(target, FORK)).toThrow(ForkRefError);
  });

  it('reads heads/<branch> and answers sha, null on 404, and throws otherwise', async () => {
    const ok = { status: 200, body: { id: FORK_ID } };
    const ref = `${repo}/git/ref/heads/feature/x`;
    const object = { type: 'commit', sha: SHA1 };
    expect(
      await readForkBranch(
        read({ [repo]: ok, [ref]: { status: 200, body: { ref: 'refs/heads/feature/x', object } } }),
        at
      )
    ).toBe(SHA1);
    expect(await readForkBranch(read({ [repo]: ok }), at)).toBeNull();
    for (const answer of [
      { status: 200, body: { ref: 'refs/heads/feature/y', object } },
      { status: 200, body: { ref: 'refs/heads/feature/x', object: { type: 'tag', sha: SHA1 } } },
      { status: 403, body: { message: 'rate limited' } },
      { status: 409, body: { message: 'Git Repository is empty.' } },
    ])
      await expect(readForkBranch(read({ [repo]: ok, [ref]: answer }), at)).rejects.toThrow(
        ForkRefError
      );
    await expect(
      readForkBranch(read({ [repo]: { status: 200, body: { id: 1 } } }), at)
    ).rejects.toThrow('fork_unverified');
    await expect(
      readForkBranch(async () => {
        throw new Error('down');
      }, at)
    ).rejects.toThrow('ref_unknown');
  });
});

describe('TrustedGit extra environment and config', () => {
  it('accepts a broker credential env but refuses anything that could undo the hardening', () => {
    const git = new TrustedGit();
    try {
      const credential = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TRACE_REDACT: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'fixture',
      };
      expect(git.exec(['config', 'user.name'], { env: credential }).stdout.toString()).toBe(
        'fixture\n'
      );
      for (const env of [
        { GIT_DIR: '/tmp' },
        { GIT_SSH_COMMAND: 'sh' },
        { GIT_CONFIG_PARAMETERS: "'core.hooksPath'='.'" },
        { GIT_CONFIG_GLOBAL: '/tmp/gitconfig' },
        { PATH: '/tmp' },
      ])
        expect(() => git.exec(['version'], { env })).toThrow(TypeError);
      for (const entry of ['protocol.allow=always', 'core.hooksPath=.', 'Credential.Helper=x'])
        expect(() => git.exec(['version'], { config: [entry] })).toThrow(TypeError);
    } finally {
      git.close();
    }
  });
});
