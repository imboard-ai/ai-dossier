/** Gate 4 lifecycle acceptance: real createController, local Git and physical edge fakes.
 * Each title identifies the actor, expected outcome and owning PRD release slices. */

import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { TrustedGit } from '../canonical/trusted-git';
import { rig, TIME } from '../controller/__tests__/composition-fixture';
import { compositionHooks } from '../controller/__tests__/composition-hooks';
import { approveBudgetCeiling } from '../controller/budget-extension';
import { approveCheckpoint } from '../controller/checkpoints';
import { requestControl } from '../controller/control';
import { readOutcomeBudget } from '../controller/outcome-records';
import { RunStore } from '../controller/run-store';
import { loadVerification } from '../controller/verification-record';
import { parseJunitReport } from '../ecosystem/report';
import { INSTALLATION_ID, OWNER } from '../github/__tests__/github-fake';
import { type IntentInput, idempotencyKey } from '../intents';
import { Journal } from '../journal';
import * as receipts from '../receipt/issue';
import { ReasonCode, transitionRun } from '../state';

type Rig = ReturnType<typeof rig>;
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const audits: Rig[] = [];

// Register the audit before fixture cleanup closes/removes the pinned journals.
compositionHooks(async () => {
  for (const h of audits.splice(0)) await assertGlobalInvariants(h);
});

function fixture(options: Parameters<typeof rig>[0] = {}) {
  const h = rig(options);
  audits.push(h);
  return h;
}

function rows(h: Rig, name: Parameters<RunStore['storeDirectory']>[0], child?: string) {
  const a = h.artifacts(h.controller.snapshot().runId);
  if (name === 'control' && child === 'steps') {
    try {
      return a.events() as Record<string, unknown>[];
    } finally {
      a.close();
    }
  }
  const journal = new Journal(path.join(a.store.storeDirectory(name), ...(child ? [child] : [])));
  try {
    return journal.read() as Record<string, unknown>[];
  } finally {
    journal.close();
    a.close();
  }
}

/** One audit for every scenario, including refusal paths. Load real supervisor evidence,
 * compare durable write identities and verify each outstanding guest is reported. */
