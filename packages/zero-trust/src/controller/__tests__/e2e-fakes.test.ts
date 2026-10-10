/** Offline vertical slice: real controller/producers, only transport/VM/model edges fake. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BASE_COMMIT } from '../../__tests__/verifier-fixture';
import { CLIENT_ID, OWNER, USER_ID } from '../../github/__tests__/github-fake';
import { ForkCredentialBroker } from '../../github/broker';
import { Journal } from '../../journal';
import { discoverPolicy } from '../../policy/discover';
import { assessIssue } from '../../policy/eligibility';
import * as receipts from '../../receipt/issue';
import { ReceiptNonceStore } from '../../receipt/nonces';
import { ReasonCode, transitionRun } from '../../state';
import { approveCheckpoint } from '../checkpoints';
import { readControlRequests, requestControl } from '../control';
import { readOutcomeBudget } from '../outcome-records';
import { RunStore } from '../run-store';
import { loadVerification } from '../verification-record';
import { createController } from '../wiring';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, noShipping, pushCalls } from './composition-hooks';

compositionHooks();
describe('createController real composition', () => {
  function request(h: ReturnType<typeof rig>, kind: 'pause' | 'cancel') {
    const id = h.controller.snapshot().runId;
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), id, {
      readOnly: true,
      observe: true,
    });
    try {
      return requestControl(store, { kind, reason: 'User control' }, new Date(TIME));
    } finally {
      store.close();
    }
  }
  it('revokes the refresh chain when a pause outlives the native access token', async () => {
    const h = rig({ activeControl: 'write', oauthExpiresIn: 1 });
    const task = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    h.advanceClock(2000);
    request(h, 'pause');
    expect(((await task) as { state: string }).state).toBe('paused_user');
    expect(h.fake.oauthCalls.filter((form) => form.grant_type === 'refresh_token')).toHaveLength(1);
    expect([...h.fake.tokens.values()].filter((token) => token.live || token.refreshAlive)).toEqual(
      []
    );
    expect([...h.fake.refreshTokens.values()].filter((token) => token.live)).toEqual([]);
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
  it.each([
    'write',
    'exec',
    'model',
  ] as const)('pauses blocked %s and resumes exact held candidate on a fresh VM', async (activeControl) => {
    const uninterrupted = rig();
    const normal = (await uninterrupted.authorize(
      uninterrupted.controller.start(uninterrupted.config)
    )) as { runId: string };
    const expected = uninterrupted.artifacts(normal.runId);
    const sha = expected.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha;
    expected.close();
    const h = rig({ activeControl });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const calls = vi.mocked(h.vm.exec).mock.calls.length;
    const modelCalls = h.modelCalls();
    const row = request(h, 'pause');
    if (activeControl === 'model') h.releaseControl();
    const run = (await running) as { state: string; runId: string };
    expect(run.state).toBe('paused_user');
    expect(vi.mocked(h.vm.exec).mock.calls.length).toBe(calls);
    expect(h.modelCalls()).toBe(modelCalls);
    expect(h.vm.destroy).toHaveBeenCalledWith(expect.objectContaining({ vmId: h.interruptedVm() }));
    const a = h.artifacts(run.runId);
    expect(readControlRequests(a.store).pending).toHaveLength(0);
    expect(readOutcomeBudget(a.store).reservations.length).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(a.store.storeDirectory('control'), 'requests', `${row.id}.json`))
    ).toBe(true);
    a.close();
    h.advanceClock();
    const resumed = (await h.authorize(h.controller.resume(run.runId))) as { state: string };
    expect(resumed.state).toBe('awaiting_contributor');
    const b = h.artifacts(run.runId);
    expect(b.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha).toBe(sha);
    b.close();
    expect(
      vi
        .mocked(h.vm.exec)
        .mock.calls.slice(calls)
        .some((c) => c[0].vmId !== h.interruptedVm())
    ).toBe(true);
  }, 60000);
  it('cancel before shipping revokes the broker without a push', async () => {
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const h = rig({ activeControl: 'write' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const visible: number[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).includes('/requests/') && String(to).endsWith('.json')) {
        visible.push(fs.lstatSync(to).nlink);
        try {
          h.controller.assertAdmission();
        } catch {
          /* Stop-only admission must close here. */
        }
      }
    });
    request(h, 'cancel');
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(ended).toHaveBeenCalledWith('cancelled');
    expect(visible).toEqual([1]);
    noShipping();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s during token mint never hands credentials to a push', async (kind) => {
    const h = rig({ activeControl: 'mint' });
    const take = vi.spyOn(ForkCredentialBroker.prototype, 'take');
    const revoke = vi.spyOn(ForkCredentialBroker.prototype, 'revoke');
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    h.releaseControl();
    expect(((await running) as { state: string }).state).toBe(
      kind === 'pause' ? 'paused_user' : 'cancelled'
    );
    expect(take).not.toHaveBeenCalled();
    expect(pushCalls()).toHaveLength(0);
    expect(revoke).toHaveBeenCalled();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s during engagement reconciliation issues no new contributor capability', async (kind) => {
    const h = rig({ policy: 'permission', activeControl: 'engagement' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    h.releaseControl();
    const run = (await running) as { runId: string; state: string };
    expect(run.state).toBe(kind === 'pause' ? 'paused_user' : 'cancelled');
    const a = h.artifacts(run.runId);
    const journal = new Journal(a.store.storeDirectory('handoff'));
    expect(
      journal.read().filter((e) => (e as { type: string }).type === 'link_issued')
    ).toHaveLength(0);
    expect(fs.readdirSync(a.store.storeDirectory('bodies'))).toHaveLength(0);
    journal.close();
    a.close();
    noShipping();
  }, 60000);
  it('pause/resume during verification repair retains its failed-candidate basis and repair evidence', async () => {
    const h = rig({ activeControl: 'write', onlyRepair: true, failVerification: true });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const candidate = h.controller.snapshot().runId;
    request(h, 'pause');
    expect(((await running) as { state: string }).state).toBe('paused_user');
    const a = h.artifacts(candidate);
    const held = a.get<{ baseDigest: string; turn: number }>('implementation_continuation');
    expect(held.baseDigest).toBe(
      a.get<{ manifest: { digest: string } }>('candidate').manifest.digest
    );
    a.close();
    h.advanceClock();
    expect(((await h.authorize(h.controller.resume(candidate))) as { state: string }).state).toBe(
      'failed'
    );
    expect(h.repairEvidence.length).toBeGreaterThan(1);
    noShipping();
  }, 60000);
  it('a legitimate cancel arriving during pause destruction wins and revokes once work is quiesced', async () => {
    const h = rig({ activeControl: 'write' });
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const destroy = vi.mocked(h.vm.destroy).getMockImplementation();
    if (!destroy) throw new Error('fixture missing destruction edge');
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(h.vm.destroy).mockImplementation(async (handle) => {
      if (handle.vmId === h.interruptedVm()) {
        arrived();
        await released;
      }
      return destroy(handle);
    });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, 'pause');
    await reached;
    request(h, 'cancel');
    release();
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(ended).toHaveBeenCalledWith('cancelled');
    noShipping();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s teardown failure retains blocked_cleanup and cancellation still revokes', async (kind) => {
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const h = rig({ activeControl: 'write', teardownFails: true });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    expect(((await running) as { state: string }).state).toBe('blocked_cleanup');
    if (kind === 'cancel') expect(ended).toHaveBeenCalledWith('cancelled');
    noShipping();
  }, 60000);
  it('cancel reconciles a submitted PR behind a pending contributor link before cancellation', async () => {
    const h = rig();
    const run = (await h.authorize(h.controller.start(h.config))) as { runId: string };
    h.submit(run.runId);
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), run.runId, {
      readOnly: true,
      observe: true,
    });
    requestControl(store, { kind: 'cancel', reason: 'Withdraw my run' }, new Date(TIME));
    store.close();
    const cancelled = await h.controller.resume(run.runId);
    expect(cancelled.state).toBe('cancelled');
    const a = h.artifacts(run.runId);
    expect(a.get<{ url: string }>('publication').url).toBe(
      'https://github.com/upstream/fixture/pull/8'
    );
    expect(a.get<string>('withdrawal')).toContain('then close the pull request');
    a.close();
  }, 60000);
  it.each([
    'torn-request',
    'array-result',
  ] as const)('corrupt control bytes (%s) block the active controller with inspectable evidence', async (damage) => {
    const h = rig({ activeControl: 'write' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const row = request(h, 'pause');
    const id = h.controller.snapshot().runId;
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), id, {
      readOnly: true,
      observe: true,
    });
    if (damage === 'array-result')
      fs.writeFileSync(
        path.join(store.storeDirectory('control'), 'requests', `${row.id}.result`),
        JSON.stringify({ v: 1, digest: row.digest, result: ['applied'] }),
        { mode: 0o600 }
      );
    else
      fs.writeFileSync(
        path.join(store.storeDirectory('control'), 'requests', `${row.id}.json`),
        '{"torn":',
        { mode: 0o600 }
      );
    store.close();
    expect(((await running) as { state: string }).state).toBe('blocked');
    const a = h.artifacts(id);
    expect(readControlRequests(a.store).invalid).toBe(true);
    a.close();
    noShipping();
  }, 60000);
  it.each([
    ['plan', 'corrupt'],
    ['plan', 'missing'],
    ['patch', 'corrupt'],
    ['patch', 'missing'],
  ] as const)(
    'refuses %s checkpoint %s review material at approval and resume',
    async (checkpoint, damage) => {
      const h = rig({ checkpoint });
      const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
        ReturnType<typeof h.controller.start>
      >;
      const a = h.artifacts(run.runId);
      const file = path.join(a.dir, checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff');
      const original = fs.readFileSync(file);
      const cp = a.store.checkpoint(checkpoint);
      if (!cp) throw new Error('fixture missing checkpoint');
      if (damage === 'missing') fs.unlinkSync(file);
      else
        fs.writeFileSync(file, 'Nothing needs to change. This candidate is empty.', {
          mode: 0o600,
        });
      expect(() =>
        approveCheckpoint(a.store, a.store.run, { point: checkpoint, digest: cp.digest }, TIME)
      ).toThrow('checkpoint_stale');
      expect(a.store.checkpoint(checkpoint)?.status).toBe('open');
      a.close();
      await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
        code: 'recovery_failed',
      });
      noShipping();
      const b = h.artifacts(run.runId);
      b.store.replaceArtifact(checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff', original);
      approveCheckpoint(b.store, b.store.run, { point: checkpoint, digest: cp.digest }, TIME);
      b.close();
      expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
        'awaiting_contributor'
      );
    },
    60000
  );
  it.each([
    false,
    true,
  ])('carries invitation authority into shipping (policy changed=%s)', async (changed) => {
    const h = rig({ policy: 'permission' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.submitEngagement(run.runId);
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    h.invite();
    if (changed) h.welcome();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const a = h.artifacts(run.runId);
    const journal = new Journal(a.store.storeDirectory('handoff'));
    const links = journal.read().filter((row) => (row as { type: string }).type === 'link_issued');
    expect(links).toHaveLength(2);
    journal.close();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBe(
      a.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha
    );
    a.close();
  }, 60000);
  it('retains a prohibited baseline refusal on legal continuation', async () => {
    const h = rig({ failBaseline: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    a.store.persistRun(transitionRun(a.store.run, ReasonCode.ResumePlanning, TIME));
    a.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'paused_user'
    );
    expect(h.planCalls()).toBe(0);
    noShipping();
  }, 60000);
  it.each([
    'plan',
    'patch',
  ] as const)('publishes held human-readable %s checkpoint evidence', async (checkpoint) => {
    const h = rig({ checkpoint });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    expect(a.store.checkpoint(checkpoint)?.status).toBe('open');
    const bytes = fs.readFileSync(
      path.join(a.dir, checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff'),
      'utf8'
    );
    if (checkpoint === 'plan') expect(bytes).toBe(a.get<{ text: string }>('plan').text);
    else {
      expect(bytes).toContain('+++ b/src/duration.js');
      expect(bytes).toContain('+');
      expect(bytes).toContain('millis / 1000');
    }
    a.close();
    noShipping();
  }, 60000);
  it('reconciles the completed nonce-header crash prefix without resetting history', async () => {
    const h = rig({ checkpoint: 'verification' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    const a = h.artifacts(run.runId);
    const cp = a.store.checkpoint('verification');
    if (!cp) throw new Error('fixture missing checkpoint');
    approveCheckpoint(a.store, a.store.run, { point: 'verification', digest: cp.digest }, TIME);
    a.put('nonces_initializing', true);
    new ReceiptNonceStore(a.store.storeDirectory('nonces')).initialize();
    a.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const b = h.artifacts(run.runId);
    expect(b.get('nonces_initialized')).toBe(true);
    expect(
      fs.readFileSync(path.join(b.store.storeDirectory('nonces'), 'events.jsonl'), 'utf8')
    ).toContain('receiptDigest');
    b.close();
  }, 60000);
  it('does not relabel an unavailable authenticated identity as a different account', async () => {
    const h = rig({ userUnavailable: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
      diagnostic: { phase: 'gate', code: 'contributor_authorization_unavailable' },
    });
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.store.run.state).toBe('gating');
    expect(a.get('refusal')).toBe('contributor_authorization_unavailable');
    a.close();
    noShipping();
  }, 60000);
  it('retains a safe actionable gate diagnostic without external response text', async () => {
    const h = rig({ baseUnavailable: true });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({
      code: 'step_failed',
      diagnostic: { phase: 'gate', code: 'producer_unavailable' },
    });
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.get('diagnostic')).toMatchObject({
      phase: 'gate',
      operation: 'gate_producer',
      code: 'producer_unavailable',
      next: expect.stringContaining('explicitly resume'),
    });
    a.close();
  });
  it('refuses contradictory external policy bytes before receipt issuance', async () => {
    const h = rig({ corruptPolicy: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
    });
    noShipping();
  }, 60000);
  it('refuses a consistently hashed restrictive policy change before shipping', async () => {
    const h = rig({ restrictPolicy: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
    });
    noShipping();
  }, 60000);
  it('retains a closed recovery diagnostic for an identity outage', async () => {
    const h = rig({ checkpoint: 'plan' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.identityUnavailable();
    await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
      code: 'recovery_failed',
      diagnostic: { phase: 'recovery', code: 'contributor_authorization_unavailable' },
    });
    const a = h.artifacts(run.runId);
    // The paused exit already confirmed old-token revocation. An identity outage
    // now creates no new cleanup obligation and must still refuse recovery.
    expect(a.store.run.state).toBe('paused_user');
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    expect(a.get('diagnostic')).toMatchObject({
      phase: 'recovery',
      operation: 'recovery_producer',
    });
    a.close();
    noShipping();
  }, 60000);
  it('retains byte-identical admitted writes when checking upstream drift', async () => {
    const h = rig({ driftTouch: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    expect(a.get<{ touched: string[] }>('candidate').touched).toContain('package.json');
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    a.close();
    noShipping();
  }, 60000);
  it.each([
    'destruction',
    'enumeration',
  ] as const)('revokes credentials even when incident VM %s fails', async (failure) => {
    const h = rig({ cancelDuringPlan: true });
    const task = h.authorize(h.controller.start(h.config));
    await h.planReached;
    if (failure === 'destruction') h.vm.failDestroy = 100;
    else
      vi.spyOn(h.vm, 'listByRun').mockRejectedValue(new Error('external enumeration unavailable'));
    await expect(h.controller.incidentStop('cleanup failure control')).rejects.toThrow();
    await task.catch(() => {});
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    expect(h.fake.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    noShipping();
  }, 60000);
  it('does not open OAuth after cancellation during an external fork read', async () => {
    const h = rig({ delayFork: true });
    const task = h.controller.start(h.config);
    await h.forkReached;
    const stopped = h.controller.incidentStop('delayed read cancellation');
    h.releaseFork();
    await stopped;
    await task;
    expect(h.controller.authorizationUrl).toBeNull();
    expect(h.fake.oauthCalls).toEqual([]);
    noShipping();
  }, 60000);
  it('never echoes malformed credential-shaped proxy bytes', () => {
    const h = rig();
    fs.writeFileSync(
      h.config.executionProfile.proxyEndpointsFile,
      'ghp_sensitive_malformed_fixture',
      { mode: 0o600 }
    );
    expect(() => createController(h.config)).toThrow(/^invalid_proxy_file$/u);
  });
  it('produces a verified fork push and contributor compare handoff, then observes submission honestly', async () => {
    const h = rig();
    expect(
      await assessIssue(
        h.read as NonNullable<typeof h.read>,
        h.config.upstream,
        h.config.contributor
      )
    ).toMatchObject({ kind: 'eligible' });
    expect(
      await discoverPolicy(h.read as NonNullable<typeof h.read>, {
        ...h.config.upstream,
        ref: BASE_COMMIT.baseSha,
      })
    ).toMatchObject({ kind: 'known' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    expect(vi.mocked(receipts.issueReceipt).mock.calls.length).toBeGreaterThan(0);
    expect(pushCalls().length).toBeGreaterThan(0);
    const a = h.artifacts(run.runId);
    const held = a.get<{ record: { candidateSha: string } }>('candidate');
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBe(held.record.candidateSha);
    const handoffJournal = new Journal(a.store.storeDirectory('handoff'));
    expect(
      (
        handoffJournal.read().find((r) => (r as { type: string }).type === 'link_issued') as {
          link: string;
        }
      ).link
    ).toContain(`/compare/main...${OWNER}:ztfc/`);
    handoffJournal.close();
    expect(loadVerification(a.dir, held.record.candidateSha, { runId: run.runId }).verdict).toBe(
      'passed'
    );
    a.close();
    h.submit(run.runId);
    const resumed = (await h.authorize(h.controller.resume(run.runId))) as Awaited<
      ReturnType<typeof h.controller.resume>
    >;
    expect(resumed.state).toBe('submitted');
    const b = h.artifacts(run.runId);
    expect(b.get<{ url: string; ci: string }>('publication')).toMatchObject({
      url: 'https://github.com/upstream/fixture/pull/8',
    });
    expect(['pending', 'unknown', 'awaiting_approval']).toContain(
      b.get<{ ci: string }>('publication').ci
    );
    b.close();
    const tracked = (await h.authorize(h.controller.resume(run.runId))) as Awaited<
      ReturnType<typeof h.controller.resume>
    >;
    expect(tracked.state).toBe('awaiting_review');
    const t = h.artifacts(run.runId);
    expect(t.get<{ ci: string; pr: string }>('tracking').pr).toBe(
      'https://github.com/upstream/fixture/pull/8'
    );
    expect(t.get<{ ci: string }>('tracking').ci).not.toBe('passed');
    const tj = new Journal(t.store.storeDirectory('track'));
    expect(tj.read().length).toBeGreaterThan(1);
    tj.close();
    t.close();
    expect(h.fake.calls.filter((c) => c.method === 'POST' && c.path.includes('/pulls'))).toEqual(
      []
    );
  }, 60000);
  it('requires contributor-confirmed engagement before maintainer waiting and never reissues it', async () => {
    const h = rig({ policy: 'permission' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    expect(h.vm.calls.some((c) => c.op === 'create')).toBe(false);
    h.submitEngagement(run.runId);
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    const a = h.artifacts(run.runId);
    const j = new Journal(a.store.storeDirectory('handoff'));
    expect(j.read().filter((r) => (r as { type: string }).type === 'link_issued')).toHaveLength(1);
    j.close();
    a.close();
  }, 60000);
  it('blocks an AI ban before allocation or authorization', async () => {
    const h = rig({ policy: 'ban' });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('blocked');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it('blocks a boundary breach with no receipt and untouched fork', async () => {
    const h = rig({ breach: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('blocked');
    const a = h.artifacts(run.runId);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    noShipping();
    a.close();
  }, 60000);
  it('exhausts exactly two repair attempts after three independent verification failures without pushing', async () => {
    const h = rig({ failVerification: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('failed');
    const a = h.artifacts(run.runId);
    expect(a.get('attempt')).toBe(3);
    expect(h.repairEvidence.length).toBeGreaterThan(0);
    expect(JSON.parse(h.repairEvidence[0]).verification.verdict).toBe('failed');
    expect(
      JSON.parse(h.repairEvidence[0]).verification.commands.some(
        (c: { status: string }) => c.status === 'failed'
      )
    ).toBe(true);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    noShipping();
    expect(
      fs.readdirSync(path.join(a.dir, 'verification')).filter((name) => name.endsWith('.json'))
    ).toHaveLength(3);
    a.close();
  }, 60000);
  it('refuses a different authenticated numeric account before candidate allocation', async () => {
    const h = rig({ wrongUser: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'author_approval_mismatch',
    });
    expect(h.vm.calls).toEqual([]);
  }, 60000);
  it('refuses resumed shipping handoff under a different numeric account', async () => {
    const h = rig();
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.fake.userId++;
    await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
      code: 'author_approval_mismatch',
    });
    const a = h.artifacts(run.runId);
    expect(a.store.run.state).toBe('blocked');
    expect(a.get('refusal')).toBe('author_approval_mismatch');
    a.close();
  }, 60000);
  it.each([
    'fork',
    'installation',
  ] as const)('retains an explicit missing %s prerequisite wait without provisioning or posting', async (prerequisite) => {
    const h = rig(prerequisite === 'fork' ? { missingFork: true } : { missingInstallation: true });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('awaiting_contributor');
    expect(run.reasonCode).toBe(prerequisite === 'fork' ? 'fork_missing' : 'installation_missing');
    expect((await h.controller.resume(run.runId)).state).toBe('awaiting_contributor');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it.each([
    false,
    true,
  ])('uses the persisted approved identity for a required DCO trailer (wrapped=%s)', async (wrappedPolicy) => {
    const h = rig({ signoff: true, wrappedPolicy });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    const a = h.artifacts(run.runId);
    expect(a.get<{ record: { message: string } }>('candidate').record.message).toContain(
      `Signed-off-by: Approved Contributor <${USER_ID}+${OWNER}@users.noreply.github.com>`
    );
    a.close();
  }, 60000);
  it.each([
    false,
    true,
  ])('hands off an explicit real-name requirement when the approved name is only the login (wrapped=%s)', async (wrappedPolicy) => {
    const h = rig({ realNameOnlyLogin: true, wrappedPolicy });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('gating');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it('refuses missing author approval and closed override violations before creating a run', () => {
    const h = rig();
    expect(() => createController({ ...h.config, authorApproval: undefined })).toThrow(
      'author_approval_missing'
    );
    expect(() => createController(h.config, { phase: {} } as never)).toThrow(
      'invalid_controller_override'
    );
    expect(() => h.controller.start({ ...h.config, contributor: 'other' })).toThrow(
      'controller_config_mismatch'
    );
    expect(h.vm.calls).toEqual([]);
  });
  it('joins legitimate cancellation during a paid model await, revokes credentials and destroys VMs without shipping', async () => {
    const h = rig({ cancelDuringPlan: true });
    const started = h.authorize(h.controller.start(h.config));
    await h.planReached;
    const stopped = await h.controller.incidentStop('user cancellation');
    expect(stopped.state).toBe('cancelled');
    expect(((await started) as { state: string }).state).toBe('cancelled');
    expect(await h.vm.listByRun(stopped.runId)).toEqual([]);
    const a = h.artifacts(stopped.runId);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    a.close();
    expect([...h.fake.tokens.values()].every((t) => !t.live)).toBe(true);
  }, 60000);
});
