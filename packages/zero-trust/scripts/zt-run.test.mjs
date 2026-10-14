import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { BudgetLedger } from '../dist/budget.js';
import { runConfigInput, validateRunConfig } from '../dist/controller/config.js';
import { RunStore } from '../dist/controller/run-store.js';
import { aggregate } from '../dist/metrics/outcomes.js';
import { main, USAGE } from './zt-run-lib.mjs';

const run = 'ztc-0000000000000000-run-1';
const digest = 'a'.repeat(64);
const approval = {
  userId: 12,
  login: 'contributor',
  name: 'Profile Name',
  email: '12+contributor@users.noreply.github.com',
  source: 'default',
  approvedAt: '2026-10-10T00:00:00.000Z',
};
const status = {
  runId: run,
  phase: 'awaiting_maintainer',
  state: 'awaiting_maintainer',
  upstreamIssue: 'https://github.com/owner/repo/issues/1',
  contributor: 'contributor',
  activeTimeMs: 10,
  estimatedSpend: { amount: 1, currency: 'USD' },
  budgetRemaining: { amount: 99, currency: 'USD' },
  reasonCode: 'permission_required',
  nextPermittedAction: 'Resume explicitly.',
  authorApproval: approval,
};
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-cli-'));
  dirs.push(dir);
  const signerKeyFile = path.join(dir, 'key.pem');
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
  const raw = {
    issueUrl: status.upstreamIssue,
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      stateDir: dir,
      profileDir: 'profile',
      proxyEndpointsFile: 'proxy.json',
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
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: approval.approvedAt },
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
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
  };
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return { dir, file, raw, root: path.join(dir, 'runs') };
}
async function invoke(argv, controller = {}, extra = {}) {
  const stdout = [],
    stderr = [],
    factories = [];
  const code = await main(argv, {
    createController: (options) => {
      factories.push(options);
      return controller;
    },
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    ...extra,
  });
  return { code, stdout, stderr, factories };
}
const valid = {
  pause: ['--run', run, '--reason', 'Hold'],
  cancel: ['--run', run, '--reason', 'Stop'],
  resume: ['--run', run],
  status: ['--run', run],
  approve: ['--run', run, '--checkpoint', 'plan', '--digest', digest],
  reject: ['--run', run, '--checkpoint', 'plan', '--digest', digest, '--reason', 'Review declined'],
  authorize: ['--run', run],
  resolve: ['--run', run, '--token', '00000000-0000-0000-0000-000000000001', '--confirm-dead'],
  'kill-all': ['--reason', 'Incident'],
  metrics: [],
  adoption: ['--run', run, '--note', 'Voluntary observation'],
  sweep: [],
  export: ['--run', run, '--out', 'export.json'],
  start: ['--config', 'config.json'],
};
for (const command of ['start', 'resume']) {
  test(`${command}: progress is live before deferred work finishes, deduplicated without history replay`, async () => {
    const h = rig();
    const stdout = [];
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const running = main(
      command === 'start'
        ? ['start', '--root', h.root, '--config', h.file, '--confirm-author']
        : ['resume', '--root', h.root, '--run', run, '--revise'],
      {
        out: (line) => stdout.push(line),
        err: () => {},
        createController: ({ onRun }) => ({
          prepareAuthor: async () => approval,
          [command]: async () => {
            const record = {
              runId: run,
              state: 'revising',
              reasonCode: 'revision_requested',
              updatedAt: '2026-10-10T11:46:39.000Z',
              history: Array(12),
            };
            onRun(record);
            onRun(record);
            onRun({
              ...record,
              state: 'verifying',
              reasonCode: 'candidate_ready',
              updatedAt: '2026-10-10T11:48:27.000Z',
              history: Array(13),
            });
            entered(true);
            await waiting;
            return status;
          },
        }),
      }
    );
    assert.equal(
      await Promise.race([ready, running.then(() => false)]),
      true,
      'progress must arrive before completion'
    );
    assert.match(stdout[0], /Work continues after authorization.*3–6 minutes/);
    assert.deepEqual(
      stdout.filter((line) => /^\d\d:/u.test(line)),
      ['11:46:39Z revising / revision_requested', '11:48:27Z verifying / candidate_ready']
    );
    assert.ok(!stdout.some((line) => line.includes('upstreamIssue:')));
    release();
    assert.equal(await running, 0);
    assert.match(stdout.at(-1), /upstreamIssue:/);
  });
}
test('progress snapshots getters once and refuses malformed/secret lifecycle text without echo', async () => {
  for (const change of [
    { state: 'verifying\nspoof' },
    { reasonCode: 'Bearer synthetic-secret-value' },
    { updatedAt: '2026-02-30T11:48:27.000Z' },
    { history: { length: -1 } },
  ]) {
    const result = await invoke(
      ['resume', '--root', 'runs', '--run', run],
      {},
      {
        createController: ({ onRun }) => ({
          resume: async () => {
            onRun({
              runId: run,
              state: 'verifying',
              reasonCode: 'candidate_ready',
              updatedAt: '2026-10-10T11:48:27.000Z',
              history: [1],
              ...change,
            });
            return status;
          },
        }),
      }
    );
    assert.notEqual(result.code, 0);
    assert.ok(!result.stdout.join('\n').includes('spoof'));
    assert.ok(!result.stdout.join('\n').includes('synthetic-secret-value'));
    assert.equal(result.stdout.filter((line) => /^\d\d:/u.test(line)).length, 0);
  }
  let reads = 0;
  const result = await invoke(
    ['resume', '--root', 'runs', '--run', run],
    {},
    {
      createController: ({ onRun }) => ({
        resume: async () => {
          onRun({
            runId: run,
            get state() {
              reads++;
              return reads === 1 ? 'verifying' : 'Bearer synthetic-secret-value';
            },
            reasonCode: 'candidate_ready',
            updatedAt: '2026-10-10T11:48:27.000Z',
            history: [1],
          });
          return status;
        },
      }),
    }
  );
  assert.equal(result.code, 0);
  assert.equal(reads, 1);
  assert.ok(result.stdout.includes('11:48:27Z verifying / candidate_ready'));
});
test('read-only JSON commands never receive progress callbacks or wait messages', async () => {
  const r = await invoke(['status', '--root', 'runs', '--run', run, '--json'], {
    status: async () => status,
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 1);
  assert.equal(JSON.parse(r.stdout[0]).state, status.state);
  assert.equal(r.factories[0].onRun, undefined);
  const metrics = aggregate([]);
  const m = await invoke(['metrics', '--root', 'runs', '--json'], { metrics: async () => metrics });
  assert.equal(m.code, 0);
  assert.equal(m.stdout.length, 1);
  assert.deepEqual(JSON.parse(m.stdout[0]), JSON.parse(JSON.stringify(metrics)));
  assert.equal(m.factories[0].onRun, undefined);
});
for (const [command, args] of Object.entries(valid)) {
  test(`${command}: closed parser refuses missing/unknown/duplicate/positional arguments before effects`, async () => {
    for (const argv of [
      [command, ...args],
      [command, '--root', 'runs', ...args, '--unknown'],
      [command, '--root', 'runs', ...args, '--root', 'other'],
      [command, '--root', 'runs', ...args, 'extra'],
    ]) {
      const r = await invoke(argv);
      assert.equal(r.code, 3);
      assert.ok(r.stderr.includes(USAGE));
      assert.equal(r.factories.length, 0);
    }
  });
}
test('all valid command dispatches preserve exact arguments and defaults', async () => {
  for (const [command, args] of Object.entries(valid).filter(([c]) => c !== 'start')) {
    const calls = [];
    const method = command === 'kill-all' ? 'killAll' : command;
    const controller = {
      [method]: (...a) => {
        calls.push(a);
        return ['pause', 'cancel'].includes(command)
          ? { kind: command, runId: run, id: '00000000-0000-0000-0000-000000000000' }
          : command === 'kill-all'
            ? [status]
            : command === 'metrics'
              ? aggregate([])
              : command === 'sweep'
                ? { applied: false, contributions: 0, files: 0 }
                : status;
      },
    };
    const r = await invoke([command, '--root', 'runs', ...args], controller);
    assert.equal(r.code, 0);
    assert.equal(calls.length, 1);
    if (command === 'sweep') assert.deepEqual(calls[0], [{ apply: false }]);
    if (command === 'resume') assert.deepEqual(calls[0], [run, { revise: false }]);
    if (command === 'approve') assert.deepEqual(calls[0], [run, { point: 'plan', digest }]);
    if (command === 'resolve')
      assert.deepEqual(calls[0], [run, '00000000-0000-0000-0000-000000000001']);
  }
});
test('resolve requires explicit death confirmation and an exact token ID before effects', async () => {
  for (const args of [
    ['--token', '00000000-0000-0000-0000-000000000001'],
    ['--token', '../tokens', '--confirm-dead'],
    ['--token', '00000000-0000-0000-0000-000000000001', '--confirm-dead', 'false'],
  ]) {
    const r = await invoke(['resolve', '--root', 'runs', '--run', run, ...args]);
    assert.equal(r.code, 3);
    assert.equal(r.factories.length, 0);
  }
});
test('contributor commands preserve inputs and print only contributor-confirmed links', async () => {
  for (const [command, args, expected] of [
    [
      'pr-edit',
      ['--title', 'Fix', '--body-file', 'body.md'],
      { kind: 'edit', title: 'Fix', bodyFile: 'body.md' },
    ],
    [
      'withdraw',
      ['--reason', 'maintainer_request', '--explanation', 'Superseded'],
      { kind: 'withdraw', reason: 'maintainer_request', explanation: 'Superseded' },
    ],
    ['cancel-action', [], { kind: 'cancel-action' }],
  ]) {
    const calls = [];
    const r = await invoke([command, '--root', 'runs', '--run', run, ...args], {
      prAction: (...a) => {
        calls.push(a);
        return {
          link: 'https://github.com/owner/repo/pull/1',
          instructions: 'Open the link from your own account, then resume to confirm.',
        };
      },
    });
    assert.equal(r.code, 0);
    assert.deepEqual(calls, [[run, expected]]);
    assert.ok(r.stdout[0].startsWith('contributor_link:'));
    assert.ok(r.stdout[1].includes('confirm'));
    const invalid = await invoke([command, '--root', 'runs', '--run', run, ...args, '--unknown']);
    assert.equal(invalid.code, 3);
    assert.equal(invalid.factories.length, 0);
  }
});
test('contributor commands reject unknown withdrawal reasons and untrusted links', async () => {
  const invalid = await invoke([
    'withdraw',
    '--root',
    'runs',
    '--run',
    run,
    '--reason',
    'other',
    '--explanation',
    'Text',
  ]);
  assert.equal(invalid.code, 3);
  assert.equal(invalid.factories.length, 0);
  const result = await invoke(['cancel-action', '--root', 'runs', '--run', run], {
    prAction: () => ({ link: 'https://evil.example/pull/1', instructions: 'Text' }),
  });
  assert.equal(result.code, 2);
  assert.deepEqual(result.stdout, []);
});
test('help documents the syntax of every command named in usage', async () => {
  const lines = [];
  assert.equal(await main(['--help'], { out: (line) => lines.push(line), err: () => {} }), 0);
  const help = lines.join('\n').split('\n').slice(1);
  const commands = /<([a-z|-]+)>/u.exec(USAGE)[1].split('|');
  for (const command of commands)
    assert.ok(
      help.some((line) => line === command || line.startsWith(`${command} `)),
      `help is missing ${command}`
    );
  assert.match(
    lines.join('\n'),
    /withdraw --run <id> --reason <maintainer_request\|user_instruction>/u
  );
});
test('status human and JSON carry identical parsed facts, including recorded author', async () => {
  const human = await invoke(['status', '--root', 'runs', '--run', run], { status: () => status });
  const json = await invoke(['status', '--root', 'runs', '--run', run, '--json'], {
    status: () => status,
  });
  const facts = Object.fromEntries(
    human.stdout[0].split('\n').map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i), JSON.parse(line.slice(i + 1))];
    })
  );
  assert.deepEqual(facts, JSON.parse(json.stdout[0]));
  assert.deepEqual(facts.authorApproval, approval);
});
test('edit reads exact bounded patch bytes and resume passes model/checkpoint inputs', async () => {
  const h = rig();
  const file = path.join(h.dir, 'edit.diff');
  const bytes = Buffer.from('diff --git a/file b/file\nold mode 100644\nnew mode 100755\n');
  fs.writeFileSync(file, bytes);
  const calls = [];
  const edited = await invoke(['edit', '--root', h.root, '--run', run, '--patch', file], {
    edit: (...args) => {
      calls.push(args);
      return status;
    },
  });
  assert.equal(edited.code, 0);
  assert.deepEqual(calls, [[run, bytes]]);
  const profileFile = path.join(h.dir, 'model.json');
  fs.writeFileSync(profileFile, JSON.stringify(h.raw.modelProfile));
  const resumed = await invoke(
    [
      'resume',
      '--root',
      h.root,
      '--run',
      run,
      '--model-profile',
      profileFile,
      '--checkpoints',
      'plan,patch',
      '--revise',
      '--reviewers',
      'lead,second-lead',
    ],
    {
      resume: (...args) => {
        calls.push(args);
        return status;
      },
    }
  );
  assert.equal(resumed.code, 0);
  assert.deepEqual(calls[1], [
    run,
    {
      revise: true,
      reviewers: ['lead', 'second-lead'],
      modelProfile: h.raw.modelProfile,
      checkpoints: ['plan', 'patch'],
    },
  ]);
  const malformed = await invoke([
    'edit',
    '--root',
    h.root,
    '--run',
    run,
    '--patch',
    file,
    '--unsafe-paths',
  ]);
  assert.equal(malformed.code, 3);
  assert.equal(malformed.factories.length, 0);
});
test('start displays author and records explicit/interactive consent; absent or declined consent cannot create a run', async () => {
  const h = rig();
  const calls = [];
  const controller = {
    prepareAuthor: () => approval,
    start: (config) => {
      calls.push(config);
      return status;
    },
  };
  const argv = ['start', '--root', h.root, '--config', h.file];
  assert.equal((await invoke(argv, controller)).code, 2);
  assert.equal(calls.length, 0);
  const declined = await invoke(argv, controller, { confirmAuthor: async () => false });
  assert.equal(declined.code, 2);
  assert.equal(calls.length, 0);
  for (const extra of [
    { argv: [...argv, '--confirm-author'], deps: {} },
    {
      argv,
      deps: {
        confirmAuthor: async (a) => {
          assert.deepEqual(a, approval);
          return true;
        },
      },
    },
  ]) {
    const r = await invoke(extra.argv, controller, extra.deps);
    assert.equal(r.code, 0);
    assert.match(r.stdout[1], /^author_identity:/u);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].authorApproval, approval);
  assert.equal(fs.existsSync(h.root), false);
});
test('invalid, unsupported and secret configs fail before factories with fixed errors and no store directory', async () => {
  const h = rig();
  for (const [raw, code, error] of [
    [{ ...h.raw, executionProfile: null }, 3, 'invalid_config'],
    [
      { ...h.raw, executionProfile: { ...h.raw.executionProfile, provider: undefined } },
      3,
      'invalid_config',
    ],
    [
      { ...h.raw, executionProfile: { ...h.raw.executionProfile, stateDir: undefined } },
      3,
      'invalid_config',
    ],
    [{ ...h.raw, invalid: true }, 3, 'unknown_key'],
    [
      { ...h.raw, executionProfile: { ...h.raw.executionProfile, provider: 'unsupported' } },
      2,
      'unsupported_environment',
    ],
    [{ ...h.raw, contributor: `ghp_${'x'.repeat(30)}` }, 3, 'secret_detected'],
  ]) {
    fs.writeFileSync(h.file, JSON.stringify(raw));
    const r = await invoke(['start', '--root', h.root, '--config', h.file, '--confirm-author']);
    assert.equal(r.code, code);
    assert.equal(r.stderr[0], `error: ${error}`);
    assert.equal(r.factories.length, 0);
    assert.ok(!r.stderr.join('').includes('ghp_'));
    assert.equal(fs.existsSync(h.root), false);
  }
});
test('provider text, unknown codes and secrets never reach output; locked run exits 4 and refusal states exit 2', async () => {
  for (const [error, code, message] of [
    [Object.assign(new Error('ghp_DO_NOT_PRINT'), { code: 'store_locked' }), 4, 'store_locked'],
    [
      Object.assign(new Error('ghp_DO_NOT_PRINT'), { code: 'ghp_DO_NOT_PRINT' }),
      2,
      'operation_failed',
    ],
  ]) {
    const r = await invoke(['resume', '--root', 'runs', '--run', run], {
      resume: () => {
        throw error;
      },
    });
    assert.equal(r.code, code);
    assert.deepEqual(r.stderr, [`error: ${message}`]);
  }
  for (const state of ['blocked', 'failed', 'unsupported', 'cancelled', 'blocked_cleanup']) {
    assert.equal(
      (
        await invoke(['status', '--root', 'runs', '--run', run], {
          status: () => ({ ...status, state }),
        })
      ).code,
      2
    );
  }
  const poisoned = await invoke(['status', '--root', 'runs', '--run', run], {
    status: () => ({ ...status, nextPermittedAction: `ghp_${'x'.repeat(30)}` }),
  });
  assert.equal(poisoned.stdout.length, 0);
  assert.deepEqual(poisoned.stderr, ['error: secret_detected', USAGE]);
});
test('built entry help/status smoke is offline, reads a locked store and prints recorded author', () => {
  const h = rig();
  const config = validateRunConfig({ ...h.raw, authorApproval: approval });
  const store = RunStore.create(h.root, config, new Date());
  const ledger = new BudgetLedger(
    path.join(store.storeDirectory('budget'), 'ledger.json'),
    store.contributionId
  );
  ledger.initialize([], config.modelProfile.rates);
  ledger.startSession({
    id: store.budgetSessionId(1),
    ceiling: { currency: 'USD', minor: 100 },
    cleanupAllowance: 10,
    tokenLimit: 100,
    timeLimitMs: 7200000,
  });
  try {
    const help = spawnSync(process.execPath, ['scripts/zt-run.mjs', '--help'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: zt-run/u);
    assert.match(help.stdout, /pause --run <id> --reason <text>/u);
    assert.match(help.stdout, /cancel --run <id> --reason <text>/u);
    const result = spawnSync(
      process.execPath,
      ['scripts/zt-run.mjs', 'status', '--root', h.root, '--run', store.runId, '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runId, store.runId);
    assert.deepEqual(JSON.parse(result.stdout).authorApproval, approval);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(store.directory, 'config.json'), 'utf8')),
      runConfigInput(config)
    );
  } finally {
    store.close();
  }
});
