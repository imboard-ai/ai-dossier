import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeVmAdapter } from '../__tests__/fake-vm';
import { candidateInput, harness, removeTemps, TIME } from '../__tests__/verifier-fixture';
import { BudgetLedger } from '../budget';
import type { BudgetEstimate, BudgetObservation } from '../budget-types';
import { sha256 } from '../canonical/export';
import { isAdmitted } from '../intents';
import { Journal } from '../journal';
import { ReasonCode, transitionRun } from '../state';
import { ScriptedRecovery, ScriptedSteps } from './__tests__/fake-steps';
import { approveCheckpoint } from './checkpoints';
import { validateRunConfig } from './config';
import { requestControl } from './control';
import { ControllerError, type PhaseContext, RunController } from './controller';
import { RunStore } from './run-store';
import { StepArtifacts } from './steps';
import {
  clearControllerRefusalNotice,
  controllerRefusalNotice,
  recordStopNotice,
  STOP_NOTICE_KEY,
  stopNoticeAction,
} from './stop-notice';
import {
  publishVerification,
  type VerificationRecord,
  type VerificationVerdict,
} from './verification-record';
import { verifyCandidate } from './verifier';

it('interrupt joins verification cleanup and resumes the exact phase without replaying implementation', async () => {
  const h = rig();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.steps.scripts.verify = [
    async (c) => {
      await c.createVm({ scope: 'container' });
      entered();
      await new Promise<void>((resolve) =>
        c.signal.addEventListener('abort', () => resolve(), { once: true })
      );
      throw new Error('verification interrupted');
    },
  ];
  const running = h.controller.start(h.config);
  await ready;
  await h.controller.interrupt();
  const paused = await running;
  expect(paused.state).toBe('paused_user');
  expect(paused.history.at(-1)?.from).toBe('verifying');
  expect(h.vm.liveVms()).toEqual([]);
  const resumed = await h.controller.resume(paused.runId);
  expect(resumed.state).toBe('submitted');
  expect(h.steps.calls.filter((phase) => phase === 'verify')).toHaveLength(2);
  expect(h.steps.calls.filter((phase) => phase === 'implement')).toHaveLength(1);
});

it.each([
  'paused_user',
  'awaiting_maintainer',
] as const)('interrupt during %s recovery preserves the resumable no-compute state', async (state) => {
  const h = rig();
  h.steps.scripts.gate = [
    state === 'paused_user' ? { kind: 'proceed' } : { kind: 'request_permission' },
  ];
  if (state === 'paused_user') h.steps.scripts.plan = [{ kind: 'hand_off' }];
  const initial = await h.controller.start(h.config);
  expect(initial.state).toBe(state);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.recovery.recoverCredentials = async (c?: PhaseContext) => {
    if (!c) throw new Error('missing context');
    entered();
    await new Promise<void>((resolve) =>
      c.signal.addEventListener('abort', () => resolve(), { once: true })
    );
  };
  const priorCalls = h.steps.calls.length;
  const running = h.controller.resume(initial.runId);
  await ready;
  await h.controller.interrupt();
  expect((await running).state).toBe(state);
  expect(h.steps.calls).toHaveLength(priorCalls);
  const store = RunStore.open(h.deps.root, initial.runId);
  expect(store.run.state).toBe(state);
  store.close();
});

