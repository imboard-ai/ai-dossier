import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { BudgetLedger } from '../dist/budget.js';
import { pauseAtCheckpoint } from '../dist/controller/checkpoints.js';
import { validateRunConfig } from '../dist/controller/config.js';
import { RunStore } from '../dist/controller/run-store.js';
import { StepArtifacts } from '../dist/controller/steps.js';
import { createController, stopStoredRun } from '../dist/controller/wiring.js';
import { AppCredentials } from '../dist/github/app-auth.js';
import { ForkCredentialBroker } from '../dist/github/broker.js';
import { Journal } from '../dist/journal.js';
import { ReasonCode, transitionRun } from '../dist/state.js';
import { createCommands } from './zt-run-bindings.mjs';

const nativeFetch = globalThis.fetch;
const cleanup = [];
const env = { key: process.env.BINDING_APP_KEY, secret: process.env.BINDING_APP_SECRET };
afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (env.key === undefined) delete process.env.BINDING_APP_KEY;
  else process.env.BINDING_APP_KEY = env.key;
  if (env.secret === undefined) delete process.env.BINDING_APP_SECRET;
  else process.env.BINDING_APP_SECRET = env.secret;
});

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-bindings-'));
  cleanup.push(dir);
  const signerKeyFile = path.join(dir, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  process.env.BINDING_APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  process.env.BINDING_APP_SECRET = 'fixture-secret';
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
      proxyEndpointsFile: path.join(dir, 'proxy.json'),
      accelerator: 'auto',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: [
        {
          resource: 'fake',
          currency: 'USD',
          unit: 'token',
          price: 0,
          units: 1,
          source: 'fixture',
          fx: {
            currency: 'USD',
            numerator: 1,
            denominator: 1,
            timestamp: '2026-10-10T00:00:00.000Z',
          },
        },
      ],
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
      privateKeyEnv: 'BINDING_APP_KEY',
      clientSecretEnv: 'BINDING_APP_SECRET',
    },
  });
  const root = path.join(dir, 'runs');
  let userId = 12;
  let revoked = 0;
  let userReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.ok(
      ['github.com', 'api.github.com'].includes(url.hostname),
      'unexpected physical fetch target'
    );
    let body;
    let status = 200;
    if (url.pathname === '/login/oauth/access_token')
      body = {
        access_token: `ghu_${'a'.repeat(30)}`,
        refresh_token: `ghr_${'b'.repeat(30)}`,
        expires_in: 3600,
      };
    else if (url.pathname === '/user') {
      userReads++;
      body = { id: userId, login: 'contributor', name: 'Verified Name' };
    } else if (url.pathname === '/user/emails')
      body = [{ email: 'verified@example.org', verified: true }];
    else if (url.pathname === '/applications/fixture/token' && init.method === 'DELETE') {
      revoked++;
      status = 204;
    } else assert.fail('unexpected physical fetch operation');
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  const callbacks = [];
  const onAuthorizationUrl = (value) => {
    const url = new URL(value);
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'approved');
    callbacks.push(nativeFetch(callback).then((r) => assert.equal(r.status, 200)));
  };
  const seed = (approved = config) => {
    const store = RunStore.create(root, approved, new Date());
    const ledger = new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
    ledger.initialize([], approved.modelProfile.rates);
    ledger.startSession({
      id: store.budgetSessionId(1),
      ceiling: { currency: 'USD', minor: 100 },
      cleanupAllowance: 10,
      tokenLimit: 100,
      timeLimitMs: 7200000,
    });
    return store;
  };
  return {
    config,
    root,
    dir,
    seed,
    onAuthorizationUrl,
    callbacks,
    setUser: (id) => {
      userId = id;
    },
    counts: () => ({ revoked, userReads }),
  };
}

