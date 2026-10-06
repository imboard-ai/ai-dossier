import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compiledFixture } from '../__tests__/compiled-fixture';
import { replacePrivate } from '../durable-fs';
import { Journal } from '../journal';
import { StoreLockedError } from '../lock';
import { SecretRedactionError } from '../redaction';
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
    const module = compiledFixture(path.dirname(root), 'controller/run-store');
    const script = `const {RunStore}=require(process.argv[3]);try{RunStore.open(process.argv[1],process.argv[2]);process.exit(2)}catch(e){if(e.name!=='StoreLockedError')throw e}`;
    const result = spawnSync(process.execPath, ['-e', script, root, store.runId, module], {
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
        `const {RunStore}=require(process.argv[3]);const s=RunStore.open(process.argv[1],process.argv[2]);process.stdout.write('ready');setInterval(()=>{},1000)`,
        root,
        id,
        compiledFixture(path.dirname(root), 'controller/run-store'),
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
    expect(() =>
      store.persistRun({ ...store.run, extra: 'ghp_secret' } as typeof store.run)
    ).toThrow(SecretRedactionError);
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

  it('rolls a pending journaled snapshot forward but rejects rollback of a confirmed one', () => {
    const { root, store } = rig();
    const initial = store.run;
    const next = transitionRun(initial, ReasonCode.GatePassed, LATER);
    const id = store.runId;
    store.close();
    const journal = new Journal(path.join(store.directory, 'control'));
    journal.append({ v: 1, type: 'run', run: next });
    journal.close();
    const recovered = open(root, id);
    expect(recovered.run).toEqual(next);
    expect(JSON.parse(fs.readFileSync(path.join(store.directory, 'run.json'), 'utf8'))).toEqual(
      next
    );
    recovered.close();
    replacePrivate(path.join(store.directory, 'run.json'), Buffer.from(JSON.stringify(initial)));
    expect(() => RunStore.open(root, id)).toThrow(new RunStoreError('run_diverged'));
  });

  it('accepts benign extra run data but refuses a token without altering durable bytes', () => {
    const { root, store } = rig();
    const id = store.runId;
    const next = transitionRun(store.run, ReasonCode.GatePassed, LATER);
    const before = fs.readFileSync(path.join(store.directory, 'control/events.jsonl'));
    expect(() => store.persistRun({ ...next, extra: 'ghp_secret' } as typeof next)).toThrow(
      SecretRedactionError
    );
    expect(fs.readFileSync(path.join(store.directory, 'control/events.jsonl'))).toEqual(before);
    store.persistRun({ ...next, extra: 'plain' } as typeof next);
    store.close();
    replacePrivate(
      path.join(store.directory, 'run.json'),
      Buffer.from(JSON.stringify({ ...next, extra: 'plain' }))
    );
    const restored = open(root, id);
    expect(restored.run).toEqual(next);
  });

  it('maps missing paths to fixed errors that never echo a planted token', () => {
    const { root, store } = rig();
    try {
      RunStore.open(path.join(root, 'ghp_secret'), store.runId);
    } catch (error) {
      expect(error).toEqual(new RunStoreError('invalid_store'));
      expect(String(error)).not.toContain('ghp_secret');
    }
  });

  it('pins snapshot publication across an ancestor replacement without redirected writes', () => {
    const { root, store } = rig();
    const moved = `${root}-moved`;
    const redirected = `${root}-redirected`;
    fs.mkdirSync(redirected);
    const destination = path.join(redirected, store.contributionId);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'run.json'), 'sentinel');
    const append = Journal.prototype.append;
    vi.spyOn(Journal.prototype, 'append').mockImplementation(function (this: Journal, event) {
      append.call(this, event);
      if ((event as { type?: string }).type === 'run') {
        fs.renameSync(root, moved);
        fs.symlinkSync(redirected, root);
      }
    });
    try {
      // Journal identity checks may fence after safe pinned publication; no redirection.
      expect(() =>
        store.persistRun(transitionRun(store.run, ReasonCode.GatePassed, LATER))
      ).toThrow(new RunStoreError('persistence_uncertain'));
      expect(fs.readFileSync(path.join(destination, 'run.json'), 'utf8')).toBe('sentinel');
      expect(
        JSON.parse(fs.readFileSync(path.join(moved, store.contributionId, 'run.json'), 'utf8'))
          .state
      ).toBe('planning');
    } finally {
      vi.restoreAllMocks();
      fs.unlinkSync(root);
      fs.renameSync(moved, root);
      fs.rmSync(redirected, { recursive: true });
    }
  });

  it.each([
    'journal-fsync',
    'snapshot-rename',
    'snapshot-fsync',
    'upstream-fsync',
  ])('poisons and retains the fence after %s until child process death', (fault) => {
    const { root, store } = rig();
    const id = store.runId;
    store.close();
    const module = compiledFixture(path.dirname(root), 'controller/run-store');
    const script = `const fs=require('node:fs'); const {RunStore}=require(process.argv[3]);const s=RunStore.open(process.argv[1],process.argv[2]);const fault=process.argv[4];const originalSync=fs.fsyncSync,originalRename=fs.renameSync;let syncs=0;fs.fsyncSync=function(fd){syncs++;if((fault==='journal-fsync'||fault==='upstream-fsync')&&syncs===1)throw Error('injected');if(fault==='snapshot-fsync'&&syncs===3)throw Error('injected');return originalSync(fd)};fs.renameSync=function(a,b){if(fault==='snapshot-rename'&&b.endsWith('/run.json'))throw Error('injected');return originalRename(a,b)};try{if(fault==='upstream-fsync')s.recordUpstreamRepositoryId(123);else{const {transitionRun,ReasonCode}=require(require('node:path').join(require('node:path').dirname(process.argv[3]),'../state'));s.persistRun(transitionRun(s.run,ReasonCode.GatePassed,'${LATER}'))}throw Error('mutation passed')}catch(e){if(e.code!=='persistence_uncertain')throw e}fs.fsyncSync=originalSync;fs.renameSync=originalRename;try{s.run;throw Error('read passed')}catch(e){if(e.code!=='persistence_uncertain')throw e}s.close();try{RunStore.open(process.argv[1],process.argv[2]);throw Error('lock released')}catch(e){if(e.name!=='StoreLockedError')throw e}process.stdout.write('fenced');`;
    const result = spawnSync(process.execPath, ['-e', script, root, id, module, fault], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('fenced');
    const recovered = open(root, id);
    expect(recovered.run.state).toBe(fault === 'upstream-fsync' ? 'gating' : 'planning');
    if (fault === 'upstream-fsync') expect(recovered.upstreamRepositoryId).toBe(123);
  });
});
