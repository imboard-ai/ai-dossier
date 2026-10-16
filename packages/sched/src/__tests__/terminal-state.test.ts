import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abandonBatch,
  abandonIssue,
  assignToIdleSlot,
  type BatchStatus,
  batchBlockers,
  createBatch,
  createEmptyState,
  enqueueEntries,
  patchBatch,
  type SCHEMA_VERSION,
  type SchedState,
  SchedStore,
  transitionBatch,
  validateState,
} from '../index';
import { memberRun } from './helpers/member-run';

const NOW = new Date('2026-10-16T12:00:00Z');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-terminal-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function running(): SchedState {
  let state = enqueueEntries(
    createEmptyState(),
    [674, 946].map((issue) => ({
      issue,
      mode: 'slot' as const,
      batch: 'old',
      dispatch: 'openai',
    })),
    NOW
  );
  state = transitionBatch(state, 'old', 'executing', {}, NOW);
  state = patchBatch(
    state,
    'old',
    {
      member_dispatch: 'parallel',
      member_runs: [
        memberRun({ issue: 674, status: 'running', pool_claimed: true }),
        memberRun({
          issue: 946,
          index: 2,
          status: 'running',
          teardown_failed_at: NOW.toISOString(),
        }),
      ],
    },
    NOW
  );
  return validateState(state);
}

function malformed(status: BatchStatus = 'dissolved'): SchedState {
  const state = createEmptyState();
  state.batches.push({
    ...createBatch('../unsafe-id', [], NOW),
    status,
    member_runs: [memberRun({ worktree: '/untrusted/cleanup-target' })],
    anchor: 999,
    worktree: '/untrusted/batch-target',
    branch: 'feature/danger',
  });
  return state;
}

function write(state: unknown): { store: SchedStore; raw: string; evidence: string } {
  const store = new SchedStore(dir);
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(store.statePath, raw);
  const digest = createHash('sha256').update(raw).digest('hex');
  return { store, raw, evidence: path.join(dir, 'quarantine', `${digest}.json`) };
}

describe('#1245 producer and current ownership', () => {
  it('abandon alone round-trips running runs, membership and OpenAI provenance', () => {
    const initial = running();
    const assigned = assignToIdleSlot(initial, 'batch:old#674', null, NOW).state;
    const state = abandonBatch(assigned, 'old', 'test', NOW).state;
    const { store } = write(state);
    expect(store.load()).toEqual(state);
    expect(state.slots.every((slot) => slot.status === 'idle')).toBe(true);
    expect(state.batches[0].member_runs).toEqual(initial.batches[0].member_runs);
    expect(state.entries.every((entry) => entry.dispatch_profile === 'openai')).toBe(true);
  });

  it.each([
    false,
    true,
  ])('producer abandon -> abandon issues -> enqueue (new batch=%s) preserves exact cleanup evidence', (newBatch) => {
    const initial = running();
    let state = abandonBatch(initial, 'old', 'test', NOW).state;
    for (const issue of [674, 946]) state = abandonIssue(state, issue, 'test', NOW).state;
    const before = structuredClone(state);
    const next = enqueueEntries(
      state,
      [674, 946].map((issue) => ({
        issue,
        mode: newBatch ? ('slot' as const) : ('full' as const),
        batch: newBatch ? 'fresh' : undefined,
        dispatch: 'openai',
      })),
      NOW
    );
    expect(state).toEqual(before);
    expect(next.batches[0].members).toEqual([674, 946]);
    expect(next.batches[0].member_runs).toEqual(initial.batches[0].member_runs);
    const { store } = write(next);
    expect(store.load()).toEqual(next);
    expect(fs.existsSync(path.join(dir, 'quarantine'))).toBe(false);
    expect(next.entries).toHaveLength(2);
  });

  it('refuses active retained-run detachment without mutating input', () => {
    const state = running();
    state.entries[0].status = 'failed';
    const before = structuredClone(state);
    expect(() => enqueueEntries(state, [{ issue: 674, mode: 'full' }], NOW)).toThrow(
      /old.*member_runs.*674.*terminal/
    );
    expect(state).toEqual(before);
  });

  it('still removes obsolete membership when no run evidence exists (#502)', () => {
    let state = abandonBatch(running(), 'old', 'test', NOW).state;
    state.batches[0].member_runs = [];
    state = abandonIssue(state, 674, 'test', NOW).state;
    const next = enqueueEntries(state, [{ issue: 674, mode: 'full' }], NOW);
    expect(next.batches[0].members).toEqual([946]);
    expect(() => validateState(next)).not.toThrow();
  });

  it.each([
    false,
    true,
  ])('dependency resolves current owner, not old terminal membership (standalone=%s)', (standalone) => {
    let state = abandonBatch(running(), 'old', 'test', NOW).state;
    state = abandonIssue(state, 674, 'test', NOW).state;
    state = enqueueEntries(
      state,
      [
        {
          issue: 674,
          mode: standalone ? 'full' : 'slot',
          batch: standalone ? undefined : 'current',
        },
        { issue: 1000, mode: 'slot', batch: 'dependent', deps: [674] },
      ],
      NOW
    );
    // Old done history must neither block a completed new owner nor satisfy a pending one.
    state.batches[0].status = 'done';
    const dependent = state.batches.find((batch) => batch.id === 'dependent');
    if (!dependent) throw new Error('missing fixture');
    expect(batchBlockers(state, dependent)).toHaveLength(1);
    if (standalone) {
      const entry = state.entries.find((entry) => entry.issue === 674);
      if (!entry) throw new Error('missing fixture entry');
      entry.status = 'done';
    } else {
      const batch = state.batches.find((batch) => batch.id === 'current');
      if (!batch) throw new Error('missing fixture batch');
      batch.status = 'done';
    }
    state.batches[0].status = 'dissolved';
    expect(batchBlockers(state, dependent)).toEqual([]);
  });
});