async function assertGlobalInvariants(h: Rig) {
  const id = h.controller.snapshot().runId;
  const a = h.artifacts(id);
  try {
    const candidate = a.get<{ record: { candidateSha: string } }>('candidate');
    const forkRefs = h.fork
      .git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
      .split('\n')
      .filter(Boolean);
    expect(forkRefs.every((ref) => ref === `refs/heads/ztfc/${a.store.contributionId}`)).toBe(true);
    const remote = h.fork.sha(`ztfc/${a.store.contributionId}`);
    if (remote) {
      expect(remote).toBe(candidate.record.candidateSha);
      const signed = a.get<{
        receipt: { schemaVersion: string; candidateSha: string; forkRepositoryId: number };
      }>('receipt');
      expect(signed.receipt).toMatchObject({
        schemaVersion: 'ztfc-receipt-v2',
        candidateSha: remote,
      });
      expect(loadVerification(a.dir, remote, { runId: id })).toMatchObject({
        verdict: 'passed',
        boundaryHeld: true,
        regression: 'reproduced_and_fixed',
      });
    }
    const verificationDir = path.join(a.dir, 'verification');
    if (fs.existsSync(verificationDir)) {
      for (const name of fs
        .readdirSync(verificationDir)
        .filter((n) => /^[a-f0-9]{40}\.json$/u.test(n))) {
        const record = loadVerification(a.dir, name.slice(0, -5), { runId: id });
        if (record.verdict === 'passed') {
          expect(record.boundaryHeld).toBe(true);
          expect(record.commands.every((command) => command.status === 'passed')).toBe(true);
          for (const command of record.commands) {
            const observed = h.executions.find((execution) => {
              const report = parseJunitReport(execution.result.report);
              const guest = h.vm.vms.get(execution.vmId);
              return (
                execution.request.argv.join(' ') === command.command &&
                execution.request.network === 'none' &&
                execution.result.exitCode === command.exitStatus &&
                !execution.result.timedOut &&
                !execution.result.truncated &&
                report?.suites === command.suites &&
                guest?.files.get('src/duration.js')?.bytes.toString().includes('millis / 1000')
              );
            });
            expect(observed, `supervised command ${command.id}`).toBeDefined();
          }
        }
      }
    }
    for (const key of ['publication', 'tracking']) {
      const observed = a.get<{ ci: string }>(key);
      // This edge has no GitHub checks: it cannot supply a supervised CI pass.
      if (observed) expect(observed.ci).not.toBe('passed');
    }
    for (const guest of h.vm.vms.values())
      if (guest.destroyed)
        expect(h.vm.calls).toContainEqual(
          expect.objectContaining({ op: 'destroy', vmId: guest.handle.vmId })
        );
    const guests = await h.vm.listByRun(id);
    if (guests.length) {
      expect(a.store.run.state).toBe('blocked_cleanup');
      const j = new Journal(path.join(a.store.storeDirectory('control'), 'controller'));
      const cleanup = j.read();
      j.close();
      for (const guest of guests)
        expect(cleanup).toContainEqual(
          expect.objectContaining({ type: 'cleanup', vmId: guest.vmId, kind: 'blocked_cleanup' })
        );
    }
    expect([...h.fake.tokens.values()].filter((token) => token.live)).toEqual([]);
    expect([...h.fake.tokens.values()].filter((token) => token.refreshAlive)).toEqual([]);
    expect([...h.fake.refreshTokens.values()].filter((token) => token.live)).toEqual([]);
    expect(
      h.fake.calls.filter(
        (call) => call.method !== 'GET' && /\/(pulls|issues)(\/|$)/u.test(call.path)
      )
    ).toEqual([]);
  } finally {
    a.close();
  }
  const links = rows(h, 'handoff').filter((row) => row.type === 'link_issued');
  const linkKeys = links.map((row) => idempotencyKey(row.input as IntentInput));
  expect(new Set(linkKeys).size).toBe(links.length);
  expect(new Set(links.map((row) => row.bodyFile)).size).toBe(links.length);
  const pushRows = rows(h, 'push-ledger');
  const writes = pushRows.filter((row) => row.type === 'push_verified');
  for (const row of writes) expect(typeof row.key).toBe('string');
  expect(new Set(writes.map((row) => row.key)).size).toBe(writes.length);
  const attempts = pushRows.filter((row) => row.type === 'push_intended');
  if (attempts.length) {
    const authorizations = rows(h, 'nonces');
    const artifacts = h.artifacts(id);
    const signed = artifacts.history<receipts.SignedReceipt>('receipt');
    artifacts.close();
    for (const attempt of attempts) {
      const authorization = authorizations.find(
        (row) => row.operationKey === attempt.key && row.attempt === attempt.attempt
      );
      expect(authorization).toBeDefined();
      const receipt = signed.find((row) => row.digest === authorization?.receiptDigest);
      expect(receipt?.receipt).toMatchObject({
        schemaVersion: 'ztfc-receipt-v2',
        candidateSha: attempt.candidateSha,
      });
      expect(receipt?.receipt.permittedShippingOperations).toContainEqual(
        expect.objectContaining({ kind: 'push_branch', operationKey: attempt.key })
      );
    }
  }
  for (const call of vi
    .mocked(TrustedGit.prototype.execAsync)
    .mock.calls.filter((c) => c[0][0] === 'push' && c[0].includes(`file://${h.fork.dir}`))) {
    const refspec = call[0].at(-1) as string;
    expect(attempts).toContainEqual(
      expect.objectContaining({
        candidateSha: refspec.split(':')[0],
        branch: refspec.split('refs/heads/')[1],
      })
    );
  }
}

function control(h: Rig, kind: 'pause' | 'cancel') {
  const store = RunStore.open(
    path.join(h.config.executionProfile.stateDir, 'runs'),
    h.controller.snapshot().runId,
    { readOnly: true, observe: true }
  );
  try {
    return requestControl(
      store,
      { kind, reason: 'Contributor lifecycle instruction' },
      new Date(TIME)
    );
  } finally {
    store.close();
  }
}

function barrier() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async wait() {
      reach();
      await released;
    },
  };
}

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
    expect((await h.controller.resume(run.runId)).state).toBe('blocked_cleanup');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.execs()).toHaveLength(executions);
    expect(
      vi.mocked(TrustedGit.prototype.execAsync).mock.calls.filter((call) => call[0][0] === 'push')
    ).toHaveLength(pushes);
    const a = h.artifacts(run.runId);
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
    const observed = h.executions.splice(0);
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    h.executions.push(...observed);
  });

  it('actor=GitHub fork timing outcome=wait without compute then resumes shipping owner=S4/S5', async () => {
    const h = fixture({ missingFork: true });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      state: string;
      runId: string;
    };
    expect(run.state).toBe('awaiting_contributor');
    expect(h.controller.snapshot().reasonCode).toBe(ReasonCode.ForkMissing);
    const calls = h.modelCalls();
    const creates = h.vm.calls.filter((c) => c.op === 'create').length;
    expect((await h.controller.resume(run.runId)).state).toBe('awaiting_contributor');
    expect(h.modelCalls()).toBe(calls);
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(creates);
    h.forkPresent();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    expect(h.controller.snapshot().history.some((row) => row.to === 'shipping')).toBe(true);
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