it.each([
  false,
  true,
])('release-time interrupt joins cleanup even when work rejects (%s)', async (fails) => {
  const h = rig();
  h.steps.scripts.gate = [
    async (c) => {
      await c.createVm({ scope: 'container' });
      if (fails) throw new Error('provider failed');
      return { kind: 'hand_off' };
    },
  ];
  let releasing!: () => void;
  let release!: () => void;
  let destroying!: () => void;
  let finishDestroy!: () => void;
  const ready = new Promise<void>((resolve) => {
    releasing = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedDestroy = new Promise<void>((resolve) => {
    destroying = resolve;
  });
  const heldDestroy = new Promise<void>((resolve) => {
    finishDestroy = resolve;
  });
  const destroy = h.vm.destroy.bind(h.vm);
  h.vm.destroy = async (vm) => {
    destroying();
    if (fails) await heldDestroy;
    await destroy(vm);
  };
  const controller = new RunController({
    ...h.deps,
    release: async () => {
      releasing();
      await held;
    },
  });
  const running = controller.start(h.config);
  const outcome = running.then(
    (run) => ({ run, error: null }),
    (error) => ({ run: null, error })
  );
  await ready;
  let interrupted = false;
  const interrupt = controller.interrupt().then(() => {
    interrupted = true;
  });
  if (fails) await startedDestroy;
  await new Promise((resolve) => setImmediate(resolve));
  expect(interrupted).toBe(false);
  expect(h.vm.liveVms()).toHaveLength(fails ? 1 : 0);
  release();
  finishDestroy();
  await interrupt;
  expect(h.vm.liveVms()).toEqual([]);
  const result = await outcome;
  if (fails) expect(result.error).toMatchObject({ code: 'step_failed' });
  const store = RunStore.open(h.deps.root, controller.snapshot().runId);
  expect(store.run.state).toBe('paused_user');
  store.close();
});

it.each([
  'release',
  'retire',
] as const)('interrupt propagates %s failures after applying pause', async (failure) => {
  const h = rig();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.steps.scripts.gate = [
    async (c) => {
      entered();
      await new Promise<void>((resolve) =>
        c.signal.addEventListener('abort', () => resolve(), { once: true })
      );
      return { kind: 'hand_off' };
    },
  ];
  const error = new Error(`${failure}_failed`);
  const controller = new RunController({
    ...h.deps,
    release: async () => {
      if (failure === 'release') throw error;
    },
    retire: () => {
      if (failure === 'retire') throw error;
    },
  });
  const running = controller.start(h.config).catch((e) => e);
  await ready;
  await expect(controller.interrupt()).rejects.toBe(error);
  expect(await running).toBe(error);
});

let template: VerificationRecord;
let artifacts: string;
const roots: string[] = [];
const SHA = 'c'.repeat(40);
beforeAll(async () => {
  const h = harness();
  const result = await verifyCandidate(h.deps(), candidateInput());
  if (result.kind !== 'verified') throw new Error('fixture verification failed');
  template = result.record;
  artifacts = h.artifactsDir;
});
afterAll(removeTemps);
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function observation(estimate: BudgetEstimate): BudgetObservation {
  return {
    money: estimate.money,
    tokens: estimate.tokens,
    timeMs: estimate.timeMs,
    source: 'fake-observed',
  };
}
function record(
  context: PhaseContext,
  verdict: VerificationVerdict = 'passed',
  boundaryHeld = true
): VerificationRecord {
  const dir = context.store.storeDirectory('artifacts');
  fs.cpSync(artifacts, dir, { recursive: true });
  const input = JSON.parse(
    fs.readFileSync(path.join(artifacts, template.boundaryInputRef.artifact), 'utf8')
  );
  input.runId = context.run.runId;
  if (!boundaryHeld) input.malformedReports = 1;
  const bytes = Buffer.from(JSON.stringify(input));
  const boundaryName = `boundary-${sha256(String(context.run.history.length)).slice(0, 32)}.json`;
  fs.writeFileSync(path.join(dir, boundaryName), bytes, { mode: 0o600 });
  const { schemaVersion: _, recordDigest: __, ...body } = template;
  const candidateSha = latestSha;
  return publishVerification(dir, {
    ...body,
    runId: context.run.runId,
    candidateSha,
    verdict,
    boundaryHeld,
    boundaryInputRef: { artifact: boundaryName, digest: sha256(bytes) },
  });
}
let latestSha = SHA;
function rig(checkpoints: ('plan' | 'patch' | 'verification')[] = []) {
  latestSha = SHA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-controller-'));
  roots.push(root);
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const rate = {
    resource: 'vm',
    currency: 'USD',
    unit: 'vm_increment' as const,
    price: 1,
    units: 1,
    source: 'fixture',
    fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: TIME },
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      profileDir: 'profile',
      stateDir: 'state',
      accelerator: 'auto',
      proxyEndpointsFile: 'endpoints.json',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: [{ ...rate, resource: 'fake', unit: 'token', price: 0 }],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 1000,
      activeMinutes: 120,
    },
    checkpoints,
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
  });
  const estimate: BudgetEstimate = {
    money: { currency: 'USD', minor: 1 },
    tokens: 0,
    timeMs: 10,
    rates: [rate],
  };
  const recovery = new ScriptedRecovery();
  const vm = new FakeVmAdapter();
  const seen: string[][] = [[], [], []];
  const writes = new Set<string>();
  let duplicates = 0;
  const write = (key: string) => {
    if (writes.has(key)) duplicates++;
    else writes.add(key);
  };
  const bindings = (c: PhaseContext) => ({
    policyDigest: 'a'.repeat(64),
    budgetSessionId: c.sessionId,
  });
  const steps = new ScriptedSteps({
    gate: async () => ({ kind: 'proceed' }),
    acquire: async () => ({ kind: 'acquired' }),
    plan: async (c) => {
      write('plan');
      c.store.replaceArtifact('plan.txt', Buffer.from('plan'));
      return { kind: 'planned', bindings: { ...bindings(c), planDigest: sha256('plan') } };
    },
    implement: async (c) => {
      write(`candidate-${c.run.history.length}`);
      latestSha = c.run.history.some(
        (e) =>
          e.reasonCode === ReasonCode.RepairRequired ||
          e.reasonCode === ReasonCode.RevisionRequested
      )
        ? sha256(String(c.run.history.length)).slice(0, 40)
        : SHA;
      c.store.replaceArtifact('candidate.diff', Buffer.from('diff'));
      return { kind: 'candidate', bindings: { ...bindings(c), candidateSha: latestSha } };
    },
    review: async () => ({ kind: 'approved' }),
    verify: async (c) => ({ kind: 'verified', record: record(c) }),
    drift: async () => ({ kind: 'unchanged' }),
    ship: async (c) => {
      write(
        `pr-${c.run.history.filter((e) => e.reasonCode === ReasonCode.PublicationObserved).length}`
      );
      return { kind: 'submitted' };
    },
    resumeHandoff: async () => ({ kind: 'waiting' }),
    track: async () => ({ kind: 'waiting' }),
  });
  let now = new Date(TIME);
  const deps = {
    recordControllerStop: (
      c: PhaseContext,
      reason: import('./stop-notice').ControllerRefusalReason | null,
      pending: boolean
    ): void | Promise<void> => {
      const journal = new Journal(path.join(c.store.storeDirectory('control'), 'steps'));
      try {
        const artifacts = new StepArtifacts(journal, c.run.runId);
        if (reason)
          recordStopNotice(
            artifacts,
            c.run,
            controllerRefusalNotice(reason, pending ? 'paused_user' : c.run.state),
            pending
          );
        else clearControllerRefusalNotice(artifacts);
      } finally {
        journal.close();
      }
    },
    root: path.join(root, 'runs'),
    steps,
    recovery,
    vm,
    drivers: seen.map((list) => ({ observeRun: (run: { state: string }) => list.push(run.state) })),
    estimateVm: () => estimate,
    observeVm: async (hold: { estimate: BudgetEstimate }) => observation(hold.estimate),
    now: () => now,
  };
  const controller = new RunController(deps);
  return {
    config,
    deps,
    controller,
    steps,
    recovery,
    vm,
    seen,
    estimate,
    writes,
    duplicates: () => duplicates,
    setTime: (time: string) => {
      now = new Date(time);
    },
  };
}
function open(h: ReturnType<typeof rig>, runId: string) {
  return RunStore.open(h.deps.root, runId);
}

function notice(h: ReturnType<typeof rig>, runId: string) {
  const store = open(h, runId);
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  try {
    const retained = new StepArtifacts(journal, runId).get(STOP_NOTICE_KEY);
    return { retained, action: stopNoticeAction(retained, store.run) };
  } finally {
    journal.close();
    store.close();
  }
}

