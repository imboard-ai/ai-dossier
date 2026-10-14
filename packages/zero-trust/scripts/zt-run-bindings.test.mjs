import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { FakeVmAdapter } from '../dist/__tests__/fake-vm.js';
import { BudgetLedger } from '../dist/budget.js';
import { ScriptedRecovery } from '../dist/controller/__tests__/fake-steps.js';
import { pauseAtCheckpoint } from '../dist/controller/checkpoints.js';
import { runConfigInput, validateRunConfig } from '../dist/controller/config.js';
import {
  acknowledgeControl,
  readControlRequests,
  requestControl,
} from '../dist/controller/control.js';
import { RunController } from '../dist/controller/controller.js';
import { RunStore } from '../dist/controller/run-store.js';
import { StepArtifacts } from '../dist/controller/steps.js';
import { STOP_NOTICE_KEY } from '../dist/controller/stop-notice.js';
import { createController, incidentRequested, stopStoredRun } from '../dist/controller/wiring.js';
import { AppCredentials } from '../dist/github/app-auth.js';
import { ForkCredentialBroker } from '../dist/github/broker.js';
import { TokenJournal } from '../dist/github/token-journal.js';
import { Journal } from '../dist/journal.js';
import { ReasonCode, transitionRun } from '../dist/state.js';
import { renderHuman, renderJson } from '../dist/status.js';
import { createCommands } from './zt-run-bindings.mjs';
import { main } from './zt-run-lib.mjs';

const nativeFetch = globalThis.fetch;
test('resume with missing model rates refuses before OAuth/continuation and retains paused state across reopen', async () => {
  const h = rig();
  const store = h.seed();
  const at = store.run.updatedAt;
  for (const reason of [ReasonCode.GatePassed, ReasonCode.PlanApproved, ReasonCode.UserPaused])
    store.persistRun(transitionRun(store.run, reason, at));
  const id = store.runId;
  const config = store.config;
  const ledgerFile = path.join(store.storeDirectory('budget'), 'ledger.json');
  const before = fs.readFileSync(ledgerFile);
  store.close();
  const construct = vi.fn(() => {
    throw new Error('forbidden controller construction');
  });
  const commands = await createCommands({
    root: h.root,
    createController: construct,
    onAuthorizationUrl: () => assert.fail('forbidden OAuth'),
  });
  await assert.rejects(
    commands.resume(id, { modelProfile: { ...config.modelProfile, rates: [] } }),
    (e) => e.code === 'missing_rate'
  );
  assert.equal(construct.mock.calls.length, 0);
  const reopened = RunStore.open(h.root, id);
  try {
    assert.equal(reopened.run.state, 'paused_user');
    assert.deepEqual(reopened.config, config);
    assert.deepEqual(fs.readFileSync(ledgerFile), before);
    assert.deepEqual(reopened.userChanges, []);
  } finally {
    reopened.close();
  }
});
const cleanup = [];
const env = { key: process.env.BINDING_APP_KEY, secret: process.env.BINDING_APP_SECRET };
afterEach(() => {
  vi.restoreAllMocks();
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
  const seed = (approved = config, at = new Date()) => {
    const store = RunStore.create(root, approved, at);
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

test('second-process pause/cancel are durable under the active guard and observational status reports pending and damaged requests', async () => {
  const h = rig();
  const store = h.seed();
  try {
    const commands = await createCommands({
      root: h.root,
      createController: () => assert.fail('request/status cannot construct execution'),
    });
    for (const kind of ['pause', 'cancel']) {
      const child = spawnSync(
        process.execPath,
        [
          new URL('./zt-run.mjs', import.meta.url).pathname,
          kind,
          '--root',
          h.root,
          '--run',
          store.runId,
          '--reason',
          'User control',
        ],
        { encoding: 'utf8' }
      );
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, new RegExp(`${kind}_requested:`));
    }
    const rows = readControlRequests(store).pending;
    assert.equal(rows.length, 2);
    assert.equal(commands.status(store.runId).phase, 'cancel_requested');
    for (const row of rows) acknowledgeControl(store, row, 'applied');
    assert.equal(commands.status(store.runId).phase, 'gating');
    fs.writeFileSync(
      path.join(store.storeDirectory('control'), 'requests', `${rows[0].id}.json`),
      '{'
    );
    const status = commands.status(store.runId);
    assert.equal(status.phase, 'invalid_control');
    assert.match(status.nextPermittedAction, /corrupt or unknown/);
    assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
  } finally {
    store.close();
  }
});

test('fresh CLI status reads the retained authorization fence without constructing execution', async () => {
  const h = rig();
  const store = h.seed();
  store.persistRun(transitionRun(store.run, ReasonCode.UserPaused, new Date().toISOString()));
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  new StepArtifacts(journal, store.runId).put('authorization_required', {
    nextPermittedAction: 'authorize',
  });
  journal.close();
  store.close();
  const commands = await createCommands({
    root: h.root,
    createController: () => assert.fail('status cannot execute'),
  });
  assert.equal(commands.status(store.runId).nextPermittedAction, 'authorize');
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});

test('cancelled CLI status retains publication URL and contributor withdrawal instructions', async () => {
  const h = rig();
  const store = h.seed();
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.PublicationObserved,
    ReasonCode.UserCancelled,
  ])
    store.persistRun(transitionRun(store.run, reason, new Date().toISOString()));
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  const artifacts = new StepArtifacts(journal, store.runId);
  artifacts.put('publication', {
    url: 'https://github.com/owner/repo/pull/2',
    headSha: 'a'.repeat(40),
  });
  artifacts.put(
    'withdrawal',
    'Post the prepared contributor comment, then close the pull request.'
  );
  journal.close();
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  const status = commands.status(store.runId);
  assert.equal(status.state, 'cancelled');
  assert.match(status.nextPermittedAction, /https:\/\/github.com\/owner\/repo\/pull\/2/);
  assert.match(status.nextPermittedAction, /prepared contributor comment/);
  for (const output of [renderHuman(status), renderJson(status)]) {
    assert.match(output, /Settings → Applications → Authorized GitHub Apps/);
    assert.match(output, /does not confirm removal/);
    assert.match(output, /prepared contributor comment/);
    assert.equal(output.split('Settings → Applications → Authorized GitHub Apps').length, 2);
  }
  assert.deepEqual(commands.status(store.runId), status);
});