test('start overrides file-supplied approval only with fresh OAuth consent; status opens the readOnly store API', async () => {
  const h = rig();
  const calls = [];
  const factory = (config, edges) => ({
    start: async (next) => {
      assert.equal(config, next);
      assert.equal(edges.onAuthorizationUrl, h.onAuthorizationUrl);
      calls.push(config);
      const store = h.seed(config);
      const run = store.run;
      store.close();
      return run;
    },
  });
  const commands = await createCommands({
    root: h.root,
    createController: factory,
    onAuthorizationUrl: h.onAuthorizationUrl,
  });
  await assert.rejects(commands.start(h.config), { code: 'author_approval_missing' });
  assert.equal(fs.existsSync(h.root), false);
  const approval = await commands.prepareAuthor(h.config, { email: 'verified@example.org' });
  assert.equal(approval.email, 'verified@example.org');
  const status = await commands.start({
    ...h.config,
    authorApproval: { ...approval, name: 'Untrusted override' },
  });
  assert.equal(calls[0].authorApproval.name, 'Verified Name');
  assert.equal(status.state, 'gating');
  assert.equal(commands.status(status.runId).runId, status.runId);
  assert.deepEqual(h.counts(), { revoked: 1, userReads: 1 });
  await Promise.all(h.callbacks);
});

test('pure resume refuses changed authenticated account before constructing a controller or continuing work', async () => {
  const h = rig();
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: () => {
      assert.fail('no continuation before identity binding');
    },
  });
  const approval = await commands.prepareAuthor(h.config);
  const store = h.seed({ ...h.config, authorApproval: approval });
  const runId = store.runId;
  store.close();
  h.setUser(13);
  await assert.rejects(commands.resume(runId), { code: 'author_approval_mismatch' });
  await assert.rejects(commands.resume(runId, { revise: true }), { code: 'revision_unavailable' });
  assert.equal(commands.status(runId).state, 'gating');
  assert.deepEqual(h.counts(), { revoked: 2, userReads: 2 });
  await Promise.all(h.callbacks);
});

test('root/config mismatch and start resumeRunId refuse before acquiring OAuth or creating stores', async () => {
  const h = rig();
  const commands = await createCommands({
    root: path.join(h.dir, 'elsewhere', 'runs'),
    createController,
  });
  await assert.rejects(commands.prepareAuthor(h.config), { code: 'root_mismatch' });
  await assert.rejects(commands.start(h.config), { code: 'root_mismatch' });
  const validRoot = await createCommands({ root: h.root, createController });
  await assert.rejects(
    validRoot.start({ ...h.config, resumeRunId: 'ztc-0000000000000000-run-1' }),
    { code: 'invalid_resume_run_id' }
  );
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
  assert.equal(fs.existsSync(h.root), false);
});

test('dormant kill-all performs resource cleanup without OAuth, model or proxy inputs; metrics/adoption/sweep are real local operations', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  assert.equal(commands.adoption(runId, 'Observed voluntarily').runId, runId);
  assert.ok(commands.metrics());
  assert.deepEqual(commands.sweep({ apply: false }), {
    applied: false,
    contributions: 0,
    files: 0,
  });
  const stopped = await commands.killAll('Incident stop');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].state, 'cancelled');
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});

test('dormant incident cleanup joins all VM destruction attempts and records blocked_cleanup on failure', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.close();
  const destroyed = [];
  await stopStoredRun(h.root, runId, 'Incident stop', {
    vm: {
      listByRun: async () => [
        { runId, vmId: 'one' },
        { runId, vmId: 'two' },
      ],
      destroy: async (handle) => {
        destroyed.push(handle.vmId);
        if (handle.vmId === 'one') throw new Error('provider-token-must-never-print');
      },
    },
  });
  assert.deepEqual(destroyed, ['one', 'two']);
  const commands = await createCommands({ root: h.root, createController });
  assert.equal(commands.status(runId).state, 'blocked_cleanup');
});

