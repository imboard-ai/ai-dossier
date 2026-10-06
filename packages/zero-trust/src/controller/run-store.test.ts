import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replacePrivate } from '../durable-fs';
import { StoreLockedError } from '../lock';
import { ReasonCode, transitionRun } from '../state';
import { validateRunConfig } from './config';
import { RUN_STORE_DIRECTORIES, RunStore, RunStoreError } from './run-store';

const dirs: string[] = [];
const handles: RunStore[] = [];
const START = '2026-10-05T00:00:00.000Z';
const LATER = '2026-10-05T00:01:00.000Z';
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-store-'));
  dirs.push(root);
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
      rates: [
        {
          resource: 'fake',
          currency: 'USD',
          unit: 'token',
          price: 0,
          units: 1,
          source: 'fixture',
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: START },
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
  });
  const store = RunStore.create(path.join(root, 'stores'), config, START);
  handles.push(store);
  return { root: path.join(root, 'stores'), config, store };
}
function open(root: string, id: string) {
  const s = RunStore.open(root, id);
  handles.push(s);
  return s;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of handles.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('RunStore', () => {
  it('creates every dedicated private directory and durable config/run then restores', () => {
    const { root, config, store } = rig();
    expect(store.contributionId).toMatch(/^ztc-[a-f0-9]{16}$/u);
    expect(store.runId).toBe(`${store.contributionId}-run-1`);
    expect(store.budgetSessionId(2)).toBe(`${store.runId}-s2`);
    expect(() => store.budgetSessionId(0)).toThrow(RunStoreError);
    for (const name of RUN_STORE_DIRECTORIES) {
      expect(fs.statSync(store.storeDirectory(name)).mode & 0o777).toBe(0o700);
    }
    for (const file of ['config.json', 'config.sha256', 'run.json', '.controller.guard'])
      expect(fs.statSync(path.join(store.directory, file)).mode & 0o777).toBe(0o600);
    const next = transitionRun(store.run, ReasonCode.GatePassed, LATER);
    store.persistRun(next);
    store.persistRun(next);
    store.recordUpstreamRepositoryId(123);
    store.recordUpstreamRepositoryId(123);
    expect(() => store.recordUpstreamRepositoryId(124)).toThrow(
      new RunStoreError('resume_identity_mismatch')
    );
    expect(() => store.recordUpstreamRepositoryId(0)).toThrow(RunStoreError);
    store.assertResumeMatches({ ...config, upstreamRepositoryId: 123 });
    const copy = store.config;
    (copy as { contributor: string }).contributor = 'other';
    expect(store.config.contributor).toBe('contributor');
    const id = store.runId;
    store.close();
    const restored = open(root, id);
    expect(restored.run).toEqual(next);
    expect(restored.config).toEqual(config);
    expect(restored.upstreamRepositoryId).toBe(123);
  });
  it('holds lifetime exclusion within this process and independent processes', () => {
    const { root, store } = rig();
    expect(() => RunStore.open(root, store.runId)).toThrow(StoreLockedError);
    const script = `const {RunStore}=require('./dist/controller/run-store');try{RunStore.open(process.argv[1],process.argv[2]);process.exit(2)}catch(e){if(e.name!=='StoreLockedError')throw e}`;
    const result = spawnSync(process.execPath, ['-e', script, root, store.runId], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it('reopens after a crashed process drops its handle without close', async () => {
    const { root, store } = rig();
    const id = store.runId;
    store.close();
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const {RunStore}=require('./dist/controller/run-store');const s=RunStore.open(process.argv[1],process.argv[2]);process.stdout.write('ready');setInterval(()=>{},1000)`,
        root,
        id,
      ],
      { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
      });
      expect(() => RunStore.open(root, id)).toThrow(StoreLockedError);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(open(root, id).run.state).toBe('gating');
    } finally {
      child.kill('SIGKILL');
    }
  });
  it.each([
    'contributor',
    'issueUrl',
    'provider',
    'upstreamRepositoryId',
  ] as const)('refuses changed resume %s', (field) => {
    const { config, store } = rig();
    store.recordUpstreamRepositoryId(123);
    const changed = {
      ...config,
      upstreamRepositoryId: 123,
      ...(field === 'provider'
        ? { executionProfile: { provider: 'another' } }
        : { [field]: field === 'upstreamRepositoryId' ? 124 : 'changed' }),
    };
    expect(() => store.assertResumeMatches(changed)).toThrow(
      new RunStoreError('resume_identity_mismatch')
    );
    expect(() => store.assertResumeMatches(config)).toThrow(RunStoreError);
  });
  it('refuses rollback and divergent history even when each record replays legally', () => {
    const { root, store } = rig();
    const initial = store.run;
    const current = transitionRun(initial, ReasonCode.GatePassed, LATER);
    store.persistRun(current);
    expect(() => store.persistRun(initial)).toThrow(new RunStoreError('run_diverged'));
    const divergent = transitionRun(initial, ReasonCode.PermissionRequired, LATER);
    expect(() => store.persistRun(divergent)).toThrow(RunStoreError);
    const id = store.runId;
    store.close();
    replacePrivate(path.join(store.directory, 'run.json'), Buffer.from(JSON.stringify(divergent)));
    expect(() => RunStore.open(root, id)).toThrow(new RunStoreError('run_diverged'));
  });
  it.each([
    'truncated',
    'secret',
    'config-digest',
    'missing-journal',
    'corrupt-journal',
    'run-identity',
    'permissions',
    'missing-layout',
  ])('refuses %s evidence without resetting', (kind) => {
    const { root, store } = rig();
    const id = store.runId;
    const run = store.run;
    store.close();
    const runFile = path.join(store.directory, 'run.json');
    if (kind === 'truncated') replacePrivate(runFile, Buffer.from('{'));
    if (kind === 'secret')
      replacePrivate(runFile, Buffer.from(JSON.stringify({ ...run, extra: 'ghp_secret' })));
    if (kind === 'config-digest')
      replacePrivate(path.join(store.directory, 'config.json'), Buffer.from('{}'));
    if (kind === 'missing-journal')
      fs.unlinkSync(path.join(store.directory, 'control/events.jsonl'));
    if (kind === 'corrupt-journal')
      fs.appendFileSync(
        path.join(store.directory, 'control/events.jsonl'),
        '{"v":1,"type":"unknown"}\n'
      );
    if (kind === 'run-identity')
      replacePrivate(runFile, Buffer.from(JSON.stringify({ ...run, contributor: 'other' })));
    if (kind === 'permissions') fs.chmodSync(path.join(store.directory, 'vm'), 0o755);
    if (kind === 'missing-layout') fs.rmdirSync(path.join(store.directory, 'vm'));
    expect(() => RunStore.open(root, id)).toThrow();
  });
  it('rejects path traversal, secret persistence, invalid store paths and closed handles', () => {
    const { root, config, store } = rig();
    expect(() => RunStore.open(root, '../escape')).toThrow(new RunStoreError('invalid_run_id'));
    expect(() => store.persistRun({ ...store.run, contributor: 'ghp_secret' })).toThrow();
    expect(() => store.assertResumeMatches({ ...config, contributor: 'ghp_secret' })).toThrow();
    expect(() => RunStore.create(root, { ...config, resumeRunId: store.runId }, START)).toThrow(
      RunStoreError
    );
    expect(() => store.storeDirectory('escape' as 'vm')).toThrow(RunStoreError);
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    try {
      expect(() => RunStore.open(alias, store.runId)).toThrow(RunStoreError);
    } finally {
      fs.unlinkSync(alias);
    }
    store.close();
    expect(() => store.run).toThrow(new RunStoreError('store_closed'));
  });
});