test('cleanup-blocked CLI status retains cleanup and revocation guidance despite corrupt control evidence', async () => {
  const h = rig();
  const store = h.seed();
  const row = requestControl(store, { kind: 'cancel', reason: 'Stop' }, new Date());
  store.persistRun(transitionRun(store.run, ReasonCode.CleanupFailed, new Date().toISOString()));
  fs.writeFileSync(path.join(store.storeDirectory('control'), 'requests', `${row.id}.json`), '{');
  store.close();
  const construct = vi.fn(() => assert.fail('status cannot construct execution'));
  const oauth = vi.fn(() => assert.fail('status cannot authorize'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const commands = await createCommands({
    root: h.root,
    createController: construct,
    onAuthorizationUrl: oauth,
  });
  const status = commands.status(store.runId);
  assert.equal(status.state, 'blocked_cleanup');
  assert.equal(status.phase, 'invalid_control');
  for (const output of [renderHuman(status), renderJson(status)]) {
    assert.match(output, /Reconcile remaining resources and credentials/);
    assert.match(output, /corrupt or unknown/);
    assert.match(output, /Settings → Applications → Authorized GitHub Apps/);
    assert.equal(output.split('Settings → Applications → Authorized GitHub Apps').length, 2);
  }
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(oauth.mock.calls.length, 0);
  assert.equal(construct.mock.calls.length, 0);
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});

test('status shows a stop notice only for the exact stop it explains', async () => {
  const h = rig();
  const store = h.seed();
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.UserPaused,
  ])
    store.persistRun(transitionRun(store.run, reason, new Date().toISOString()));
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  const artifacts = new StepArtifacts(journal, store.runId);
  const notice = {
    state: 'paused_user',
    historyLength: store.run.history.length,
    reason: 'rebase_conflict',
    nextPermittedAction: 'Upstream changed a file this patch also changes. Nothing was pushed.',
  };
  artifacts.put(STOP_NOTICE_KEY, notice);
  const commands = await createCommands({ root: h.root, createController });
  assert.equal(commands.status(store.runId).nextPermittedAction, notice.nextPermittedAction);
  // A stale notice (another history length or state) never explains a later stop.
  artifacts.put(STOP_NOTICE_KEY, { ...notice, historyLength: notice.historyLength - 1 });
  assert.notEqual(commands.status(store.runId).nextPermittedAction, notice.nextPermittedAction);
  artifacts.put(STOP_NOTICE_KEY, { ...notice, state: 'blocked' });
  assert.notEqual(commands.status(store.runId).nextPermittedAction, notice.nextPermittedAction);
  journal.close();
  store.close();
});

test('status explains a revision paused because its feedback was not admitted', async () => {
  const h = rig();
  const store = h.seed();
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.PublicationObserved,
    ReasonCode.RevisionRequested,
    ReasonCode.UserPaused,
  ])
    store.persistRun(transitionRun(store.run, reason, new Date().toISOString()));
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  const artifacts = new StepArtifacts(journal, store.runId);
  artifacts.put('feedback_decision', {
    sessionId: store.budgetSessionId(1),
    admitted: false,
    verdict: '{}',
  });
  journal.close();
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  const status = commands.status(store.runId);
  assert.equal(status.state, 'paused_user');
  assert.match(status.nextPermittedAction, /feedback was judged out of scope or ambiguous/);
});