test('approve/reject bind exact durable checkpoint digests and return status without executing a phase', async () => {
  for (const decision of ['approve', 'reject']) {
    const h = rig();
    const store = h.seed({ ...h.config, checkpoints: ['plan'] });
    const runId = store.runId;
    store.persistRun(transitionRun(store.run, ReasonCode.GatePassed, new Date().toISOString()));
    const plan = Buffer.from('Held implementation plan');
    store.replaceArtifact('plan.txt', plan);
    pauseAtCheckpoint(
      store,
      store.run,
      'plan',
      {
        planDigest: createHash('sha256').update(plan).digest('hex'),
        policyDigest: 'd'.repeat(64),
        budgetSessionId: store.budgetSessionId(1),
      },
      new Date()
    );
    const digest = store.checkpoint('plan').digest;
    store.close();
    const commands = await createCommands({
      root: h.root,
      createController: () => assert.fail('checkpoint cannot execute'),
    });
    assert.match(commands.status(runId).nextPermittedAction, new RegExp(digest));
    assert.throws(() => commands.approve(runId, { point: 'plan', digest: '0'.repeat(64) }), {
      code: 'checkpoint_stale',
    });
    const result = commands[decision](runId, { point: 'plan', digest }, 'Needs revision');
    assert.equal(result.state, decision === 'approve' ? 'planning' : 'cancelled');
    assert.equal(commands.status(runId).state, result.state);
  }
});

test('explicit authorize emits its actual loopback OAuth URL and verifies recorded identity without running phases', async () => {
  const h = rig();
  const commands = await createCommands({
    root: h.root,
    createController,
    onAuthorizationUrl: h.onAuthorizationUrl,
  });
  const approval = await commands.prepareAuthor(h.config);
  const store = h.seed({ ...h.config, authorApproval: approval });
  const runId = store.runId;
  store.close();
  fs.writeFileSync(
    h.config.executionProfile.proxyEndpointsFile,
    JSON.stringify({
      endpoints: {
        npmRegistry: 'http://127.0.0.1:3128/npm/',
        pypiIndex: 'http://127.0.0.1:3128/pypi/',
      },
      target: { host: '127.0.0.1', port: 3128 },
    }),
    { mode: 0o600 }
  );
  assert.equal((await commands.authorize(runId)).state, 'gating');
  assert.equal(h.callbacks.length, 2);
  assert.deepEqual(h.counts(), { revoked: 2, userReads: 2 });
  await Promise.all(h.callbacks);
});

test('export delegates to the real portable exporter and returns no output value', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  const output = path.join(h.dir, 'export.json');
  assert.equal(commands.export(runId, output), undefined);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).schemaVersion, 'ztfc-export-v1');
});

test('status observes complete evidence while the writer lock is held; mutating commands stay locked', async () => {
  const h = rig();
  const store = h.seed();
  const commands = await createCommands({ root: h.root, createController });
  try {
    assert.equal(commands.status(store.runId).state, 'gating');
    assert.throws(() => commands.adoption(store.runId, 'locked note'), {
      name: 'StoreLockedError',
    });
    await assert.rejects(commands.resume(store.runId), { name: 'StoreLockedError' });
  } finally {
    store.close();
  }
});

test('dormant kill-all does not claim value-lost credential revocation successful', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  const tokens = new Journal(store.storeDirectory('tokens'));
  const fork = { repositoryId: 22, installationId: 33, owner: 'contributor' };
  const broker = new ForkCredentialBroker({
    store: tokens,
    fork,
    app: new AppCredentials({
      appId: '1',
      clientId: 'fixture',
      privateKey: process.env.BINDING_APP_KEY,
      clientSecret: process.env.BINDING_APP_SECRET,
    }),
    http: () => assert.fail('value-lost tokens cannot be revoked with fabricated credentials'),
    intents: () => assert.fail('incident cleanup cannot execute intents'),
  });
  broker.registerUserToken(`ghu_${'c'.repeat(30)}`, new Date(Date.now() + 3600000).toISOString());
  broker.close();
  tokens.close();
  const steps = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  new StepArtifacts(steps, runId).put('fork', fork);
  steps.close();
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  assert.equal((await commands.killAll('Incident stop'))[0].state, 'blocked_cleanup');
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});
