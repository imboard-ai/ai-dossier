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
import { ReasonCode, transitionRun } from '../state';
import { ScriptedRecovery, ScriptedSteps } from './__tests__/fake-steps';
import { approveCheckpoint } from './checkpoints';
import { validateRunConfig } from './config';
import { ControllerError, type PhaseContext, RunController } from './controller';
import { RunStore } from './run-store';
import {
  publishVerification,
  type VerificationRecord,
  type VerificationVerdict,
} from './verification-record';
import { verifyCandidate } from './verifier';

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
  const candidateSha = context.store.currentCheckpointBindings('patch')?.candidateSha ?? latestSha;
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
      latestSha = c.run.history.some((e) => e.reasonCode === ReasonCode.RepairRequired)
        ? sha256(String(c.run.history.length)).slice(0, 40)
        : SHA;
      c.store.replaceArtifact('candidate.diff', Buffer.from('diff'));
      return { kind: 'candidate', bindings: { ...bindings(c), candidateSha: latestSha } };
    },
    review: async () => ({ kind: 'approved' }),
    verify: async (c) => ({ kind: 'verified', record: record(c) }),
    drift: async () => ({ kind: 'unchanged' }),
    ship: async () => {
      write('pr');
      return { kind: 'submitted' };
    },
    resumeHandoff: async () => ({ kind: 'waiting' }),
    track: async () => ({ kind: 'waiting' }),
  });
  let now = new Date(TIME);
  const deps = {
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

describe('RunController', () => {
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
  it('reconciles unknown holds before VMs, leaves work fenced and cleanup funded', async () => {
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
    expect((await h.controller.start(h.config)).state).toBe('paused_user');
    expect(h.steps.calls).not.toContain('plan');
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
      'credentials',
      'intents',
      'tracker',
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
    expect(store.run.state).toBe('gating');
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
        h.writes.add('pr');
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
});