test('policy gate status exposes retained decisions and citations read-only, with exact stop binding', async () => {
  const h = rig();
  const store = h.seed();
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  const artifacts = new StepArtifacts(journal, store.runId);
  const evidence = {
    historyLength: store.run.history.length,
    sessionId: store.budgetSessionId(1),
    baseSha: 'a'.repeat(40),
    outcome: 'hand_off',
    reasons: ['ownership_unclear'],
    assessment: {
      ai: 'welcomed',
      assignment: 'unclear',
      directPr: 'unclear',
      draftRequired: true,
      receiptBlockAllowed: false,
      baselineFailuresPermitted: false,
      citations: [{ path: 'CONTRIBUTING.md', line: 3, ruleId: 'ai', excerpt: 'AI is welcome.' }],
      decisions: {
        assignment: {
          status: 'escalated',
          reason: 'invalid_pass',
          value: 'unclear',
          confidence: '0',
          provider: 'llm',
          model: 'fixture',
          questionVersion: '1',
          questionDigest: 'b'.repeat(64),
          inputDigest: 'c'.repeat(64),
          citations: [],
          citationDigest: 'd'.repeat(64),
        },
      },
    },
  };
  const construct = vi.fn(() => assert.fail('status cannot construct execution'));
  const oauth = vi.fn(() => assert.fail('status cannot authorize'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const commands = await createCommands({
    root: h.root,
    createController: construct,
    onAuthorizationUrl: oauth,
  });
  assert.equal(commands.status(store.runId).policyGate, undefined); // legacy absence
  const retain = (value) => {
    artifacts.put('gate_assessment', value);
    const digest = artifacts.digest('gate_assessment');
    artifacts.put(STOP_NOTICE_KEY, {
      state: 'gating',
      historyLength: store.run.history.length,
      reason: value.reasons.join(','),
      nextPermittedAction: 'Policy hand-off.',
      gateAssessmentDigest: digest,
    });
  };
  // An assessment publication before its completed notice is not stop evidence.
  artifacts.put('gate_assessment', evidence);
  assert.equal(commands.status(store.runId).policyGate, undefined);
  retain(evidence);
  const eventsBefore = fs.readFileSync(journal.filePath);
  const ledgerBefore = fs.readFileSync(path.join(store.storeDirectory('budget'), 'ledger.json'));
  const writes = [
    vi.spyOn(fs, 'writeSync'),
    vi.spyOn(fs, 'writeFileSync'),
    vi.spyOn(fs, 'renameSync'),
  ];
  const status = commands.status(store.runId);
  assert.equal(
    writes.reduce((n, spy) => n + spy.mock.calls.length, 0),
    0
  );
  for (const spy of writes) spy.mockRestore();
  assert.deepEqual(status.policyGate, {
    baseSha: evidence.baseSha,
    reasons: evidence.reasons,
    assessment: evidence.assessment,
  });
  assert.deepEqual(JSON.parse(renderJson(status)).policyGate, status.policyGate);
  assert.match(renderHuman(status), /policyGate:.*fixture.*invalid_pass/);
  assert.match(renderHuman(status), /CONTRIBUTING.md/);
  assert.deepEqual(fs.readFileSync(journal.filePath), eventsBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(store.storeDirectory('budget'), 'ledger.json')),
    ledgerBefore
  );
  assert.equal(fetch.mock.calls.length + construct.mock.calls.length + oauth.mock.calls.length, 0);
  for (const assessment of [
    { ...evidence.assessment, ai: 'invented-permission' },
    { ...evidence.assessment, unknown: 'not-a-status-fact' },
    {
      ...evidence.assessment,
      decisions: { assignment: { ...evidence.assessment.decisions.assignment, status: 'passed' } },
    },
  ]) {
    retain({ ...evidence, assessment });
    assert.throws(() => commands.status(store.runId), { name: 'InvalidStatusError' });
  }
  assert.throws(
    () =>
      renderJson({
        ...status,
        policyGate: {
          ...status.policyGate,
          assessment: {
            ...evidence.assessment,
            decisions: {
              assignment: {
                ...evidence.assessment.decisions.assignment,
                model: 'Bearer\tfixture-secret',
              },
            },
          },
        },
      }),
    { name: 'SecretRedactionError' }
  );
  let getters = 0;
  assert.throws(() =>
    renderJson({
      ...status,
      policyGate: {
        ...status.policyGate,
        get assessment() {
          getters++;
          return evidence.assessment;
        },
      },
    })
  );
  assert.equal(getters, 0);
  for (const changed of [
    { historyLength: evidence.historyLength + 1 },
    { sessionId: `${store.runId}-s2` },
    { outcome: 'proceed' },
  ]) {
    retain({ ...evidence, ...changed });
    assert.equal(commands.status(store.runId).policyGate, undefined);
  }
  retain(evidence);
  artifacts.put(STOP_NOTICE_KEY, {
    state: 'gating',
    historyLength: store.run.history.length,
    reason: 'budget_exhausted',
    nextPermittedAction: 'No work was admitted.',
  });
  assert.equal(commands.status(store.runId).policyGate, undefined);
  retain(evidence);
  // Oversized but valid quotes and citation sets remain inspectable without
  // preventing ordinary status. Full bytes stay in the diagnostic artifact.
  const longQuote = `AI is welcome. ${'evidence '.repeat(2000)}`;
  const large = {
    ...evidence,
    assessment: {
      ...evidence.assessment,
      decisions: {
        assignment: {
          ...evidence.assessment.decisions.assignment,
          citations: Array.from({ length: 100 }, (_, i) => ({
            sourceId: 'CONTRIBUTING.md',
            line: i + 1,
            quote: longQuote,
          })),
        },
      },
    },
  };
  retain(large);
  const projected = commands.status(store.runId);
  assert.equal(projected.policyGate.displayTruncated, true);
  assert.equal(projected.policyGate.assessment.decisions.assignment.citations.length, 16);
  assert.equal(projected.policyGate.assessment.decisions.assignment.citations[0].quote.length, 512);
  assert.deepEqual(artifacts.get('gate_assessment'), large);
  for (const output of [renderHuman(projected), renderJson(projected)])
    assert.match(output, /displayTruncated/);
  assert.equal(projected.estimatedSpend.amount, status.estimatedSpend.amount);
  retain(evidence);
  store.persistRun(transitionRun(store.run, ReasonCode.GatePassed, new Date().toISOString()));
  assert.equal(commands.status(store.runId).policyGate, undefined);
  journal.close();
  store.close();
});

test('policy gate status refuses corrupted digest-named decision evidence', async () => {
  const h = rig();
  const store = h.seed();
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  new StepArtifacts(journal, store.runId).put('gate_assessment', { diagnostic: true });
  const digest = journal.read().at(-1).digest;
  const file = path.join(path.dirname(journal.filePath), `${digest}.json`);
  fs.writeFileSync(file, '{}');
  journal.close();
  store.close();
  const commands = await createCommands({ root: h.root, createController });
  assert.throws(() => commands.status(store.runId), /invalid_step_artifact/);
});

test('start overrides file-supplied approval only with fresh OAuth consent; status opens the readOnly store API', async () => {
  const h = rig();
  const calls = [];
  const factory = (config, edges, session) => ({
    start: async (next) => {
      assert.equal(
        typeof session?.adopt,
        'function',
        'start must hand the identity authorization to its credential owner'
      );
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

test('declined confirmation and failed construction revoke the process-local author token', async () => {
  const h = rig();
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: () => assert.fail('declined confirmation cannot construct execution'),
  });
  const configFile = path.join(h.dir, 'start-config.json');
  fs.writeFileSync(configFile, JSON.stringify(runConfigInput(h.config)), { mode: 0o600 });
  const output = [];
  assert.equal(
    await main(['start', '--config', configFile, '--root', h.root], {
      createController: () => commands,
      out: (line) => output.push(line),
      err: (line) => output.push(line),
      confirmAuthor: () => false,
    }),
    2
  );
  assert.deepEqual(h.counts(), { revoked: 1, userReads: 1 }, output.join('\n'));
  assert.equal(fs.existsSync(h.root), false);
  assert.ok(!output.join('\n').includes(`ghu_${'a'.repeat(30)}`));
  const failed = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: () => {
      throw new Error('construction_refused');
    },
  });
  await failed.prepareAuthor(h.config);
  await assert.rejects(failed.start(h.config), /construction_refused/);
  await failed.discardAuthor(h.config);
  assert.deepEqual(h.counts(), { revoked: 2, userReads: 2 });
  await Promise.all(h.callbacks);
});

test('overlapping author operations cannot overwrite or revoke an active process-local owner', async () => {
  const h = rig();
  let reached;
  let release;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: (config) => ({
      start: async () => {
        reached();
        await held;
        const store = h.seed(config);
        const run = store.run;
        store.close();
        return run;
      },
    }),
  });
  const preparing = commands.prepareAuthor(h.config);
  await assert.rejects(commands.prepareAuthor(h.config), { code: 'busy' });
  await preparing;
  assert.equal(h.callbacks.length, 1);
  const starting = commands.start(h.config);
  await ready;
  await assert.rejects(commands.start(h.config), { code: 'busy' });
  await assert.rejects(commands.prepareAuthor(h.config), { code: 'busy' });
  await assert.rejects(commands.discardAuthor(h.config), { code: 'busy' });
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 1 });
  release();
  await starting;
  await commands.discardAuthor(h.config);
  assert.deepEqual(h.counts(), { revoked: 1, userReads: 1 });
  await Promise.all(h.callbacks);
});