describe('#1245 evidence-first terminal quarantine', () => {
  it.each([
    'fifo',
    'evidence-symlink',
  ] as const)('state publication ignores a hostile fixed temporary %s and preserves exact evidence', (kind) => {
    const { store, raw, evidence } = write(malformed());
    const tmp = `${store.statePath}.tmp`;
    if (kind === 'fifo') expect(spawnSync('mkfifo', [tmp]).status).toBe(0);
    else fs.symlinkSync(evidence, tmp);
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `new(require(${JSON.stringify(path.resolve('dist/index.js'))}).SchedStore)(${JSON.stringify(dir)}).load();`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
    expect(fs.lstatSync(store.statePath).isSymbolicLink()).toBe(false);
    expect(store.load().batches[0].member_runs).toEqual([]);
    expect(fs.lstatSync(tmp)[kind === 'fifo' ? 'isFIFO' : 'isSymbolicLink']()).toBe(true);
  });

  it.each([
    'done',
    'queued',
  ] as const)('missing historical members with %s entry is assessed at the batch-record boundary', (status) => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 674, mode: 'slot', batch: 'old' }],
      NOW
    );
    state.batches[0].status = 'done';
    state.batches[0].members = [];
    state.entries[0].status = status;
    const { store, raw, evidence } = write(state);
    expect(() => validateState(state)).toThrow(/batches\[0\].*old.*members.*674/);
    if (status === 'done') {
      expect(store.load().batches[0].members).toEqual([674]);
      expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
    } else {
      expect(() => store.load()).toThrow(/active\/parked/);
      expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    }
  });

  it('kernel-guard contention never advises removing the permanent inode', async () => {
    const { store } = write(createEmptyState());
    const ready = path.join(dir, 'holder-ready');
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');new(require(${JSON.stringify(path.resolve('dist/index.js'))}).SchedStore)(${JSON.stringify(dir)}).withLock(s=>{fs.writeFileSync(${JSON.stringify(ready)},'yes');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,16000);return {state:s,result:null}});`,
      ],
      { stdio: 'ignore' }
    );
    const exited = new Promise((resolve) => holder.on('exit', resolve));
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(ready)).toBe(true);
      let caught: unknown;
      try {
        store.load();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('never unlink or replace');
      expect((caught as Error).message).not.toContain('remove');
      expect((caught as Error).message).not.toContain('no pid file found');
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
    expect(store.load()).toEqual(createEmptyState());
  }, 20000);

  it.each([
    'blocked_reason',
    'member_gates',
  ] as const)('validates malformed %s inside the record boundary for active and terminal records', (field) => {
    for (const status of ['dissolved', 'executing'] as const) {
      const state = malformed(status);
      state.batches[0].member_runs = [];
      Object.assign(
        state.batches[0],
        field === 'blocked_reason' ? { blocked_reason: 7 } : { member_gates: { '674': null } }
      );
      expect(() => validateState(state)).toThrow(new RegExp(`batches\\[0\\].*${field}`));
      const { store, raw } = write(state);
      if (status === 'dissolved') expect(store.load().batches[0].blocked_reason).toContain(field);
      else {
        expect(() => store.load()).toThrow(new RegExp(`batches\\[0\\].*${field}`));
        expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
      }
    }
  });

  it.each([
    'fifo',
    'dangling-symlink',
  ] as const)('refuses existing %s evidence promptly, preserving original state and evidence object', (kind) => {
    const { store, raw, evidence } = write(malformed());
    fs.mkdirSync(path.dirname(evidence));
    if (kind === 'fifo') {
      expect(spawnSync('mkfifo', [evidence]).status).toBe(0);
    } else fs.symlinkSync(path.join(dir, 'absent'), evidence);
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `try {new (require(${JSON.stringify(path.resolve('dist/index.js'))}).SchedStore)(${JSON.stringify(dir)}).load();process.exitCode=2;} catch(e){console.error(e.message);}`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toContain('terminal quarantine refused');
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    expect(fs.lstatSync(evidence)[kind === 'fifo' ? 'isFIFO' : 'isSymbolicLink']()).toBe(true);
    expect(fs.existsSync(path.join(dir, '.sched-lock'))).toBe(false);
  });

  it('a real SIGKILL before lock PID publication leaves no public ownerless mutex', () => {
    const { store } = write(createEmptyState());
    const child = spawnSync(process.execPath, [
      '-e',
      `const fs=require('node:fs');const w=fs.writeFileSync;fs.writeFileSync=(p,...a)=>{if(typeof p==='string'&&p.endsWith('/pid'))process.kill(process.pid,'SIGKILL');return w(p,...a)};new(require(${JSON.stringify(path.resolve('dist/index.js'))}).SchedStore)(${JSON.stringify(dir)}).load();`,
    ]);
    expect(child.signal).toBe('SIGKILL');
    expect(fs.existsSync(path.join(dir, '.sched-lock'))).toBe(false);
    expect(store.load()).toEqual(createEmptyState());
    store.withLock((state) => ({
      state: enqueueEntries(state, [{ issue: 1000 }], NOW),
      result: null,
    }));
    expect(store.load().entries[0].issue).toBe(1000);
  });

  it('a delayed stale-lock observer cannot steal a live replacement lock or erase its enqueue', async () => {
    const { store } = write(malformed());
    const lock = path.join(dir, '.sched-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '999999999');
    const observed = path.join(dir, 'observed');
    const release = path.join(dir, 'release');
    const doneB = path.join(dir, 'done-b');
    const module = JSON.stringify(path.resolve('dist/index.js'));
    const proc = (script: string) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const done = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
      return { child, done };
    };
    const a = proc(
      `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(a===${JSON.stringify(lock)}&&b.includes('.stale-')){fs.writeFileSync(${JSON.stringify(observed)},'yes');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}return rename(a,b)};const {SchedStore,enqueueEntries}=require(${module});new SchedStore(${JSON.stringify(dir)}).withLock(s=>({state:enqueueEntries(s,[{issue:1000}],new Date()),result:null}));`
    );
    let b: ReturnType<typeof proc> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(observed) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(observed)).toBe(true);
      b = proc(
        `const fs=require('node:fs');const {SchedStore,enqueueEntries}=require(${module});new SchedStore(${JSON.stringify(dir)}).withLock(s=>({state:enqueueEntries(s,[{issue:1001}],new Date()),result:null}));fs.writeFileSync(${JSON.stringify(doneB)},'yes');`
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fs.existsSync(doneB)).toBe(false);
    } finally {
      fs.writeFileSync(release, 'yes');
      await Promise.all([a.done, ...(b ? [b.done] : [])]);
    }
    expect(
      store
        .load()
        .entries.map((entry) => entry.issue)
        .sort()
    ).toEqual([1000, 1001]);
  }, 20000);

  it.each([
    'done',
    'dissolved',
    'stopped',
  ] as const)('isolates %s with exact evidence and inert references; fresh reopen warns', (status) => {
    const state = malformed(status);
    state.entries = enqueueEntries(createEmptyState(), [{ issue: 901 }], NOW).entries;
    Object.assign(state.entries[0], { batch: '../unsafe-id', mode: 'slot', status: 'failed' });
    const { store, raw, evidence } = write(state);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = store.load();
    expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
    expect(fs.readdirSync(path.join(dir, 'quarantine'))).toHaveLength(2);
    const manifest = JSON.parse(
      fs.readFileSync(evidence.replace('.json', '.manifest.json'), 'utf8')
    );
    expect(manifest.records[0]).toMatchObject({ index: 0, id: '../unsafe-id' });
    expect(manifest.records[0].reason).toContain('member_runs[0]');
    expect(loaded.batches[0]).toMatchObject({
      id: '../unsafe-id',
      status,
      members: [901],
      member_runs: [],
      worktree: null,
      member_worktree: null,
      branch: null,
      anchor: null,
      pr: null,
      ranges: [],
    });
    expect(loaded.batches[0].blocked_reason).toContain(evidence);
    expect(() => validateState(loaded)).not.toThrow();
    warn.mockClear();
    expect(new SchedStore(dir).load()).toEqual(loaded);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(evidence));
    expect(fs.readdirSync(path.join(dir, 'quarantine'))).toHaveLength(2);
  });

  it.each([
    { run: null },
    { run: 1 },
    { run: [] },
    { run: { worktree: null } },
  ])('null-safe malformed run $run is strict, yet terminal-isolatable', ({ run }) => {
    const state = malformed();
    (state.batches[0] as unknown as Record<string, unknown>).member_runs = [run];
    expect(() => validateState(state)).toThrow(/batches\[0\].*member_runs\[0\]/);
    const { store } = write(state);
    expect(store.load().batches[0].member_runs).toEqual([]);
  });

  it('isolates other malformed terminal fields without retaining executable metadata', () => {
    const state = malformed();
    state.batches[0].member_runs = [];
    state.batches[0].executing_member = -1;
    const { store } = write(state);
    expect(store.load().batches[0].blocked_reason).toContain('executing_member');
  });

  it.each([
    'executing',
    'blocked',
    'dissolving',
    'unknown',
  ] as const)('refuses %s corruption with record-local diagnostics and unchanged bytes', (status) => {
    const { store, raw } = write(malformed(status as BatchStatus));
    expect(() => store.load()).toThrow(/batches\[0\].*unsafe-id/);
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    expect(fs.existsSync(path.join(dir, 'quarantine'))).toBe(false);
    try {
      store.load();
    } catch (err) {
      expect((err as Error).message).toContain(store.statePath);
      expect((err as Error).message).toContain('repair only');
      expect((err as Error).message).not.toMatch(/Rename or remove/);
    }
  });

  it.each([
    'entry',
    'parked',
    'slot',
    'member-slot',
    'duplicate',
    'missing-id',
    'invalid-entry',
    'invalid-slot',
    'global',
    'mixed-active',
    'schema',
    'newer-schema',
  ])('refuses recovery around %s corruption/ownership', (kind) => {
    const state = malformed();
    if (['entry', 'parked', 'invalid-entry'].includes(kind)) {
      state.entries = enqueueEntries(createEmptyState(), [{ issue: 901 }], NOW).entries;
      Object.assign(state.entries[0], {
        batch: '../unsafe-id',
        status: kind === 'parked' ? 'handed-back' : kind === 'invalid-entry' ? 'invalid' : 'queued',
      });
    }
    if (['slot', 'member-slot', 'invalid-slot'].includes(kind)) {
      state.slots = assignToIdleSlot(
        createEmptyState(),
        kind === 'member-slot' ? 'batch:../unsafe-id#901' : 'batch:../unsafe-id',
        null,
        NOW
      ).state.slots;
      if (kind === 'invalid-slot') state.slots[0].id = -1;
    }
    if (kind === 'duplicate') state.batches.push({ ...state.batches[0] });
    if (kind === 'missing-id') state.batches[0].id = '';
    if (kind === 'mixed-active')
      state.batches.push({ ...state.batches[0], id: 'active', status: 'executing' });
    if (kind === 'global') state.next_slot_id = -1;
    if (kind === 'schema') state.schema_version = '0.0.1' as typeof SCHEMA_VERSION;
    if (kind === 'newer-schema') state.schema_version = '99.0.0' as typeof SCHEMA_VERSION;
    const { store, raw } = write(state);
    expect(() => store.load()).toThrow(kind === 'newer-schema' ? /newer|upgrade|npm i/ : /./);
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    expect(fs.existsSync(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('load within withLock recovers once and preserves a healthy mutation', () => {
    const { store } = write(malformed());
    store.withLock((state) => ({
      state: enqueueEntries(state, [{ issue: 1000 }], NOW),
      result: null,
    }));
    expect(store.load().entries[0].issue).toBe(1000);
  });

  it.each([
    'write',
    'file-fsync',
    'directory-fsync',
    'publish-state',
  ])('refuses %s failure, retains original and recovers on retry', (fault) => {
    const { store, raw, evidence } = write(malformed());
    const originalWrite = fs.writeFileSync;
    const originalSync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    if (fault === 'write')
      vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...args) => {
        if (typeof target === 'number') throw new Error('injected evidence write failure');
        return originalWrite(target, ...args);
      });
    if (fault === 'file-fsync' || fault === 'directory-fsync') {
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory() === (fault === 'directory-fsync'))
          throw new Error('injected fsync failure');
        return originalSync(fd);
      });
    }
    if (fault === 'publish-state')
      vi.spyOn(fs, 'renameSync').mockImplementation((old, next) => {
        if (next === store.statePath) throw new Error('injected publish failure');
        return originalRename(old, next);
      });
    expect(() => store.load()).toThrow(/quarantine refused/);
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    vi.restoreAllMocks();
    // Retained complete evidence or temp prefixes are safe on restart.
    expect(new SchedStore(dir).load().batches[0].member_runs).toEqual([]);
    expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
  });

  it('refuses mismatched existing evidence rather than overwriting it', () => {
    const { store, raw, evidence } = write(malformed());
    fs.mkdirSync(path.dirname(evidence));
    fs.writeFileSync(evidence, 'wrong');
    expect(() => store.load()).toThrow(/verification failed/);
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    expect(fs.readFileSync(evidence, 'utf8')).toBe('wrong');
  });

  it('two real processes serialize recovery and healthy updates', async () => {
    const { store, evidence, raw } = write(malformed());
    const module = path.resolve('dist/index.js');
    const run = (issue: number) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            `const {SchedStore,enqueueEntries}=require(${JSON.stringify(module)});new SchedStore(${JSON.stringify(dir)}).withLock(s=>({state:enqueueEntries(s,[{issue:${issue}}],new Date()),result:null}));`,
          ],
          { stdio: 'pipe' }
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    await Promise.all([run(1000), run(1001)]);
    expect(
      store
        .load()
        .entries.map((entry) => entry.issue)
        .sort()
    ).toEqual([1000, 1001]);
    expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
    expect(fs.readdirSync(path.dirname(evidence))).toHaveLength(2);
  });

  it('real process death after evidence publication leaves a recoverable prefix', () => {
    const { store, evidence, raw } = write(malformed());
    const module = path.resolve('dist/index.js');
    const child = spawnSync(process.execPath, [
      '-e',
      `const fs=require('node:fs'); const original=fs.renameSync; fs.renameSync=(a,b)=>{if(b===${JSON.stringify(store.statePath)}) process.kill(process.pid,'SIGKILL'); return original(a,b)};require(${JSON.stringify(module)}).SchedStore.prototype.load.call(new (require(${JSON.stringify(module)}).SchedStore)(${JSON.stringify(dir)}));`,
    ]);
    expect(child.signal).toBe('SIGKILL');
    expect(fs.readFileSync(store.statePath, 'utf8')).toBe(raw);
    expect(fs.readFileSync(evidence, 'utf8')).toBe(raw);
    expect(store.load().batches[0].member_runs).toEqual([]);
    expect(fs.readdirSync(path.dirname(evidence))).toHaveLength(2);
  });
});
