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
  resume: ['--run', run],
  status: ['--run', run],
  approve: ['--run', run, '--checkpoint', 'plan', '--digest', digest],
  reject: ['--run', run, '--checkpoint', 'plan', '--digest', digest, '--reason', 'Review declined'],
  authorize: ['--run', run],
  'kill-all': ['--reason', 'Incident'],
  metrics: [],
  adoption: ['--run', run, '--note', 'Voluntary observation'],
  sweep: [],
  export: ['--run', run, '--out', 'export.json'],
  start: ['--config', 'config.json'],
};
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
        return command === 'kill-all'
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
  }
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
    assert.match(r.stdout[0], /^author_identity:/u);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].authorApproval, approval);
  assert.equal(fs.existsSync(h.root), false);
});
test('invalid, unsupported and secret configs fail before factories with fixed errors and no store directory', async () => {
  const h = rig();
  for (const [raw, code, error] of [
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