test('failed preparation cleanup remains reachable by explicit discard before another authorization', async () => {
  const h = rig();
  const transport = globalThis.fetch;
  let refuseDelete = true;
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/user') return new Response(JSON.stringify({}));
    if (url.pathname === '/applications/fixture/token' && init.method === 'DELETE') {
      deletes++;
      if (refuseDelete) return new Response(null, { status: 503 });
    }
    return transport(input, init);
  };
  const listeners = process.listenerCount('SIGTERM');
  const commands = await createCommands({
    root: h.root,
    createController,
    onAuthorizationUrl: h.onAuthorizationUrl,
  });
  await assert.rejects(commands.prepareAuthor(h.config), { code: 'revoke_failed' });
  const failed = deletes;
  await assert.rejects(commands.prepareAuthor(h.config), { code: 'revoke_failed' });
  assert.equal(h.callbacks.length, 1);
  assert.ok(deletes > failed);
  refuseDelete = false;
  await commands.discardAuthor(h.config);
  assert.equal(h.counts().revoked, 1);
  assert.equal(process.listenerCount('SIGTERM'), listeners);
  await commands.discardAuthor(h.config);
  assert.equal(h.counts().revoked, 1);
  await Promise.all(h.callbacks);
});

test.each(
  ['SIGINT', 'SIGTERM'].flatMap((signal) =>
    ['confirmation', 'user', 'email', 'exchange', 'callback', 'facades', 'facades-fail'].map(
      (stage) => ({ signal, stage })
    )
  )
)('pre-broker $signal at $stage joins credential cleanup before process exit', async ({
  signal,
  stage,
}) => {
  const h = rig();
  const code = `
    const nativeFetch = globalThis.fetch;
    const stage = ${JSON.stringify(stage)};
    let issued = 0;
    const { createCommands } = await import(${JSON.stringify(new URL('./zt-run-bindings.mjs', import.meta.url).href)});
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/login/oauth/access_token') {
        issued++;
        process.stdout.write('ISSUED\\n');
        if (stage === 'exchange') {
          process.stdout.write('AUTHOR_READY\\n');
          await new Promise(r => setTimeout(r, 100));
        }
        return new Response(JSON.stringify({ access_token: 'ghu_'+'a'.repeat(29)+issued, refresh_token: 'ghr_'+'b'.repeat(29)+issued, expires_in: 3600 }));
      }
      if (url.pathname === '/user' || url.pathname === '/user/emails') {
        if ((stage === 'user' && url.pathname === '/user') || (stage === 'email' && url.pathname === '/user/emails')) {
          process.stdout.write('AUTHOR_READY\\n');
          return new Promise(() => {});
        }
        return new Response(JSON.stringify(url.pathname === '/user' ? { id: 12, login: 'contributor', name: 'Verified Name' } : [{ email: 'verified@example.org', verified: true }]));
      }
      if (url.pathname === '/applications/fixture/token' && init.method === 'DELETE') {
        const second = JSON.parse(init.body).access_token.endsWith('2');
        await new Promise(r => setTimeout(r, second ? 500 : 50));
        if (second && stage === 'facades-fail') return new Response(null, { status: 503 });
        process.stdout.write('REVOKED\\n');
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected_request');
    };
    const options = { root: ${JSON.stringify(h.root)}, createController: () => { throw new Error('no execution'); }, onAuthorizationUrl: value => {
      if (stage === 'callback') { process.stdout.write('AUTHOR_READY\\n'); return; }
      const page = new URL(value);
      const redirect = new URL(page.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', page.searchParams.get('state'));
      redirect.searchParams.set('code', 'approved');
      void nativeFetch(redirect);
    } };
    const commands = await createCommands(options);
    setInterval(() => {}, 1000); // Physical transport/TTY liveness while scripted reads await.
    await commands.prepareAuthor(${JSON.stringify(h.config)}, stage === 'email' ? { email: 'verified@example.org' } : {}).catch(() => {});
    if (stage.startsWith('facades')) await (await createCommands(options)).prepareAuthor({ ...${JSON.stringify(h.config)}, issueUrl: 'https://github.com/owner/repo/issues/2' });
    if (stage === 'confirmation' || stage.startsWith('facades')) process.stdout.write('AUTHOR_READY\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  let sent = false;
  child.stderr.on('data', (bytes) => {
    errors += bytes;
  });
  child.stdout.on('data', (bytes) => {
    output += bytes;
    if (!sent && output.includes('AUTHOR_READY')) {
      sent = true;
      child.kill(signal);
    }
  });
  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signal cleanup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', (status, killedBy) => {
        clearTimeout(timer);
        resolve({ status, killedBy });
      });
    });
    assert.deepEqual(exit, { status: signal === 'SIGINT' ? 130 : 143, killedBy: null }, errors);
    if (stage === 'callback') {
      assert.ok(!output.includes('ISSUED'));
      assert.ok(!output.includes('REVOKED'));
    } else {
      assert.match(output, /ISSUED\n/);
      assert.match(output, /AUTHOR_READY\nREVOKED\n/);
      if (stage === 'facades') assert.equal(output.match(/REVOKED/g).length, 2);
      if (stage === 'facades-fail')
        assert.match(errors, /error: revoke_failed; revoke the App authorization/);
    }
    assert.equal(fs.existsSync(h.root), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('resume delegates identity admission to the locked controller without a CLI OAuth preflight', async () => {
  const h = rig();
  const calls = [];
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: (config) => ({
      resume: async (...args) => {
        calls.push({ config, args });
        throw Object.assign(new Error(), { code: 'author_approval_mismatch' });
      },
    }),
  });
  const approval = await commands.prepareAuthor(h.config);
  await commands.discardAuthor(h.config);
  const store = h.seed({ ...h.config, authorApproval: approval });
  const runId = store.runId;
  store.close();
  h.setUser(13);
  await assert.rejects(commands.resume(runId), { code: 'author_approval_mismatch' });
  await assert.rejects(commands.resume(runId, { revise: true }), {
    code: 'author_approval_mismatch',
  });
  assert.equal(commands.status(runId).state, 'gating');
  assert.deepEqual(h.counts(), { revoked: 1, userReads: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.authorApproval.userId, approval.userId);
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      [runId, { revise: false }],
      [runId, { revise: true }],
    ]
  );
  await Promise.all(h.callbacks);
});
test('shipping resume reaches the controller with an unavailable OAuth UI', async () => {
  const h = rig();
  const setup = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController,
  });
  const approval = await setup.prepareAuthor(h.config);
  await setup.discardAuthor(h.config);
  const store = h.seed({ ...h.config, authorApproval: approval });
  const runId = store.runId;
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
  ])
    store.persistRun(transitionRun(store.run, reason, store.run.updatedAt));
  store.close();
  let reached = false;
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: () => assert.fail('no OAuth for observation'),
    createController: () => ({
      resume: async (id) => {
        reached = true;
        return { runId: id };
      },
    }),
  });
  assert.equal((await commands.resume(runId)).state, 'shipping');
  assert.equal(reached, true);
  assert.deepEqual(h.counts(), { revoked: 1, userReads: 1 });
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
  assert.deepEqual(destroyed, ['one', 'one', 'one', 'two']);
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
  await commands.discardAuthor(h.config);
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

test('resolve durably settles only the selected token without OAuth and retains independent obligations', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  const budget = new BudgetLedger(
    path.join(store.storeDirectory('budget'), 'ledger.json'),
    store.contributionId
  );
  const hold = budget.reserve(
    store.budgetSessionId(1),
    {
      money: { currency: 'USD', minor: 0 },
      tokens: 1,
      timeMs: 1,
      rates: store.config.modelProfile.rates,
    },
    'work'
  );
  store.persistRun(transitionRun(store.run, ReasonCode.CleanupFailed, new Date().toISOString()));
  const tokenIds = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
  const tokens = new Journal(store.storeDirectory('tokens'));
  const journal = new TokenJournal(tokens);
  for (const id of tokenIds) {
    journal.record({
      v: 1,
      type: 'token_requested',
      id,
      kind: 'user',
      parentId: null,
      intentKey: null,
      attempt: null,
      repositoryId: null,
      at: new Date().toISOString(),
      useBy: null,
    });
    journal.record({ v: 1, type: 'token_minted', id, expiresAt: '2020-01-01T00:00:00.000Z' });
    journal.record({ v: 1, type: 'token_expired', id, at: new Date().toISOString() });
  }
  const tokenFile = path.join(store.storeDirectory('tokens'), 'events.jsonl');
  tokens.close();
  const steps = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  new StepArtifacts(steps, runId).put('fork', {
    repositoryId: 22,
    installationId: 33,
    owner: 'contributor',
  });
  steps.close();
  const commands = await createCommands({
    root: h.root,
    createController: () => assert.fail('no controller or OAuth'),
  });
  await assert.rejects(commands.resolve(runId, tokenIds[0]), { name: 'StoreLockedError' });
  store.close();
  const before = fs.readFileSync(tokenFile);
  await assert.rejects(commands.resolve(runId, '00000000-0000-0000-0000-000000000003'), {
    code: 'invalid_input',
  });
  assert.deepEqual(fs.readFileSync(tokenFile), before);
  assert.equal((await commands.resolve(runId, tokenIds[0])).state, 'blocked_cleanup');
  let events = fs.readFileSync(tokenFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    events.filter((e) => e.type === 'operator_resolved').map((e) => e.id),
    [tokenIds[0]]
  );
  assert.equal(
    events.filter((e) => e.type === 'token_expired').length,
    2,
    'legacy access expiry does not generate new settlement evidence'
  );
  await assert.rejects(commands.resolve(runId, tokenIds[0]), { code: 'invalid_input' });
  delete process.env.BINDING_APP_KEY;
  delete process.env.BINDING_APP_SECRET;
  assert.equal((await commands.resolve(runId, tokenIds[1])).state, 'blocked_cleanup');
  budget.release(hold.id, 'Provider confirmed no charge');
  assert.equal((await commands.killAll('Finish operator cleanup'))[0].state, 'blocked');
  events = fs.readFileSync(tokenFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    events.filter((e) => e.type === 'operator_resolved').map((e) => e.id),
    tokenIds
  );
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});

test('kill-all settles uncertain installation expiry only at its durable bound after reopen', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.persistRun(transitionRun(store.run, ReasonCode.CleanupFailed, new Date().toISOString()));
  const tokens = new Journal(store.storeDirectory('tokens'));
  const journal = new TokenJournal(tokens);
  const id = '00000000-0000-0000-0000-000000000004';
  const observed = new Date();
  const expiry = new Date(observed.getTime() + 3600000);
  journal.record({
    v: 1,
    type: 'token_requested',
    id,
    kind: 'installation',
    parentId: null,
    intentKey: 'push',
    attempt: 1,
    repositoryId: 22,
    at: observed.toISOString(),
    useBy: expiry.toISOString(),
  });
  journal.record({
    v: 1,
    type: 'token_mint_uncertain',
    id,
    status: 201,
    at: observed.toISOString(),
    expiresAt: expiry.toISOString(),
  });
  journal.record({ v: 1, type: 'token_unrevocable', id, at: observed.toISOString() });
  const tokenFile = path.join(store.storeDirectory('tokens'), 'events.jsonl');
  tokens.close();
  const steps = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  new StepArtifacts(steps, runId).put('fork', {
    repositoryId: 22,
    installationId: 33,
    owner: 'contributor',
  });
  steps.close();
  store.close();
  const vm = new FakeVmAdapter();
  await stopStoredRun(h.root, runId, 'Retry cleanup', {
    vm,
    now: () => new Date(expiry.getTime() - 1),
  });
  const commands = await createCommands({
    root: h.root,
    createController: () => assert.fail('no OAuth'),
  });
  assert.equal(commands.status(runId).state, 'blocked_cleanup');
  delete process.env.BINDING_APP_KEY;
  delete process.env.BINDING_APP_SECRET;
  await stopStoredRun(h.root, runId, 'Retry cleanup', { vm, now: () => expiry });
  const reopened = RunStore.open(h.root, runId);
  assert.equal(reopened.run.state, 'blocked');
  reopened.close();
  const events = fs.readFileSync(tokenFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((e) => e.type === 'token_expired' && e.id === id).length, 1);
  assert.deepEqual(h.counts(), { revoked: 0, userReads: 0 });
});

test('cross-process incident fences an active writer, aborts its await, joins cleanup and issues no subsequent phase', async () => {
  const h = rig();
  const vm = new FakeVmAdapter();
  const recovery = new ScriptedRecovery();
  const phases = [];
  let entered;
  let entryFailed;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const controller = new RunController({
    root: h.root,
    vm,
    recovery,
    drivers: [],
    now: () => new Date(),
    incidentRequested: () => incidentRequested(h.root),
    estimateVm: () => ({
      money: { currency: 'USD', minor: 0 },
      tokens: 0,
      timeMs: 1,
      rates: [{ ...h.config.modelProfile.rates[0], resource: 'local-qemu', unit: 'millisecond' }],
    }),
    observeVm: async () => ({
      money: { currency: 'USD', minor: 0 },
      tokens: 0,
      timeMs: 1,
      source: 'observed',
    }),
    steps: {
      gate: async (context) => {
        phases.push('gate');
        try {
          await context.createVm({ scope: 'container' });
        } catch (error) {
          entryFailed = error;
          entered(null);
          throw error;
        }
        entered(context.run.runId);
        await new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve, { once: true })
        );
        return { kind: 'proceed' };
      },
      acquire: async () => {
        phases.push('acquire');
        assert.fail('incident admits no subsequent phase');
      },
    },
  });
  const running = controller.start(h.config);
  void running.catch(() => {});
  const runId = await ready;
  if (entryFailed) throw entryFailed;
  const child = spawn(
    process.execPath,
    ['scripts/zt-run.mjs', 'kill-all', '--root', h.root, '--reason', 'Incident'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const stopped = await running;
    assert.equal(stopped.state, 'cancelled');
    assert.equal(await exited, 0, stderr);
    assert.deepEqual(phases, ['gate']);
    assert.ok(recovery.calls.includes('kill'));
    assert.deepEqual(await vm.listByRun(runId), []);
    assert.ok(
      vm.calls.some(
        (call) => call.operation === 'destroy' || call.op === 'destroy' || call.kind === 'destroy'
      )
    );
    assert.equal(fs.existsSync(path.join(h.dir, 'vms', 'KILL_SWITCH')), true);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('incident cleanup attempts valid stores despite junk, signer loss and recoverable snapshot publication', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.close();
  fs.unlinkSync(h.config.signerKeyFile);
  fs.writeFileSync(path.join(h.root, 'junk'), 'untrusted');
  const commands = await createCommands({ root: h.root, createController });
  await assert.rejects(commands.killAll('Incident'), { code: 'invalid_store' });
  assert.equal(commands.status(runId).state, 'cancelled');
});

test('resume permits supported crash recovery without changing held config/approval', async () => {
  const h = rig();
  let continued = 0;
  const commands = await createCommands({
    root: h.root,
    onAuthorizationUrl: h.onAuthorizationUrl,
    createController: (config) => ({
      resume: async (runId) => {
        continued++;
        const store = RunStore.open(h.root, runId);
        try {
          assert.deepEqual(config, store.config);
          return store.run;
        } finally {
          store.close();
        }
      },
    }),
  });
  const approval = await commands.prepareAuthor(h.config);
  const store = h.seed({ ...h.config, authorApproval: approval });
  const runId = store.runId;
  const directory = store.storeDirectory('control');
  const prior = store.run;
  store.close();
  const journal = new Journal(directory);
  journal.append({
    v: 1,
    type: 'run',
    run: transitionRun(prior, ReasonCode.GatePassed, new Date().toISOString()),
  });
  journal.close();
  const result = await commands.resume(runId);
  assert.equal(result.state, 'planning');
  assert.equal(continued, 1);
  assert.deepEqual(result.authorApproval, approval);
  await Promise.all(h.callbacks);
});

test('eligible dry-run sweep records zero deletion calls and preserves every byte; an injected deletion fails that assertion', async () => {
  const h = rig();
  const old = new Date(Date.now() - 40 * 86400000);
  const store = h.seed(h.config, old);
  store.replaceArtifact('notes.txt', Buffer.from('Eligible retained notes'));
  const artifact = path.join(store.storeDirectory('artifacts'), 'notes.txt');
  fs.utimesSync(artifact, old, old);
  store.close();
  for (const e of fs.readdirSync(h.root, { recursive: true, withFileTypes: true }))
    if (e.isFile()) fs.utimesSync(path.join(e.parentPath ?? e.path, e.name), old, old);
  const snapshot = () =>
    fs
      .readdirSync(h.root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = path.join(e.parentPath ?? e.path, e.name);
        return [
          path.relative(h.root, file),
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ];
      })
      .sort();
  const before = snapshot();
  const calls = [];
  const nativeUnlink = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    calls.push(file);
    return nativeUnlink(file);
  });
  const commands = await createCommands({ root: h.root, createController });
  const planned = commands.sweep({ apply: false });
  assert.equal(planned.files, 1);
  assert.equal(planned.applied, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(), before);
  const file = new URL('./zt-run-bindings.mjs', import.meta.url);
  const source = fs
    .readFileSync(file, 'utf8')
    .replaceAll("from '../dist/", `from '${new URL('../dist/', import.meta.url).href}`)
    .replace('if (apply) applySweep(plan);', 'applySweep(plan);');
  const mutated = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  (await mutated.createCommands({ root: h.root, createController })).sweep({ apply: false });
  assert.ok(calls.length > 0);
  assert.throws(() => assert.deepEqual(snapshot(), before));
});

