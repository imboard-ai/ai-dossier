/** Gate 4 lifecycle acceptance: real createController, local Git and physical edge fakes.
 * Each title identifies the actor, expected outcome and owning PRD release slices. */

import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../budget';
import { TrustedGit } from '../canonical/trusted-git';
import { TIME } from '../controller/__tests__/composition-fixture';
import { approveBudgetCeiling } from '../controller/budget-extension';
import { approveCheckpoint } from '../controller/checkpoints';
import { readOutcomeBudget } from '../controller/outcome-records';
import { loadVerification } from '../controller/verification-record';
import { INSTALLATION_ID, OWNER } from '../github/__tests__/github-fake';
import * as receipts from '../receipt/issue';
import { ReasonCode, transitionRun } from '../state';
import {
  assertGlobalInvariants,
  barrier,
  control,
  gate4Suite,
  type Rig,
  rows,
} from './gate4-audit';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const fixture = gate4Suite();

describe('gate 4 lifecycle', () => {
  it.each([
    {
      phase: 'gating',
      owner: 'S2/S5',
      activeControl: 'engagement' as const,
      policy: 'permission' as const,
    },
    { phase: 'implementing', owner: 'S3/S5', activeControl: 'write' as const },
    { phase: 'shipping before push', owner: 'S4/S5', activeControl: 'mint' as const },
  ])('actor=contributor outcome=cancelled phase=$phase owner=$owner', async (scenario) => {
    const h = fixture(scenario);
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    expect(h.controller.snapshot().state).toBe(
      scenario.phase === 'shipping before push' ? 'shipping' : scenario.phase
    );
    control(h, 'cancel');
    h.releaseControl();
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(h.fork.sha('ztfc/unused')).toBeNull();
    const git = vi.mocked(TrustedGit.prototype.execAsync);
    expect(git.mock.calls.filter((call) => call[0][0] === 'push')).toHaveLength(0);
  });

  it('actor=contributor outcome=cancelled phase=verifying owner=S3/S5', async () => {
    const blocked = barrier();
    let h!: Rig;
    let once = false;
    h = fixture({
      beforeExec: async () => {
        if (!once && h.controller.snapshot().state === 'verifying') {
          once = true;
          await blocked.wait();
        }
      },
    });
    const running = h.authorize(h.controller.start(h.config));
    await blocked.reached;
    control(h, 'cancel');
    blocked.release();
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((call) => call[0][0] === 'push')
    ).toHaveLength(0);
  });

  it('actor=contributor outcome=cancelled with submitted PR reported phase=pending handoff owner=S4/S5', async () => {
    const h = fixture();
    const run = (await h.authorize(h.controller.start(h.config))) as {
      runId: string;
      state: string;
    };
    expect(run.state).toBe('awaiting_contributor');
    const pushes = vi
      .mocked(TrustedGit.prototype.execAsync)
      .mock.calls.filter((call) => call[0][0] === 'push').length;
    h.submit(run.runId);
    control(h, 'cancel');
    expect((await h.controller.resume(run.runId)).state).toBe('cancelled');
    const a = h.artifacts(run.runId);
    expect(a.get<{ url: string }>('publication').url).toBe(
      'https://github.com/upstream/fixture/pull/8'
    );
    expect(a.get<string>('withdrawal')).toContain('then close the pull request');
    a.close();
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((call) => call[0][0] === 'push')
    ).toHaveLength(pushes);
  });

  it('actor=VM provider outcome=blocked_cleanup denies execution/publication; CleanupCompleted only blocked owner=S1/S5', async () => {
    const h = fixture({ activeControl: 'write' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    h.vm.failDestroy = 3;
    control(h, 'cancel');
    const run = (await running) as { state: string; runId: string };
    expect(run.state).toBe('blocked_cleanup');
    expect(
      h.vm.calls.filter((call) => call.op === 'destroy' && call.vmId === h.interruptedVm()).length
    ).toBeGreaterThanOrEqual(3);
    expect(rows(h, 'control', 'controller')).toContainEqual(
      expect.objectContaining({ type: 'cleanup', kind: 'blocked_cleanup', vmId: h.interruptedVm() })
    );
    const executions = h.vm.execs().length;
    const pushes = vi
      .mocked(TrustedGit.prototype.execAsync)
      .mock.calls.filter((call) => call[0][0] === 'push').length;
    const calls = h.modelCalls();
    const links = rows(h, 'handoff');
    const before = h.artifacts(run.runId);
    const publication = before.get('publication');
    const tracking = before.get('tracking');
    before.close();
    expect((await h.controller.resume(run.runId)).state).toBe('blocked_cleanup');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.execs()).toHaveLength(executions);
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((call) => call[0][0] === 'push')
    ).toHaveLength(pushes);
    expect(rows(h, 'handoff')).toEqual(links);
    const a = h.artifacts(run.runId);
    expect(a.get('publication')).toEqual(publication);
    expect(a.get('tracking')).toEqual(tracking);
    a.store.persistRun(transitionRun(a.store.run, ReasonCode.CleanupCompleted, TIME));
    expect(a.store.run.state).toBe('blocked');
    a.close();
    expect((await h.controller.resume(run.runId)).state).toBe('blocked');
  });

  it('actor=execution clock outcome=verification exhaustion never passes owner=S1/S3', async () => {
    let h!: Rig;
    let exhausted = false;
    h = fixture({
      beforeExec: async () => {
        if (!exhausted && h.controller.snapshot().state === 'verifying') {
          exhausted = true;
          h.advanceClock(121 * 60000);
        }
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(['paused_user', 'failed', 'blocked']).toContain(run.state);
    const a = h.artifacts(run.runId);
    expect(a.get('receipt')).toBeUndefined();
    expect(run.state).not.toBe('shipping');
    expect(
      h.controller
        .snapshot()
        .history.some((event) => event.reasonCode === ReasonCode.VerificationPassed)
    ).toBe(false);
    const verificationDir = path.join(a.dir, 'verification');
    for (const file of fs.existsSync(verificationDir) ? fs.readdirSync(verificationDir) : []) {
      if (/^[a-f0-9]{40}\.json$/u.test(file))
        expect(loadVerification(a.dir, file.slice(0, -5), { runId: run.runId }).verdict).not.toBe(
          'passed'
        );
    }
    expect(a.get('publication')).toBeUndefined();
    a.close();
  });

  it('actor=contributor outcome=pause/checkpoint resume retains candidate and ledger owner=S3/S5', async () => {
    const h = fixture({ activeControl: 'write', checkpoint: 'verification' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    control(h, 'pause');
    const run = (await running) as { state: string; runId: string };
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    const before = readOutcomeBudget(a.store);
    a.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'paused_user'
    );
    const b = h.artifacts(run.runId);
    const cp = b.store.checkpoint('verification');
    if (!cp) throw new Error('checkpoint missing');
    const sha = b.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha;
    expect(readOutcomeBudget(b.store).reservations.slice(0, before.reservations.length)).toEqual(
      before.reservations
    );
    approveCheckpoint(b.store, b.store.run, { point: 'verification', digest: cp.digest }, TIME);
    b.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const c = h.artifacts(run.runId);
    expect(h.fork.sha(`ztfc/${c.store.contributionId}`)).toBe(sha);
    c.close();
    // Mutation controls prove the audit rejects forbidden physical-side-effect
    // observations and a pass whose corresponding supervisor command vanished.
    h.fake.calls.push({ method: 'POST', path: '/repos/upstream/fixture/pulls' });
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    h.fake.calls.pop();
    const transport = vi.mocked(TrustedGit.prototype.execAsync);
    transport.mock.calls.push([
      ['push', `file://${h.fork.dir}`, `${sha}:refs/heads/unauthorized`],
      {},
    ] as never);
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    transport.mock.calls.pop();
    const actual = transport.mock.calls.find((call) => call[0][0] === 'push');
    if (!actual) throw new Error('missing positive push control');
    transport.mock.calls.push(actual);
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    transport.mock.calls.pop();
    const observed = h.executions.splice(0);
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    h.executions.push(...observed);
  });

  it('actor=GitHub fork timing outcome=gating prerequisite wait without compute then initial shipping owner=S4/S5', async () => {
    const h = fixture({ missingFork: true });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(run.state).toBe('awaiting_contributor');
    expect(h.controller.snapshot().reasonCode).toBe(ReasonCode.ForkMissing);
    expect(h.controller.snapshot().history.at(-1)?.from).toBe('gating');
    const calls = h.modelCalls();
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(0);
    expect((await h.controller.resume(run.runId)).state).toBe('awaiting_contributor');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(0);
    h.forkPresent();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    expect(h.controller.snapshot().history).toContainEqual(
      expect.objectContaining({ from: 'verifying', to: 'shipping' })
    );
    const a = h.artifacts(run.runId);
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBe(
      a.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha
    );
    a.close();
  });

  it('actor=GitHub bound fork deletion outcome=blocked at shipping without rebind owner=S1/S4/S5', async () => {
    let h!: Rig;
    let missing = false;
    h = fixture({
      beforeRead: async (p) => {
        if (
          !missing &&
          p === `/repos/${OWNER}/fixture` &&
          h.controller.snapshot().state === 'shipping'
        ) {
          missing = true;
          h.forkMissing();
        }
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(run.state).toBe('blocked');
    expect(h.controller.snapshot().history.at(-1)?.from).toBe('shipping');
    const retained = h.artifacts(run.runId);
    const candidate = retained.get('candidate');
    const verification = retained.get('verification');
    retained.close();
    const calls = h.modelCalls();
    const creates = h.vm.calls.filter((c) => c.op === 'create').length;
    expect((await h.controller.resume(run.runId)).state).toBe('blocked');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(creates);
    h.forkPresent();
    expect((await h.controller.resume(run.runId)).state).toBe('blocked');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(creates);
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((c) => c[0][0] === 'push')
    ).toHaveLength(0);
    const resumed = h.artifacts(run.runId);
    expect(resumed.get('candidate')).toEqual(candidate);
    expect(resumed.get('verification')).toEqual(verification);
    resumed.close();
  });

  it('actor=contributor App configuration outcome=broad installation blocked owner=S1/S4', async () => {
    const h = fixture();
    h.fake.appInstallations.set(`${OWNER}/fixture`, {
      id: INSTALLATION_ID,
      account: { login: OWNER },
      repository_selection: 'all',
      permissions: { contents: 'write', metadata: 'read' },
      suspended_at: null,
    });
    const run = (await h.authorize(h.controller.start(h.config))) as { state: string };
    expect(run.state).toBe('blocked');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(0);
  });

  it('actor=Git operation expiry outcome=revoked midpush, absent remote voids attempt, fresh receipt retries owner=S1/S4', async () => {
    const h = fixture({ activeControl: 'mint' });
    const issued = vi.mocked(receipts.issueReceipt);
    const hook = path.join(h.fork.dir, 'hooks/pre-receive');
    const marker = path.join(h.fork.dir, 'push-reached');
    const fifo = path.join(h.fork.dir, 'push-release');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    // Real bare Git transport reaches a blocking, rejecting server hook. No
    // fabricated Git result: execAsync launches and aborts the actual operation.
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nprintf ready > '${marker}'\nread line < '${fifo}'\nexit 1\n`,
      { mode: 0o700 }
    );
    const pipe = fs.openSync(fifo, fs.constants.O_RDWR);
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.releaseControl();
    try {
      for (let i = 0; i < 500 && !fs.existsSync(marker); i++) await realDelay(10);
      expect(fs.existsSync(marker)).toBe(true);
      h.advanceClock(15 * 60000 + 1);
      await vi.advanceTimersByTimeAsync(15 * 60000 + 1);
      expect(
        [...h.fake.tokens.values()].filter((token) => token.kind === 'installation' && token.live)
      ).toEqual([]);
    } finally {
      fs.writeSync(pipe, 'release\n');
      fs.closeSync(pipe);
      vi.useRealTimers();
      await running.catch(() => {});
    }
    await running.catch(() => {});
    const id = h.controller.snapshot().runId;
    const a = h.artifacts(id);
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    a.close();
    const push = vi.mocked(TrustedGit.prototype.execAsync);
    const index = push.mock.calls.findIndex((call) => call[0][0] === 'push');
    expect((await push.mock.results[index].value).status).toBeNull();
    expect(rows(h, 'intents')).toContainEqual(expect.objectContaining({ type: 'voided' }));
    const previous = (await issued.mock.results[0].value) as receipts.SignedReceipt;
    fs.unlinkSync(hook);
    expect(((await h.authorize(h.controller.resume(id))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const latest = (await issued.mock.results.at(-1)?.value) as receipts.SignedReceipt;
    expect(latest.digest).not.toBe(previous.digest);
    expect(latest.receipt.candidateSha).toBe(previous.receipt.candidateSha);
  });

  it('actor=contributor/model usage outcome=reservation refuses next call; approved money ceiling resumes same session/history owner=S1/S3/S5', async () => {
    let implementing = 0;
    const h = fixture({
      modelPrice: 1,
      ceilingMinor: 1000000,
      implementationUsage: 1000000,
      tokenLimit: 10000000,
      beforeModel: async (request) => {
        if (
          !JSON.stringify(request.tools).includes('submit_plan') &&
          request.tools[0]?.function.name !== 'report_decision'
        )
          implementing++;
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(run.state).toBe('paused_user');
    expect(implementing).toBe(1);
    const a = h.artifacts(run.runId);
    const before = readOutcomeBudget(a.store);
    expect(before.reservations.some((row) => row.observed?.tokens === 1000010)).toBe(true);
    a.close();
    const approval = {
      actor: 'user' as const,
      approvalId: 'contributor-ceiling-1',
      previousMinor: 1000000,
      ceilingMinor: 10000000,
    };
    const root = path.join(h.config.executionProfile.stateDir, 'runs');
    approveBudgetCeiling(root, run.runId, approval, new Date(TIME));
    expect(() => approveBudgetCeiling(root, run.runId, approval, new Date(TIME))).toThrow();
    const b = h.artifacts(run.runId);
    const extended = readOutcomeBudget(b.store);
    expect(extended.sessions).toEqual(before.sessions);
    expect(extended.reservations).toEqual(before.reservations);
    expect(extended.ceilingExtensions).toEqual([
      expect.objectContaining({
        approvalId: approval.approvalId,
        previousMinor: approval.previousMinor,
        ceiling: { currency: 'USD', minor: approval.ceilingMinor },
      }),
    ]);
    b.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const c = h.artifacts(run.runId);
    expect(readOutcomeBudget(c.store).reservations.slice(0, before.reservations.length)).toEqual(
      before.reservations
    );
    c.close();
  });

  it('actor=GitHub expired contributor chain outcome=refresh reauthorize stops with authorize, no stale push owner=S4/S5', async () => {
    let h!: Rig;
    let expired = false;
    h = fixture({
      oauthExpiresIn: 1,
      beforeRead: async (p) => {
        if (
          !expired &&
          p === `/repos/${OWNER}/fixture` &&
          h.controller.snapshot().state === 'shipping'
        ) {
          expired = true;
          h.advanceClock(2000);
          h.fake.override('OAUTH', { status: 200, json: { error: 'bad_refresh_token' } });
        }
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(run.state).toBe('paused_user');
    expect(h.fake.oauthCalls.some((form) => form.grant_type === 'refresh_token')).toBe(true);
    expect(h.controller.nextPermittedAction).toBe('authorize');
    expect(h.controller.authorizationUrl).toBeNull();
    const a = h.artifacts(run.runId);
    expect(a.get('authorization_required')).toEqual({ nextPermittedAction: 'authorize' });
    a.close();
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((call) => call[0][0] === 'push')
    ).toHaveLength(0);
    const calls = h.modelCalls();
    expect((await h.controller.resume(run.runId)).state).toBe('paused_user');
    expect(h.modelCalls()).toBe(calls);
  });

  it('actor=controller process SIGKILL outcome=real unknown hold survives reopen, fresh work fenced, guest teardown funded owner=S1/S3/S5', async () => {
    const h = fixture({ persistent: true, oauthExpiresIn: 1, oauthRefreshExpiresIn: 1 });
    const child = fork(
      path.join(__dirname, '../controller/__tests__/crash-child.ts'),
      [h.config.executionProfile.stateDir],
      {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, VITEST: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }
    );
    const died = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    );
    let output = '';
    child.stderr?.on('data', (data) => {
      output += data.toString();
    });
    let id: string;
    try {
      id = await new Promise<string>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`crash fixture deadline: ${output}`)),
          15000
        );
        child.once('message', (message) => {
          clearTimeout(deadline);
          resolve((message as { runId: string }).runId);
        });
        child.once('exit', () => {
          clearTimeout(deadline);
          reject(new Error(`crash fixture exited early: ${output}`));
        });
      });
    } finally {
      child.kill('SIGKILL');
    }
    expect((await died).signal).toBe('SIGKILL');
    const a = h.artifacts(id);
    const before = readOutcomeBudget(a.store);
    const hold = before.reservations.find(
      (row) => row.status === 'reserved' && row.estimate.tokens > 0
    );
    expect(hold).toBeDefined();
    if (!hold) throw new Error('missing crash hold');
    const ledger = new BudgetLedger(
      path.join(a.store.storeDirectory('budget'), 'ledger.json'),
      a.store.contributionId
    );
    // Independent admission observation: even before credential recovery runs,
    // this real reopened ledger rejects fresh work because the crash hold is unknown.
    expect(() => ledger.reserve(hold.sessionId, hold.estimate)).toThrow(
      'Reconcile recovered reservations'
    );
    expect(ledger.snapshot().reservations).toEqual(before.reservations);
    // A crash may also durably record a reauthorization fence. That fence must
    // not bypass recovery of credentials whose secret values died with the process.
    a.put('authorization_required', { nextPermittedAction: 'authorize' });
    a.close();
    const guests = await h.vm.listByRun(id);
    expect(guests.length).toBeGreaterThan(0);
    // Both native access AND refresh lifetimes genuinely elapse at the physical
    // server. The broker still cannot invent proof after process secret loss;
    // its unresolved journal obligation must retain blocked_cleanup.
    h.advanceClock(2000);
    await expect(h.controller.resume(id)).rejects.toThrow('cleanup_incomplete');
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    expect(h.modelCalls()).toBe(0);
    expect(await h.vm.listByRun(id)).toEqual([]);
    const b = h.artifacts(id);
    const after = readOutcomeBudget(b.store);
    expect(after.reservations.find((row) => row.id === hold?.id)).toEqual(hold);
    expect(after.sessions).toEqual(before.sessions);
    expect(
      after.reservations
        .slice(before.reservations.length)
        .some((row) => row.purpose === 'teardown' && row.status === 'settled')
    ).toBe(true);
    b.close();
  }, 30000);
});
