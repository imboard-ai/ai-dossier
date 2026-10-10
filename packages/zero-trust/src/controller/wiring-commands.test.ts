import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeVmAdapter } from '../__tests__/fake-vm';
import { BudgetLedger } from '../budget';
import { AppCredentials } from '../github/app-auth';
import { ForkCredentialBroker } from '../github/broker';
import { Journal } from '../journal';
import { ReasonCode, transitionRun } from '../state';
import { validateRunConfig } from './config';
import { readOutcomeBudget } from './outcome-records';
import { RunStore } from './run-store';
import { StepArtifacts } from './steps';
import { createController, fenceIncident, prepareAuthor, stopStoredRun } from './wiring';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-command-edges-'));
  directories.push(dir);
  const signerKeyFile = path.join(dir, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  vi.stubEnv('COMMAND_APP_KEY', privateKey);
  vi.stubEnv('COMMAND_APP_SECRET', 'fixture-secret');
  const proxyEndpointsFile = path.join(dir, 'proxy.json');
  fs.writeFileSync(
    proxyEndpointsFile,
    JSON.stringify({
      endpoints: {
        npmRegistry: 'http://127.0.0.1:3128/npm/',
        pypiIndex: 'http://127.0.0.1:3128/pypi/',
      },
      target: { host: '127.0.0.1', port: 3128 },
    }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      stateDir: dir,
      profileDir: path.join(dir, 'profile'),
      proxyEndpointsFile,
      accelerator: 'tcg',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: ['fake', 'local-qemu'].map((resource) => ({
        resource,
        currency: 'USD',
        unit: resource === 'fake' ? 'token' : 'millisecond',
        price: 0,
        units: 1,
        source: 'fixture',
        fx: {
          currency: 'USD',
          numerator: 1,
          denominator: 1,
          timestamp: '2026-10-10T00:00:00.000Z',
        },
      })),
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 100,
      activeMinutes: 120,
    },
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'COMMAND_APP_KEY',
      clientSecretEnv: 'COMMAND_APP_SECRET',
    },
  });
  const root = path.join(dir, 'runs');
  let userId = 12;
  let revoked = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    let body: unknown;
    let status = 200;
    if (url.pathname === '/login/oauth/access_token')
      body = {
        access_token: `ghu_${'a'.repeat(30)}`,
        refresh_token: `ghr_${'b'.repeat(30)}`,
        expires_in: 3600,
      };
    else if (url.pathname === '/user')
      body = { id: userId, login: 'contributor', name: 'Profile Name' };
    else if (url.pathname === '/applications/fixture/token' && init?.method === 'DELETE') {
      revoked++;
      status = 204;
    } else throw new Error('unexpected_fake_request');
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  const callbacks: Promise<unknown>[] = [];
  const onAuthorizationUrl = (value: string) => {
    const page = new URL(value);
    expect(page.origin + page.pathname).toBe('https://github.com/login/oauth/authorize');
    const redirect = new URL(page.searchParams.get('redirect_uri') as string);
    redirect.searchParams.set('code', 'approved');
    redirect.searchParams.set('state', page.searchParams.get('state') as string);
    callbacks.push(fetch(redirect).then((response) => expect(response.status).toBe(200)));
  };
  const seed = (approved = config) => {
    const store = RunStore.create(root, approved, new Date());
    const budget = new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
    budget.initialize([], approved.modelProfile.rates);
    budget.startSession({
      id: store.budgetSessionId(1),
      ceiling: { currency: 'USD', minor: 100 },
      cleanupAllowance: 10,
      tokenLimit: 100,
      timeLimitMs: 7200000,
    });
    return store;
  };
  const vm = new FakeVmAdapter();
  return {
    dir,
    root,
    config,
    seed,
    vm,
    privateKey,
    fetch: fetcher,
    onAuthorizationUrl,
    callbacks,
    revoked: () => revoked,
    setUser: (id: number) => {
      userId = id;
    },
  };
}