test('a clean retry closes an enumeration-only cleanup block without erasing uncertain accounting', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  store.close();
  let fail = true;
  const vm = {
    listByRun: async () => {
      if (fail) throw new Error('enumeration unavailable');
      return [];
    },
    destroy: async () => assert.fail('no guest'),
  };
  await stopStoredRun(h.root, runId, 'Incident', { vm });
  assert.equal(
    (await createCommands({ root: h.root, createController })).status(runId).state,
    'blocked_cleanup'
  );
  fail = false;
  await stopStoredRun(h.root, runId, 'Incident', { vm });
  assert.equal(
    (await createCommands({ root: h.root, createController })).status(runId).state,
    'blocked'
  );
});

test('second CLI start for the same trusted config exits 4 while its first run is writer-locked', async () => {
  const h = rig();
  let release;
  let started;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const factory = (config) => ({
    start: async () => {
      const store = h.seed(config);
      started();
      try {
        await hold;
        return store.run;
      } finally {
        store.close();
      }
    },
  });
  const first = await createCommands({
    root: h.root,
    createController: factory,
    onAuthorizationUrl: h.onAuthorizationUrl,
  });
  const approval = await first.prepareAuthor(h.config);
  const running = first.start({ ...h.config, authorApproval: approval });
  await ready;
  const configFile = path.join(h.dir, 'config.json');
  const { runConfigInput } = await import('../dist/controller/config.js');
  fs.writeFileSync(configFile, JSON.stringify(runConfigInput(h.config)));
  const out = [],
    err = [];
  try {
    const code = await main(
      ['start', '--root', h.root, '--config', configFile, '--confirm-author'],
      {
        createController: (options) =>
          createCommands({
            ...options,
            onAuthorizationUrl: h.onAuthorizationUrl,
            createController: () =>
              assert.fail('locked start cannot construct an execution controller'),
          }),
        out: (s) => out.push(s),
        err: (s) => err.push(s),
      }
    );
    assert.equal(code, 4);
    assert.deepEqual(err, ['error: store_locked']);
    assert.equal(fs.readdirSync(h.root).length, 1);
  } finally {
    release();
    await running;
  }
  await Promise.all(h.callbacks);
});

test('incident-fenced resume preserves immediate lock exit 4, and both sweep modes work after incident stop', async () => {
  const h = rig();
  const store = h.seed();
  const runId = store.runId;
  fs.writeFileSync(path.join(h.root, '.incident'), 'incident', { mode: 0o600 });
  try {
    const err = [];
    const commands = await createCommands({ root: h.root, createController });
    const started = Date.now();
    const code = await main(['resume', '--root', h.root, '--run', runId], {
      createController: () => commands,
      out: () => assert.fail('locked resume has no status output'),
      err: (s) => err.push(s),
    });
    assert.equal(code, 4);
    assert.deepEqual(err, ['error: store_locked']);
    assert.ok(Date.now() - started < 5000);
  } finally {
    store.close();
  }
  const commands = await createCommands({ root: h.root, createController });
  await commands.killAll('Incident');
  assert.equal(commands.sweep().applied, false);
  assert.equal(commands.sweep({ apply: true }).applied, true);
  assert.equal(fs.readFileSync(path.join(h.root, '.incident'), 'utf8'), 'incident');
});