describe('RunController', () => {
  it('cancellation reconciles pending publication before stale-guest destruction and notifies every recovered transition', async () => {
    const h = rig();
    h.steps.scripts.ship = [{ kind: 'contributor_handoff' }];
    const run = await h.controller.start(h.config);
    const sequence: string[] = [];
    Object.assign(h.recovery, {
      reconcileControl: async (c: PhaseContext) => {
        sequence.push('publication');
        return transitionRun(c.store.run, ReasonCode.PublicationObserved, TIME);
      },
      prepareCancellation: async (c: PhaseContext) => {
        sequence.push(`withdraw-${c.store.run.state}`);
      },
      endRun: async () => {
        sequence.push('revoke');
      },
    });
    const stale = await h.vm.create({
      runId: run.runId,
      limits: h.config.limits,
      scope: 'container',
      phase: 'verification',
    });
    const destroy = h.vm.destroy.bind(h.vm);
    vi.spyOn(h.vm, 'destroy').mockImplementation(async (handle) => {
      sequence.push('destroy');
      return destroy(handle);
    });
    const store = open(h, run.runId);
    requestControl(store, { kind: 'cancel', reason: 'User cancellation' }, new Date(TIME));
    store.close();
    const cancelled = await h.controller.resume(run.runId);
    expect(cancelled.state).toBe('cancelled');
    expect(sequence.indexOf('publication')).toBeLessThan(sequence.indexOf('destroy'));
    expect(sequence).toContain('withdraw-submitted');
    expect(sequence).toContain('revoke');
    expect(h.vm.destroy).toHaveBeenCalledWith(expect.objectContaining({ vmId: stale.vmId }));
    for (const seen of h.seen) expect(seen.slice(-2)).toEqual(['submitted', 'cancelled']);
  });
  it.each([
    null,
    'guest-absent-accounted',
  ])('queued cancellation reconciles unfunded cleanup crash-prefix evidence (%s)', async (evidence) => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'hand_off' }];
    const run = await h.controller.start(h.config);
    const reconcileCleanup = vi.fn(async () => evidence);
    const endRun = vi.fn(async () => {});
    Object.assign(h.recovery, { reconcileCleanup, endRun });
    const store = open(h, run.runId);
    const journal = new Journal(path.join(store.storeDirectory('control'), 'controller'));
    journal.append({
      v: 1,
      type: 'cleanup',
      runId: run.runId,
      vmId: 'interrupted-guest',
      kind: 'pending',
      funded: false,
    });
    journal.close();
    requestControl(store, { kind: 'cancel', reason: 'User cancellation' }, new Date(TIME));
    store.close();
    expect((await h.controller.resume(run.runId)).state).toBe(
      evidence === null ? 'blocked_cleanup' : 'cancelled'
    );
    expect(reconcileCleanup).toHaveBeenCalledWith('interrupted-guest', expect.anything());
    expect(endRun).toHaveBeenCalled();
  });
  it('time parked after a gate hand-off is not active time (#1184)', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'hand_off' }];
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('gating');
    // Parked far beyond the 120-minute active budget waiting on the operator.
    h.setTime(new Date(Date.parse(TIME) + 6 * 3_600_000).toISOString());
    expect((await h.controller.resume(run.runId)).state).toBe('submitted');
    expect(h.steps.calls.filter((call) => call === 'gate')).toHaveLength(2);
  });
  it('runs direct proceed to submitted, persists and fans out every transition', async () => {
    const h = rig();
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('submitted');
    expect(h.steps.calls).toEqual([
      'gate',
      'acquire',
      'plan',
      'implement',
      'review',
      'verify',
      'drift',
      'ship',
    ]);
    for (const seen of h.seen)
      expect(seen).toEqual(['gating', ...run.history.map((event) => event.to)]);
    const store = open(h, run.runId);
    expect(store.validateEvidence()).toEqual(run);
    store.close();
    expect(h.controller.snapshot()).toEqual(run);
  });
  it.each([
    ['request_permission', 'awaiting_maintainer'],
    ['terminate', 'blocked'],
    ['ineligible', 'blocked'],
    ['hand_off', 'gating'],
    ['unsupported', 'unsupported'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('stops gate %s at %s', async (kind, state) => {
    const h = rig();
    h.steps.scripts.gate = [{ kind }];
    const run = await h.controller.start(h.config);
    expect(run.state).toBe(state);
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('allows two repairs then fails; never admits another implementation', async () => {
    const h = rig();
    h.steps.scripts.verify = Array.from({ length: 3 }, () => async (c: PhaseContext) => ({
      kind: 'verified' as const,
      record: record(c, 'failed'),
    }));
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('failed');
    expect(run.history.filter((e) => e.reasonCode === ReasonCode.RepairRequired)).toHaveLength(2);
    expect(h.steps.calls.filter((c) => c === 'implement')).toHaveLength(3);
  });
  it('blocks a failed boundary despite a passing verification verdict', async () => {
    const h = rig();
    h.steps.scripts.verify = [
      async (c) => ({ kind: 'verified', record: record(c, 'passed', false) }),
    ];
    expect((await h.controller.start(h.config)).state).toBe('blocked');
    expect(h.steps.calls).not.toContain('ship');
  });
  it('resumes missing fork through shipping and does not poll the wait', async () => {
    const h = rig();
    h.steps.scripts.ship = [{ kind: 'fork_missing' }, { kind: 'hand_off' }];
    const wait = await h.controller.start(h.config);
    expect(wait.state).toBe('awaiting_contributor');
    h.steps.scripts.resumeHandoff = [{ kind: 'resume_shipping' }];
    h.recovery.calls.length = 0;
    const run = await h.controller.resume(wait.runId);
    expect(
      run.history.some((e) => e.to === 'shipping' && e.reasonCode === ReasonCode.ResumeShipping)
    ).toBe(true);
    expect(run.state).toBe('paused_user');
    expect(h.recovery.calls).toEqual([
      'store',
      'budget',
      'vm',
      'credentials',
      'intents',
      'handoff',
    ]);
  });
  it.each([
    'plan',
    'patch',
    'verification',
  ] as const)('pauses at %s then approved resume continues without repeated writes', async (point) => {
    const h = rig([point]);
    const paused = await h.controller.start(h.config);
    expect(paused.state).toBe('paused_user');
    const store = open(h, paused.runId);
    const checkpoint = store.checkpoint(point);
    if (!checkpoint) throw new Error('checkpoint missing');
    approveCheckpoint(store, store.run, { point, digest: checkpoint.digest }, TIME);
    store.close();
    expect((await h.controller.resume(paused.runId)).state).toBe('submitted');
    expect(h.duplicates()).toBe(0);
  });
  it.each([
    'gate',
    'acquire',
    'plan',
    'implement',
    'review',
    'verify',
    'drift',
    'ship',
  ] as const)('crashes at next step %s and resumes with zero duplicate writes', async (phase) => {
    const h = rig();
    h.steps.scripts[phase] = [
      () => {
        throw new Error('injected crash');
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    const id = h.controller.snapshot().runId;
    h.recovery.calls.length = 0;
    expect((await new RunController(h.deps).resume(id)).state).toBe('submitted');
    expect(h.duplicates()).toBe(0);
    expect(h.recovery.calls).toEqual(['store', 'budget', 'vm', 'credentials', 'intents']);
  });
  it('held reservation blocks step(), persists a stop notice, and invokes no phase work', async () => {
    const h = rig();
    h.steps.scripts.plan = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        c.ledger.reserve(c.sessionId, h.estimate);
        throw new Error('crash');
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    const id = h.controller.snapshot().runId;
    const calls = h.steps.calls.length;
    h.recovery.calls.length = 0;
    const resumed = await h.controller.resume(id);
    expect(resumed.state).toBe('paused_user');
    expect(h.steps.calls).toHaveLength(calls);
    expect(h.recovery.calls).toEqual(['store', 'budget', 'hold', 'vm', 'credentials', 'intents']);
    expect(await h.vm.listByRun(id)).toHaveLength(0);
    const store = open(h, id);
    const budget = new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
    expect(
      budget.snapshot().reservations.some((r) => r.purpose === 'work' && r.status === 'reserved')
    ).toBe(true);
    expect(
      budget.snapshot().reservations.some((r) => r.purpose === 'teardown' && r.status === 'settled')
    ).toBe(true);
    expect(() => budget.reserve(store.budgetSessionId(1), h.estimate)).toThrow('Reconcile');
    store.close();
    expect(notice(h, id).action).toContain('hold_unsettled');
    expect((await new RunController(h.deps).resume(id)).state).toBe('paused_user');
    expect(h.steps.calls).toHaveLength(calls);
    expect(notice(h, id).action).toContain('hold_unsettled');
  });
  it('three destroy failures persist blocked_cleanup and deny all later work', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    const destroy = vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('blocked_cleanup');
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(h.steps.calls).toEqual(['gate']);
    expect(isAdmitted('push_branch', run.state)).toBe(false);
    expect((await h.controller.resume(run.runId)).state).toBe('blocked_cleanup');
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('checks active time before the next step within the same phase', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async () => {
        h.setTime('2026-10-08T02:00:00.000Z');
        return { kind: 'acquired' };
      },
    ];
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('paused_user');
    expect(h.steps.calls).not.toContain('plan');
    expect(notice(h, run.runId).retained).toMatchObject({
      state: 'paused_user',
      historyLength: run.history.length,
      reason: 'active_time_exhausted',
    });
    expect(notice(h, run.runId).action).toContain('start a new run');
  });
  it('retains a gate budget refusal without a transition and retires it after extension', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'hand_off' }];
    const run = await h.controller.start(h.config);
    const store = open(h, run.runId);
    const ledger = new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
    const sessionId = store.budgetSessionId(1);
    const hold = ledger.reserve(sessionId, {
      ...h.estimate,
      money: { currency: 'USD', minor: 90 },
    });
    ledger.settle(hold.id, {
      ...observation(hold.estimate),
      money: { currency: 'USD', minor: 100 },
    });
    store.close();
    expect((await h.controller.resume(run.runId)).history).toEqual(run.history);
    expect(h.steps.calls).toEqual(['gate']);
    expect(notice(h, run.runId).retained).toMatchObject({
      state: 'gating',
      historyLength: 0,
      reason: 'budget_exhausted',
    });
    expect(notice(h, run.runId).action).toContain('budget_exhausted');
    // Exercise the ledger's trusted extension, not an invented observation or hold release.
    ledger.extendCeiling({
      sessionId,
      previousMinor: 100,
      ceiling: { currency: 'USD', minor: 200 },
      approvalId: 'fixture-extension',
      approvedAt: TIME,
      actor: 'user',
    });
    expect((await h.controller.resume(run.runId)).state).toBe('submitted');
    expect(notice(h, run.runId).retained).toBeNull();
  });
  it('rechecks active time after awaited notice retirement before admitting a phase (#1191)', async () => {
    const h = rig();
    const record = h.deps.recordControllerStop;
    h.deps.recordControllerStop = async (c, reason, pending) => {
      await record(c, reason, pending);
      if (reason === null && h.steps.calls.includes('acquire')) {
        await Promise.resolve();
        h.setTime('2026-10-08T02:00:00.000Z');
      }
    };
    const run = await h.controller.start(h.config);
    expect(h.steps.calls).toEqual(['gate', 'acquire']);
    expect(run.state).toBe('paused_user');
    expect(notice(h, run.runId).retained).toMatchObject({
      state: run.state,
      historyLength: run.history.length,
      reason: 'active_time_exhausted',
    });
    expect(notice(h, run.runId).action).toContain('active_time_exhausted');
  });
  it.each([
    false,
    true,
  ])('joins cleanup before propagating notice persistence failure (retirement=%s)', async (retirement) => {
    const h = rig();
    h.steps.scripts.acquire = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        if (!retirement) h.setTime('2026-10-08T02:00:00.000Z');
        return { kind: 'acquired' };
      },
    ];
    h.deps.recordControllerStop = async (c, reason) => {
      if (reason || (retirement && h.steps.calls.includes('acquire'))) {
        await Promise.resolve();
        // Callback context has no allocation lease.
        await expect(c.createVm({ scope: 'container' })).rejects.toMatchObject({
          code: 'admission_closed',
        });
        throw new Error('notice persistence failed');
      }
    };
    const destroy = vi.spyOn(h.vm, 'destroy');
    await expect(h.controller.start(h.config)).rejects.toThrow('notice persistence failed');
    expect(h.steps.calls).not.toContain('plan');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await h.vm.listByRun(h.controller.snapshot().runId)).toEqual([]);
  });
  it('retains blocked_cleanup when notice persistence and guest destruction both fail', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        h.setTime('2026-10-08T02:00:00.000Z');
        return { kind: 'acquired' };
      },
    ];
    h.deps.recordControllerStop = async (_c, reason) => {
      if (reason) throw new Error('notice persistence failed');
    };
    const destroy = vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
    await expect(h.controller.start(h.config)).rejects.toThrow('notice persistence failed');
    expect(destroy).toHaveBeenCalledTimes(3);
    const store = open(h, h.controller.snapshot().runId);
    expect(store.run.state).toBe('blocked_cleanup');
    store.close();
    expect(h.steps.calls).not.toContain('plan');
  });
  it('awaits asynchronous notice persistence before returning a refusal', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async () => {
        h.setTime('2026-10-08T02:00:00.000Z');
        return { kind: 'acquired' };
      },
    ];
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = h.deps.recordControllerStop;
    h.deps.recordControllerStop = async (c, reason, pending) => {
      if (reason) {
        entered();
        await barrier;
      }
      await record(c, reason, pending);
    };
    let completed = false;
    const pending = h.controller.start(h.config).then((run) => {
      completed = true;
      return run;
    });
    await ready;
    expect(completed).toBe(false);
    expect(h.steps.calls).not.toContain('plan');
    release();
    const run = await pending;
    expect(notice(h, run.runId).action).toContain('active_time_exhausted');
  });
  it('binds a refusal to the final cleanup-blocked stop and its permitted retry action', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        h.setTime('2026-10-08T02:00:00.000Z');
        return { kind: 'acquired' };
      },
    ];
    const destroy = vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('blocked_cleanup');
    expect(destroy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.steps.calls).toEqual(['gate', 'acquire']);
    const retained = notice(h, run.runId);
    expect(retained.retained).toMatchObject({
      state: 'blocked_cleanup',
      historyLength: run.history.length,
      reason: 'active_time_exhausted',
    });
    expect(retained.action).toContain('explicitly resume to retry cleanup');
    expect(retained.action).toContain('cancellation is unavailable');
  });
  it('binds the notice when pause persistence cleanup cannot enumerate guests', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        h.setTime('2026-10-08T02:00:00.000Z');
        vi.spyOn(h.vm, 'listByRun').mockRejectedValue(new Error('enumeration failed'));
        return { kind: 'acquired' };
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'recovery_failed' });
    const id = h.controller.snapshot().runId;
    const store = open(h, id);
    const run = store.run;
    store.close();
    expect(run.state).toBe('blocked_cleanup');
    const retained = notice(h, id);
    expect(retained.retained).toMatchObject({
      state: run.state,
      historyLength: run.history.length,
      reason: 'active_time_exhausted',
    });
    expect(retained.action).toContain('explicitly resume to retry cleanup');
    expect(h.steps.calls).toEqual(['gate', 'acquire']);
  });
  it('recovery completes before any step, and recovery failure admits none', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const wait = await h.controller.start(h.config);
    vi.spyOn(h.recovery, 'recoverCredentials').mockRejectedValue(new Error('credential failure'));
    await expect(h.controller.resume(wait.runId)).rejects.toMatchObject({
      code: 'recovery_failed',
    });
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('resumes tracker once and retains completed publication history', async () => {
    const h = rig();
    const submitted = await h.controller.start(h.config);
    h.steps.scripts.track = [{ kind: 'merged' }];
    h.recovery.calls.length = 0;
    const merged = await h.controller.resume(submitted.runId);
    expect(merged.state).toBe('merged');
    expect(merged.history).toContainEqual(submitted.history.at(-1));
    expect(h.recovery.calls).toEqual([
      'store',
      'budget',
      'vm',
      'tracker',
      'credentials',
      'intents',
    ]);
  });
  it('incident stop aborts a live step, joins it and tears down before cancelled', async () => {
    const h = rig();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.steps.scripts.plan = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        entered();
        await new Promise<void>((resolve) =>
          c.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        return { kind: 'hand_off' };
      },
    ];
    const running = h.controller.start(h.config);
    await ready;
    expect(() => h.controller.start(h.config)).toThrow(ControllerError);
    const stopped = await h.controller.incidentStop('operator incident');
    expect(stopped.state).toBe('cancelled');
    expect(await running).toEqual(stopped);
    expect(h.recovery.calls).toContain('kill');
    expect(await h.vm.listByRun(stopped.runId)).toHaveLength(0);
    expect(h.steps.calls).not.toContain('implement');
  });
  it('incident racing completed publication records publication before cancellation', async () => {
    const h = rig();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.steps.scripts.ship = [
      async (c) => {
        entered();
        await new Promise<void>((resolve) =>
          c.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        return { kind: 'submitted' };
      },
    ];
    const running = h.controller.start(h.config);
    await ready;
    const stopped = await h.controller.incidentStop('operator incident');
    await running;
    expect(stopped.history.some((e) => e.reasonCode === ReasonCode.PublicationObserved)).toBe(true);
    expect(stopped.state).toBe('cancelled');
  });
  it('rejects malformed results and unknown outcomes without coercion', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'proceed', extra: true } as never];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
    expect(h.steps.calls).toEqual(['gate']);
    const store = open(h, h.controller.snapshot().runId);
    expect(store.run.state).toBe('blocked');
    store.close();
  });
  it('throws illegal edges instead of coercing handoff outcomes', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    h.steps.scripts.resumeHandoff = [{ kind: 'submitted' }];
    await expect(h.controller.resume(run.runId)).rejects.toThrow('Illegal zero-trust');
  });
  it('notifies all drivers even when one refuses; resumes from persisted state', async () => {
    const h = rig();
    h.deps.drivers.unshift({
      observeRun: () => {
        throw new Error('driver failure');
      },
    });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'driver_failed' });
    for (const seen of h.seen) expect(seen).toEqual(['gating']);
    h.deps.drivers.shift();
    expect((await h.controller.resume(h.controller.snapshot().runId)).state).toBe('submitted');
  });
  it('replays persisted ship evidence after a crash during fan-out, without duplicate publication', async () => {
    const h = rig();
    h.deps.drivers.push({
      observeRun: (run) => {
        if (run.state === 'submitted') throw new Error('crash');
      },
    });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'driver_failed' });
    h.deps.drivers.pop();
    expect((await h.controller.resume(h.controller.snapshot().runId)).state).toBe('submitted');
    expect(h.duplicates()).toBe(0);
  });
  it('verification record candidate identity cannot be substituted', async () => {
    const h = rig();
    h.steps.scripts.verify = [
      async (c) => {
        latestSha = 'd'.repeat(40);
        return { kind: 'verified', record: record(c) };
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
    expect(h.steps.calls).not.toContain('ship');
  });
  it('an external publication completed before step crash is reconciled without another write', async () => {
    const h = rig();
    h.steps.scripts.ship = [
      async () => {
        h.writes.add('pr-0');
        throw new Error('lost publication response');
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    const crashed = h.controller.snapshot();
    h.recovery.intentRun = transitionRun(crashed, ReasonCode.PublicationObserved, TIME);
    expect((await h.controller.resume(crashed.runId)).state).toBe('submitted');
    expect(h.steps.calls.filter((name) => name === 'ship')).toHaveLength(1);
    expect(h.duplicates()).toBe(0);
  });
  it('unknown work reconciliation followed by a real observation removes the admission barrier', async () => {
    const h = rig();
    h.steps.scripts.plan = [
      async (c) => {
        c.ledger.reserve(c.sessionId, h.estimate);
        throw new Error('crash');
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    h.recovery.reconcile = async (hold) => observation(hold.estimate);
    expect((await h.controller.resume(h.controller.snapshot().runId)).state).toBe('submitted');
  });
  it('terminal failure destroys VMs before persistence, and cleanup failure wins legally', async () => {
    const h = rig();
    h.steps.scripts.acquire = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'unsupported' };
      },
    ];
    vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('blocked_cleanup');
    expect(run.history.at(-1)?.from).toBe('planning');
    expect(h.steps.calls).not.toContain('plan');
  });
  it('attempts every VM after the first cleanup failure', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    const destroy = vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
    expect((await h.controller.start(h.config)).state).toBe('blocked_cleanup');
    expect(destroy).toHaveBeenCalledTimes(6);
  });
  it('financial cleanup refusal still destroys VMs and never admits a later phase', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    h.deps.estimateVm = (_spec, purpose) =>
      purpose === 'teardown'
        ? { ...h.estimate, money: { currency: 'USD', minor: 1000 } }
        : h.estimate;
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'admission_closed' });
    expect(await h.vm.listByRun(h.controller.snapshot().runId)).toHaveLength(0);
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('recovery rejects a rollback snapshot rather than silently admitting it', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    const store = open(h, run.runId);
    const original = {
      ...store.run,
      state: 'gating' as const,
      reasonCode: ReasonCode.RunCreated,
      history: [],
    };
    store.close();
    h.recovery.intentRun = original;
    await expect(h.controller.resume(run.runId)).rejects.toMatchObject({ code: 'invalid_outcome' });
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('refuses --revise before publication without touching the run', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    await expect(h.controller.resume(run.runId, { revise: true })).rejects.toMatchObject({
      code: 'revision_unavailable',
    });
    expect(h.controller.snapshot().state).toBe(run.state);
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('persists and fans out a multi-transition recovered snapshot individually', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    h.recovery.handoffRun = transitionRun(
      transitionRun(run, ReasonCode.MaintainerInvited, TIME),
      ReasonCode.GatePassed,
      TIME
    );
    expect((await h.controller.resume(run.runId)).state).toBe('submitted');
    for (const seen of h.seen)
      expect(seen.slice(2, 5)).toEqual(['awaiting_maintainer', 'gating', 'planning']);
  });
  it('records an advanced candidate and requires fresh verification before ship', async () => {
    const h = rig();
    h.steps.scripts.drift = [
      async (c) => {
        latestSha = 'd'.repeat(40);
        return {
          kind: 'advanced',
          bindings: {
            policyDigest: 'a'.repeat(64),
            budgetSessionId: c.sessionId,
            candidateSha: latestSha,
          },
        };
      },
    ];
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('submitted');
    expect(h.steps.calls.filter((name) => name === 'verify')).toHaveLength(2);
    expect(h.steps.calls.filter((name) => name === 'ship')).toHaveLength(1);
  });
  it('retains incident admission fence across an explicit resume', async () => {
    const h = rig();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.steps.scripts.gate = [
      async (c) => {
        entered();
        await new Promise<void>((resolve) =>
          c.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        throw new Error('aborted');
      },
    ];
    const task = h.controller.start(h.config);
    await ready;
    const cancelled = await h.controller.incidentStop('operator incident');
    await task;
    const count = h.steps.calls.length;
    expect((await h.controller.resume(cancelled.runId)).state).toBe('cancelled');
    expect(h.steps.calls).toHaveLength(count);
    expect(h.recovery.calls.filter((name) => name === 'kill')).toHaveLength(2);
  });
  it('refuses controller-journal recovery evidence and admits no step', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    const store = open(h, run.runId);
    const file = path.join(store.storeDirectory('control'), 'controller', 'events.jsonl');
    fs.appendFileSync(file, '{');
    store.close();
    await expect(h.controller.resume(run.runId)).rejects.toMatchObject({ code: 'invalid_journal' });
    expect(h.steps.calls).toEqual(['gate']);
  });
  it('refuses a VM with the wrong run identity', async () => {
    const h = rig();
    vi.spyOn(h.vm, 'create').mockResolvedValue({
      vmId: 'wrong',
      runId: 'other',
      accelerator: 'tcg',
      scope: 'container',
      profileDigest: 'a'.repeat(64),
    });
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'proceed' };
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
  });
  it('denies VM creation by a recovery hook before any step admission', async () => {
    const h = rig();
    h.steps.scripts.gate = [{ kind: 'request_permission' }];
    const run = await h.controller.start(h.config);
    vi.spyOn(h.recovery, 'recoverCredentials').mockImplementation(async (c) => {
      await c.createVm({ scope: 'container' });
    });
    await expect(h.controller.resume(run.runId)).rejects.toMatchObject({ code: 'recovery_failed' });
    expect(h.vm.calls.filter((c) => c.op === 'create')).toHaveLength(0);
  });
  it.each([
    'awaiting_maintainer',
    'paused_user',
  ] as const)('observer failure at %s cannot skip mandatory teardown', async (state) => {
    const h = rig(state === 'paused_user' ? ['plan'] : []);
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: state === 'paused_user' ? 'proceed' : 'request_permission' };
      },
    ];
    h.deps.drivers.push({
      observeRun: (run) => {
        if (run.state === state) throw new Error('observer failure');
      },
    });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'driver_failed' });
    expect(await h.vm.listByRun(h.controller.snapshot().runId)).toHaveLength(0);
    expect(h.steps.calls).not.toContain('implement');
  });
  it.each([
    'metering',
    'observer',
  ] as const)('cleanup %s failure still attempts all remaining guests', async (failure) => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    if (failure === 'metering')
      h.deps.observeVm = async (hold) => {
        if (hold.purpose === 'teardown') throw new Error('metering failed');
        return observation(hold.estimate);
      };
    else {
      vi.spyOn(h.vm, 'destroy').mockRejectedValue(new Error('destroy failed'));
      h.deps.drivers.push({
        observeRun: (run) => {
          if (run.state === 'blocked_cleanup') throw new Error('observer failed');
        },
      });
    }
    await expect(h.controller.start(h.config)).rejects.toMatchObject({
      code: failure === 'metering' ? 'recovery_failed' : 'driver_failed',
    });
    expect(h.vm.calls.filter((call) => call.op === 'destroy')).toHaveLength(
      failure === 'metering' ? 2 : 0
    );
    if (failure === 'metering')
      expect(await h.vm.listByRun(h.controller.snapshot().runId)).toHaveLength(0);
    else expect(vi.mocked(h.vm.destroy)).toHaveBeenCalledTimes(6);
  });
  it('unfunded cleanup fences every reopen until explicit accounting reconciliation', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    h.deps.estimateVm = (_spec, purpose) =>
      purpose === 'teardown'
        ? { ...h.estimate, money: { currency: 'USD', minor: 1000 } }
        : h.estimate;
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'admission_closed' });
    const id = h.controller.snapshot().runId;
    const calls = h.steps.calls.length;
    h.steps.scripts.resumeHandoff = [{ kind: 'invited' }];
    expect((await new RunController(h.deps).resume(id)).state).toBe('awaiting_maintainer');
    expect(h.steps.calls).toHaveLength(calls);
    h.deps.recovery.reconcileCleanup = async () => 'adapter proves destruction is not billable';
    expect((await new RunController(h.deps).resume(id)).state).toBe('submitted');
  });
  it('synchronous observing callback cannot reenter start or orphan a store lock', async () => {
    const h = rig();
    let refused = false;
    h.deps.drivers.unshift({
      observeRun: (run) => {
        if (run.state === 'gating') {
          expect(() => h.controller.start(h.config)).toThrow('busy');
          refused = true;
        }
      },
    });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('submitted');
    expect(refused).toBe(true);
    const store = open(h, run.runId);
    expect(store.run).toEqual(run);
    store.close();
  });
  it.each([
    'permission',
    'fork',
    'tracker',
  ] as const)('hand-off from durable %s observation preserves the stop', async (scenario) => {
    const h = rig();
    if (scenario === 'permission') h.steps.scripts.gate = [{ kind: 'request_permission' }];
    if (scenario === 'fork') h.steps.scripts.ship = [{ kind: 'fork_missing' }];
    const run = await h.controller.start(h.config);
    if (scenario === 'tracker') h.steps.scripts.track = [{ kind: 'hand_off' }];
    else h.steps.scripts.resumeHandoff = [{ kind: 'hand_off' }];
    expect((await h.controller.resume(run.runId)).state).toBe(run.state);
  });
  it.each([
    {},
    { policyDigest: 'bad', budgetSessionId: 'other', planDigest: 'a'.repeat(64) },
    { policyDigest: 'a'.repeat(64), budgetSessionId: 'other', planDigest: 'a'.repeat(64) },
  ])('rejects malformed nested bindings even with all checkpoints disabled: %j', async (bindings) => {
    const h = rig();
    h.steps.scripts.plan = [{ kind: 'planned', bindings } as never];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
    expect(h.steps.calls).not.toContain('implement');
  });
  it('missing verification digest cannot weaken returned-record binding', async () => {
    const h = rig();
    h.steps.scripts.verify = [
      async (c) => {
        const verified = record(c);
        return { kind: 'verified', record: { candidateSha: verified.candidateSha } } as never;
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
    expect(h.steps.calls).not.toContain('ship');
  });
  it.each([
    ReasonCode.RepairRequired,
    ReasonCode.BaseAdvanced,
    ReasonCode.MaintainerInvited,
    ReasonCode.ResumeShipping,
    ReasonCode.RevisionRequested,
    ReasonCode.ResumePlanning,
    ReasonCode.ResumeVerifying,
  ] as const)('crashes after persisted %s, then matches uninterrupted continuation with no duplicate writes', async (reason) => {
    const h = rig(
      reason === ReasonCode.ResumePlanning
        ? ['plan']
        : reason === ReasonCode.ResumeVerifying
          ? ['patch']
          : []
    );
    if (reason === ReasonCode.RepairRequired)
      h.steps.scripts.verify = [async (c) => ({ kind: 'verified', record: record(c, 'failed') })];
    if (reason === ReasonCode.BaseAdvanced)
      h.steps.scripts.drift = [
        async (c) => {
          latestSha = 'd'.repeat(40);
          return {
            kind: 'advanced',
            bindings: {
              policyDigest: 'a'.repeat(64),
              budgetSessionId: c.sessionId,
              candidateSha: latestSha,
            },
          };
        },
      ];
    if (reason === ReasonCode.MaintainerInvited) {
      h.steps.scripts.gate = [{ kind: 'request_permission' }];
      h.steps.scripts.resumeHandoff = [{ kind: 'invited' }];
    }
    if (reason === ReasonCode.ResumeShipping) {
      h.steps.scripts.ship = [{ kind: 'fork_missing' }];
      h.steps.scripts.resumeHandoff = [{ kind: 'resume_shipping' }];
    }
    if (reason === ReasonCode.RevisionRequested) h.steps.scripts.track = [{ kind: 'revision' }];
    let injected = false;
    h.steps.before = (_phase, c) => {
      if (!injected && c.run.history.some((event) => event.reasonCode === reason)) {
        injected = true;
        throw new Error('next-step crash');
      }
    };
    let run: Awaited<ReturnType<RunController['start']>>;
    try {
      run = await h.controller.start(h.config);
    } catch (error) {
      expect(error).toMatchObject({ code: 'step_failed' });
      run = h.controller.snapshot();
    }
    if (!injected) {
      if (run.state === 'paused_user') {
        const store = open(h, run.runId);
        const point = reason === ReasonCode.ResumePlanning ? 'plan' : 'patch';
        const checkpoint = store.checkpoint(point);
        if (!checkpoint) throw new Error('checkpoint missing');
        approveCheckpoint(store, store.run, { point, digest: checkpoint.digest }, TIME);
        store.close();
      }
      try {
        run = await h.controller.resume(run.runId);
      } catch (error) {
        expect(error).toMatchObject({ code: 'step_failed' });
        run = h.controller.snapshot();
      }
    }
    expect(injected).toBe(true);
    const resumed = await new RunController(h.deps).resume(run.runId);
    expect(resumed.state).toBe('submitted');
    expect(h.duplicates()).toBe(0);
  });
  it('VM-dependent acquisition provisions fresh resources after recovery while source writes stay idempotent', async () => {
    const h = rig();
    let sourceWrites = 0;
    const acquire = async (c: PhaseContext) => {
      const file = path.join(c.store.storeDirectory('artifacts'), 'source.txt');
      if (!fs.existsSync(file)) {
        c.store.replaceArtifact('source.txt', Buffer.from('source'));
        sourceWrites++;
      }
      await c.createVm({ scope: 'container' });
      return { kind: 'acquired' as const };
    };
    h.steps.scripts.acquire = [acquire, acquire];
    h.steps.scripts.plan = [
      () => {
        throw new Error('next-step crash');
      },
      async (c) => {
        expect(await h.vm.listByRun(c.run.runId)).toHaveLength(1);
        c.store.replaceArtifact('plan.txt', Buffer.from('plan'));
        return {
          kind: 'planned',
          bindings: {
            policyDigest: 'a'.repeat(64),
            budgetSessionId: c.sessionId,
            planDigest: sha256('plan'),
          },
        };
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    const id = h.controller.snapshot().runId;
    expect((await new RunController(h.deps).resume(id)).state).toBe('submitted');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(2);
    expect(sourceWrites).toBe(1);
    expect(h.duplicates()).toBe(0);
    expect(await h.vm.listByRun(id)).toHaveLength(0);
  });
  it('invalid phase output aborts and cleans its allocated guest before releasing the run fence', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'proceed', extra: true } as never;
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'invalid_outcome' });
    const run = h.controller.snapshot();
    expect(run.state).toBe('blocked');
    expect(await h.vm.listByRun(run.runId)).toHaveLength(0);
    const store = open(h, run.runId);
    expect(store.run.state).toBe('blocked');
    store.close();
  });
  it('observer refusal during reopen cannot suppress VM, credential or incident revocation recovery', async () => {
    const h = rig();
    h.steps.scripts.plan = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        throw new Error('crash');
      },
    ];
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    const id = h.controller.snapshot().runId;
    h.deps.drivers.push({
      observeRun: () => {
        throw new Error('driver refused');
      },
    });
    h.recovery.calls.length = 0;
    await expect(h.controller.resume(id)).rejects.toMatchObject({ code: 'driver_failed' });
    expect(h.recovery.calls).toEqual(['store', 'budget', 'vm', 'credentials']);
    expect(await h.vm.listByRun(id)).toHaveLength(0);
  });
  it('an expired allocation capability cannot allocate against a later run', async () => {
    const h = rig();
    let previous: PhaseContext | undefined;
    h.steps.scripts.gate = [
      async (c) => {
        previous = c;
        return { kind: 'request_permission' };
      },
    ];
    const first = await h.controller.start(h.config);
    h.steps.scripts.gate = [
      async (current) => {
        if (!previous) throw new Error('missing old context');
        await expect(previous.createVm({ scope: 'container' })).rejects.toMatchObject({
          code: 'admission_closed',
        });
        expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(0);
        const vm = await current.createVm({ scope: 'container' });
        expect(vm.runId).not.toBe(first.runId);
        return { kind: 'request_permission' };
      },
    ];
    const second = await h.controller.start(h.config);
    expect(second.runId).not.toBe(first.runId);
    expect(await h.vm.listByRun(second.runId)).toHaveLength(0);
  });
  it('a finished phase allocation capability expires within the same run', async () => {
    const h = rig();
    let previous: PhaseContext | undefined;
    h.steps.scripts.gate = [
      async (c) => {
        previous = c;
        return { kind: 'proceed' };
      },
    ];
    h.steps.scripts.acquire = [
      async () => {
        if (!previous) throw new Error('missing old context');
        await expect(previous.createVm({ scope: 'container' })).rejects.toMatchObject({
          code: 'admission_closed',
        });
        return { kind: 'acquired' };
      },
    ];
    expect((await h.controller.start(h.config)).state).toBe('submitted');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(0);
  });
  it('joins an admitted delayed VM allocation before committing a stop or releasing the store', async () => {
    const h = rig();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = h.vm.create.bind(h.vm);
    vi.spyOn(h.vm, 'create').mockImplementation(async (spec) => {
      entered();
      await barrier;
      return create(spec);
    });
    h.steps.scripts.gate = [
      async (c) => {
        void c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    const task = h.controller.start(h.config);
    await ready;
    try {
      expect(h.controller.snapshot().state).toBe('gating');
      expect(() => open(h, h.controller.snapshot().runId)).toThrow('lock held');
    } finally {
      release();
      await task;
    }
    const stopped = await task;
    expect(stopped.state).toBe('awaiting_maintainer');
    expect(await h.vm.listByRun(stopped.runId)).toHaveLength(0);
  });
  it.each([
    'crash',
    'contributor',
  ] as const)('VM-dependent shipping reacquires fresh resources after %s recovery', async (scenario) => {
    const h = rig();
    const acquire = async (c: PhaseContext) => {
      await c.createVm({ scope: 'container' });
      return { kind: 'acquired' as const };
    };
    h.steps.scripts.acquire = [acquire, acquire];
    const ship = async (c: PhaseContext) => {
      expect(await h.vm.listByRun(c.run.runId)).toHaveLength(1);
      return { kind: 'submitted' as const };
    };
    if (scenario === 'crash') {
      h.steps.scripts.drift = [
        () => {
          throw new Error('next-step crash');
        },
      ];
      h.steps.scripts.ship = [ship];
      await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'step_failed' });
    } else {
      h.steps.scripts.ship = [{ kind: 'fork_missing' }, ship];
      h.steps.scripts.resumeHandoff = [{ kind: 'resume_shipping' }];
      expect((await h.controller.start(h.config)).state).toBe('awaiting_contributor');
    }
    const id = h.controller.snapshot().runId;
    expect((await new RunController(h.deps).resume(id)).state).toBe('submitted');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(2);
    expect(await h.vm.listByRun(id)).toHaveLength(0);
  });
  it('emergency cleanup fencing still fans the persisted snapshot out to every driver', async () => {
    const h = rig();
    h.steps.scripts.gate = [
      async (c) => {
        await c.createVm({ scope: 'container' });
        return { kind: 'request_permission' };
      },
    ];
    h.deps.estimateVm = (_spec, purpose) =>
      purpose === 'teardown'
        ? { ...h.estimate, money: { currency: 'USD', minor: 1000 } }
        : h.estimate;
    const append = Journal.prototype.append;
    vi.spyOn(Journal.prototype, 'append').mockImplementation(function (event) {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'cleanup'
      )
        throw new Error('cleanup journal unavailable');
      append.call(this, event);
    });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({ code: 'admission_closed' });
    const run = h.controller.snapshot();
    expect(run.state).toBe('blocked_cleanup');
    for (const seen of h.seen)
      expect(seen).toEqual(['gating', 'awaiting_maintainer', 'blocked_cleanup']);
    expect(await h.vm.listByRun(run.runId)).toHaveLength(0);
    const store = open(h, run.runId);
    expect(store.validateEvidence().state).toBe('blocked_cleanup');
    store.close();
  });
  it.each([
    true,
    false,
  ])('terminal credential cleanup already persisted by its hook notifies the block (throws=%s)', async (throws) => {
    const h = rig();
    const failure = new Error('original credential cleanup failure');
    h.steps.scripts.gate = [{ kind: 'blocked' }];
    h.deps.recovery.endRun = async (c) => {
      c.store.persistRun(transitionRun(c.store.run, ReasonCode.CleanupFailed, TIME));
      if (throws) throw failure;
    };
    const task = h.controller.start(h.config);
    if (throws) await expect(task).rejects.toBe(failure);
    else expect((await task).state).toBe('blocked_cleanup');
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    for (const seen of h.seen) expect(seen).toEqual(['gating', 'blocked_cleanup']);
    const store = open(h, h.controller.snapshot().runId);
    expect(store.run.state).toBe('blocked_cleanup');
    store.close();
  });
});