describe('production command credential/resource edges', () => {
  it('refuses symlinked ancestors before any incident publication or permission changes', () => {
    const h = rig();
    const outside = path.join(h.dir, 'outside');
    fs.mkdirSync(outside);
    const runs = path.join(outside, 'runs');
    fs.mkdirSync(runs, { mode: 0o755 });
    fs.chmodSync(runs, 0o755);
    const link = path.join(h.dir, 'store-link');
    fs.symlinkSync(outside, link);
    expect(() => fenceIncident(path.join(link, 'runs'), 'Incident')).toThrow();
    expect(fs.readdirSync(runs)).toEqual([]);
    expect(fs.statSync(runs).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(outside, 'vms'))).toBe(false);
  });
  it('pins incident publication against a legitimate directory swap after traversal', () => {
    const h = rig();
    fs.mkdirSync(h.root, { mode: 0o700 });
    const outside = path.join(h.dir, 'outside');
    fs.mkdirSync(outside);
    const moved = path.join(h.dir, 'held-runs');
    const original = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (!swapped && String(file).includes('/.zt-write-')) {
        swapped = true;
        fs.renameSync(h.root, moved);
        fs.symlinkSync(outside, h.root);
      }
      return original(file, flags, mode);
    });
    fenceIncident(h.root, 'Incident');
    expect(swapped).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(moved, '.incident'), 'utf8')).toBe('incident');
  });
  it('observes an incident arriving in recovery before any fresh credential/OAuth admission', async () => {
    const h = rig();
    const approval = {
      userId: 12,
      login: 'contributor',
      name: 'Held Name',
      email: '12+contributor@users.noreply.github.com',
      source: 'default' as const,
      approvedAt: '2026-10-10T00:00:00.000Z',
    };
    const config = { ...h.config, authorApproval: approval };
    const store = h.seed(config);
    const runId = store.runId;
    const directory = path.join(store.storeDirectory('control'), 'controller');
    store.close();
    new Journal(directory).close();
    let reads = 0;
    let enumerated = 0;
    vi.spyOn(h.vm, 'listByRun').mockImplementation(async () => {
      if (++enumerated === 1)
        fs.writeFileSync(path.join(h.root, '.incident'), 'incident', { mode: 0o600 });
      return [];
    });
    const controller = createController(config, {
      vm: h.vm,
      fetch: async () => {
        reads++;
        throw new Error('forbidden credential call');
      },
      onAuthorizationUrl: () => {
        reads++;
        throw new Error('forbidden new OAuth');
      },
    });
    expect((await controller.resume(runId)).state).toBe('cancelled');
    expect(reads).toBe(0);
    const stopped = RunStore.open(h.root, runId, { readOnly: true });
    try {
      expect(stopped.run.state).toBe('cancelled');
    } finally {
      stopped.close();
    }
  });
  it('opens a real loopback receiver and emits the actual URL before completing authenticated consent', async () => {
    const h = rig();
    const approval = await prepareAuthor(h.config, {}, h);
    expect(approval).toMatchObject({
      userId: 12,
      login: 'contributor',
      name: 'Profile Name',
      source: 'default',
    });
    expect(h.revoked()).toBe(1);
    expect(fs.existsSync(h.root)).toBe(false);
    await Promise.all(h.callbacks);
  });
  it('closes the receiver without issuing a token when no UI edge is supplied or it fails', async () => {
    const h = rig();
    await expect(prepareAuthor(h.config, {}, { fetch: h.fetch })).rejects.toThrow(
      'authorization_ui_unavailable'
    );
    await expect(
      prepareAuthor(
        h.config,
        {},
        {
          fetch: h.fetch,
          onAuthorizationUrl: () => {
            throw new Error('ui_unavailable');
          },
        }
      )
    ).rejects.toThrow('ui_unavailable');
    expect(h.revoked()).toBe(0);
  });
  it('explicit authorize verifies account binding and config authority without continuing a phase', async () => {
    const h = rig();
    const authorApproval = await prepareAuthor(h.config, {}, h);
    const config = { ...h.config, authorApproval };
    const store = h.seed(config);
    const runId = store.runId;
    store.close();
    const controller = createController(config, {
      fetch: h.fetch,
      vm: h.vm,
      onAuthorizationUrl: h.onAuthorizationUrl,
    });
    await controller.authorize(runId);
    h.setUser(13);
    await expect(controller.authorize(runId)).rejects.toMatchObject({
      code: 'author_approval_mismatch',
    });
    const different = createController(
      { ...config, authorApproval: { ...authorApproval, name: 'Different' } },
      { vm: h.vm }
    );
    await expect(different.authorize(runId)).rejects.toThrow('resume_identity_mismatch');
    const unchanged = RunStore.open(h.root, runId, { readOnly: true });
    try {
      expect(unchanged.run.state).toBe('gating');
    } finally {
      unchanged.close();
    }
    expect(h.vm.calls).toEqual([]);
    await Promise.all(h.callbacks);
  });
  it('reserves teardown before destruction and records actual local-QEMU accounting for dormant guests', async () => {
    const h = rig();
    const store = h.seed();
    const runId = store.runId;
    await h.vm.create({
      runId,
      scope: 'container',
      phase: 'verification',
      limits: store.config.limits,
    });
    store.close();
    await stopStoredRun(h.root, runId, 'Incident stop', { vm: h.vm });
    const stopped = RunStore.open(h.root, runId, { readOnly: true });
    try {
      expect(stopped.run.state).toBe('cancelled');
      expect(readOutcomeBudget(stopped).reservations).toMatchObject([
        { purpose: 'teardown', status: 'settled', observed: { source: 'local-qemu-observed' } },
      ]);
    } finally {
      stopped.close();
    }
    expect(await h.vm.listByRun(runId)).toEqual([]);
  });
  it('preserves unfunded obligations and joins cleanup even with missing accounting and failing destruction', async () => {
    const h = rig();
    const store = h.seed();
    const runId = store.runId;
    await h.vm.create({
      runId,
      scope: 'container',
      phase: 'verification',
      limits: store.config.limits,
    });
    await h.vm.create({
      runId,
      scope: 'container',
      phase: 'verification',
      limits: store.config.limits,
    });
    fs.unlinkSync(path.join(store.storeDirectory('budget'), 'ledger.json'));
    store.close();
    h.vm.failDestroy = 1;
    await stopStoredRun(h.root, runId, 'Incident stop', { vm: h.vm });
    const stopped = RunStore.open(h.root, runId, { readOnly: true });
    try {
      expect(stopped.run.state).toBe('blocked_cleanup');
    } finally {
      stopped.close();
    }
    expect(h.vm.calls.filter((call) => call.op === 'destroy')).toHaveLength(3);
  });
  it('blocks cleanup for value-lost credentials, including terminal runs, without inventing credentials', async () => {
    for (const terminal of [false, true]) {
      const h = rig();
      const store = h.seed();
      const runId = store.runId;
      const fork = { repositoryId: 22, installationId: 33, owner: 'contributor' };
      const tokens = new Journal(store.storeDirectory('tokens'));
      const broker = new ForkCredentialBroker({
        store: tokens,
        fork,
        app: new AppCredentials({
          appId: '1',
          clientId: 'fixture',
          privateKey: h.privateKey,
          clientSecret: 'fixture-secret',
        }),
        http: async () => {
          throw new Error('no_fabricated_credentials');
        },
        intents: () => {
          throw new Error('no_intents');
        },
      });
      broker.registerUserToken(
        `ghu_${'c'.repeat(30)}`,
        new Date(Date.now() + 3600000).toISOString()
      );
      broker.close();
      tokens.close();
      const steps = new Journal(path.join(store.storeDirectory('control'), 'steps'));
      new StepArtifacts(steps, runId).put('fork', fork);
      steps.close();
      if (terminal)
        store.persistRun(
          transitionRun(store.run, ReasonCode.UserCancelled, new Date().toISOString())
        );
      store.close();
      if (terminal)
        await expect(stopStoredRun(h.root, runId, 'Incident stop', { vm: h.vm })).rejects.toThrow(
          'cleanup_incomplete'
        );
      else await stopStoredRun(h.root, runId, 'Incident stop', { vm: h.vm });
      const stopped = RunStore.open(h.root, runId, { readOnly: true });
      try {
        expect(stopped.run.state).toBe(terminal ? 'cancelled' : 'blocked_cleanup');
      } finally {
        stopped.close();
      }
    }
  });
  it('refuses wrong roots and secret-bearing reasons before incident effects', async () => {
    const h = rig();
    const other = path.join(h.dir, 'other', 'runs');
    const store = RunStore.create(other, h.config, new Date());
    const runId = store.runId;
    store.close();
    await expect(stopStoredRun(other, runId, 'Incident stop', { vm: h.vm })).rejects.toThrow(
      'root_mismatch'
    );
    await expect(stopStoredRun(other, runId, 'ghp_planted_secret', { vm: h.vm })).rejects.toThrow();
    expect(h.vm.calls).toEqual([]);
  });
});
