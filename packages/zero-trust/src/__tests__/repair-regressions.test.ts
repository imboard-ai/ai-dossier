import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../budget';
import type { BudgetEstimate, BudgetRate } from '../budget-types';
import { Journal } from '../journal';
import { ReceiptNonceStore } from '../receipt/nonces';
import { compiledFixture } from './compiled-fixture';

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-repair-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const rate: BudgetRate = {
  resource: 'model',
  currency: 'USD',
  unit: 'token',
  price: 1,
  units: 1,
  source: 'fixture',
  fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: '2026-10-06T00:00:00Z' },
};
const estimate: BudgetEstimate = {
  money: { currency: 'USD', minor: 10 },
  tokens: 1,
  timeMs: 1,
  rates: [rate],
};
const row = { nonce: 'n', operationKey: 'op', receiptDigest: 'a'.repeat(64), attempt: 1 };
function budget(dir: string): BudgetLedger {
  const ledger = new BudgetLedger(path.join(dir, 'ledger.json'), 'c', 100);
  ledger.initialize(['model'], [rate]);
  ledger.startSession({
    id: 's',
    ceiling: { currency: 'USD', minor: 100 },
    cleanupAllowance: 10,
    tokenLimit: 100,
    timeLimitMs: 100,
  });
  return ledger;
}
async function crash(script: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (bytes) => {
    stderr += bytes;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('crash boundary not reached'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') resolve();
      else reject(new Error(`did not crash: ${stderr}`));
    });
  });
}
function events(dir: string): unknown[] {
  const journal = new Journal(dir);
  try {
    return journal.read();
  } finally {
    journal.close();
  }
}

describe('authorized second-cycle crash repairs', () => {
  it('pre-opened survivor fences a later lock-free crashed reservation with zero ledger writes', async () => {
    const dir = directory();
    const original = budget(dir);
    const survivor = new BudgetLedger(original.file, 'c', 100);
    const module = compiledFixture(dir, 'budget');
    await crash(
      `const {BudgetLedger}=require(${JSON.stringify(module)});new BudgetLedger(${JSON.stringify(original.file)},'c',100).reserve('s',${JSON.stringify(estimate)});process.kill(process.pid,'SIGKILL');`
    );
    expect(fs.existsSync(`${original.file}.lock`)).toBe(false);
    const before = fs.readFileSync(original.file);
    const writes = vi.spyOn(fs, 'renameSync');
    expect(() => survivor.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    expect(writes.mock.calls.filter(([, to]) => to === original.file)).toHaveLength(0);
    expect(fs.readFileSync(original.file)).toEqual(before);
    const id = survivor.snapshot().reservations[0].id;
    survivor.settle(id, null);
    expect(() => survivor.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    survivor.release(id, 'provider proved never started');
    survivor.reserve('s', estimate);
    survivor.reserve('s', estimate); // acknowledged local holds still support normal concurrency
  });
  it.each([
    'budget',
    'nonces',
  ])('cleanup fsync uncertainty fences current and fresh live %s handles', (kind) => {
    const dir = directory();
    const ledger = kind === 'budget' ? budget(dir) : undefined;
    const store = ledger ? undefined : new ReceiptNonceStore(dir);
    store?.initialize();
    const lock = ledger ? `${ledger.file}.lock` : path.join(dir, 'receipt.lock');
    const remove = fs.rmSync;
    const sync = fs.fsyncSync;
    let removed = false;
    let fired = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      remove(file, options);
      if (file === lock) removed = true;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (removed && !fired && fs.fstatSync(fd).isDirectory()) {
        fired = true;
        throw new Error('cleanup directory fsync failure');
      }
      sync(fd);
    });
    expect(() => (ledger ? ledger.reserve('s', estimate) : store?.consume(row))).toThrow();
    expect(fired).toBe(true);
    vi.restoreAllMocks();
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    const writes = vi.spyOn(fs, 'renameSync');
    const appends = vi.spyOn(Journal.prototype, 'append');
    expect(() =>
      ledger
        ? ledger.reserve('s', estimate)
        : store?.consume({ ...row, nonce: 'fresh', operationKey: 'fresh' })
    ).toThrow();
    expect(() =>
      ledger
        ? new BudgetLedger(ledger.file, 'c', 100).reserve('s', estimate)
        : new ReceiptNonceStore(dir).consume({ ...row, nonce: 'fresh', operationKey: 'fresh' })
    ).toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(appends).not.toHaveBeenCalled();
    if (ledger) expect(ledger.snapshot().reservations).toHaveLength(1);
    else expect(events(dir)).toContainEqual(row);
  });
  it.each([
    'budget',
    'nonces',
  ])('real SIGKILL during first %s audit directory creation resumes once', async (kind) => {
    const dir = directory();
    const ledger = kind === 'budget' ? budget(dir) : undefined;
    if (!ledger) new ReceiptNonceStore(dir).initialize();
    const module = compiledFixture(dir, ledger ? 'budget' : 'receipt/nonces');
    const lock = ledger ? `${ledger.file}.lock` : path.join(dir, 'receipt.lock');
    const audit = ledger ? `${ledger.file}.recovery-journal` : path.join(dir, 'lock-recovery');
    const action = ledger
      ? `new M.BudgetLedger(${JSON.stringify(ledger.file)},'c',100).reserve('s',${JSON.stringify(estimate)})`
      : `new M.ReceiptNonceStore(${JSON.stringify(dir)}).consume(${JSON.stringify(row)})`;
    await crash(
      `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b===${JSON.stringify(lock)})process.kill(process.pid,'SIGKILL');};const M=require(${JSON.stringify(module)});${action};`
    );
    const owner = fs.readFileSync(lock);
    await crash(
      `const fs=require('node:fs'),mkdir=fs.mkdirSync;fs.mkdirSync=(p,...a)=>{const result=mkdir(p,...a);if(String(p)===${JSON.stringify(audit)}||String(p).startsWith(${JSON.stringify(`${audit}.staging-`)}))process.kill(process.pid,'SIGKILL');return result;};const M=require(${JSON.stringify(module)});${action};`
    );
    expect(fs.readFileSync(lock)).toEqual(owner);
    if (ledger) new BudgetLedger(ledger.file, 'c', 100).reserve('s', estimate);
    else new ReceiptNonceStore(dir).consume(row);
    expect(events(audit)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
    if (!ledger) expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
    expect(events(audit)).toHaveLength(1);
  });
  it.each([
    'partial-header',
    'marker-published',
    'header-published',
  ])('nonce initialization resumes real SIGKILL at %s without resetting burns', async (stage) => {
    const dir = directory();
    const module = compiledFixture(dir, 'receipt/nonces');
    const file = path.join(dir, 'events.jsonl');
    const marker = path.join(dir, 'nonce-initializing');
    await crash(
      `const fs=require('node:fs'),stage=${JSON.stringify(stage)},file=${JSON.stringify(file)},marker=${JSON.stringify(marker)},write=fs.writeSync,writeFile=fs.writeFileSync,rename=fs.renameSync;const die=()=>process.kill(process.pid,'SIGKILL');const named=fd=>fs.readlinkSync('/proc/self/fd/'+fd);fs.writeSync=(fd,b,o,l,...a)=>{if(stage==='partial-header'&&named(fd)===file){write(fd,b,o,7);die();}return write(fd,b,o,l,...a);};fs.writeFileSync=(fd,b,...a)=>{if(stage==='partial-header'&&typeof fd==='number'&&named(fd).startsWith(file+'.tmp-')){write(fd,b,0,7);die();}return writeFile(fd,b,...a);};fs.renameSync=(a,b)=>{rename(a,b);if((stage==='marker-published'&&b===marker)||(stage==='header-published'&&b===file))die();};new (require(${JSON.stringify(module)}).ReceiptNonceStore)(${JSON.stringify(dir)}).initialize();`
    );
    const recovered = new ReceiptNonceStore(dir);
    recovered.consume(row);
    expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
    expect(() => recovered.consume({ ...row, nonce: 'other' })).toThrow('replayed_operation');
    expect(
      events(dir).filter((value) => (value as { type?: string }).type === 'receipt-nonces')
    ).toHaveLength(1);
    expect(
      events(dir).filter((value) => (value as { nonce?: string }).nonce === row.nonce)
    ).toHaveLength(1);
  });
  it('legacy torn first header recovers only its proven fixed-header prefix', () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"v":1,"ty', { mode: 0o600 });
    new ReceiptNonceStore(dir).consume(row);
    expect(events(dir)).toContainEqual(expect.objectContaining({ type: 'journal_tail_recovered' }));
    expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
  });
  it('unpersistable cleanup fence retains kernel exclusion until real process death', async () => {
    const dir = directory();
    const ledger = budget(dir);
    const module = compiledFixture(dir, 'budget');
    const lock = `${ledger.file}.lock`;
    const script = `const fs=require('node:fs'),remove=fs.rmSync,sync=fs.fsyncSync;let removed=false;fs.rmSync=(file,...args)=>{const result=remove(file,...args);if(file===${JSON.stringify(lock)})removed=true;return result;};fs.fsyncSync=(fd)=>{if(removed)throw new Error('persistent disk failure');return sync(fd);};try{new (require(${JSON.stringify(module)}).BudgetLedger)(${JSON.stringify(ledger.file)},'c').reserve('s',${JSON.stringify(estimate)});}catch(error){process.send(error.name);}setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const name = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cleanup fence not reached')), 10000);
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(String(value));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('writer exited before fence'));
        });
      });
      expect(name).toBe('StorePersistenceError');
      const writes = vi.spyOn(fs, 'renameSync');
      expect(() => new BudgetLedger(ledger.file, 'c', 50).reserve('s', estimate)).toThrow(
        'lock held'
      );
      expect(writes).not.toHaveBeenCalled();
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const resumed = new BudgetLedger(ledger.file, 'c', 100);
    expect(() => resumed.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    resumed.release(resumed.snapshot().reservations[0].id, 'provider confirmed no charge');
    resumed.reserve('s', estimate);
  });
  it('foreign PID namespace never proves owner death or writes recovery/admission', () => {
    const dir = directory();
    const store = new ReceiptNonceStore(dir);
    store.initialize();
    // Use the published shape, then replace only its namespace in an isolated fixture.
    const file = path.join(dir, 'receipt.lock');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const ticks = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: 2147483647,
        startToken: `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`,
        createdAt: '2000-01-01T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000000',
        pidNamespace: 'pid:[0]',
      }),
      { mode: 0o600 }
    );
    const before = fs.readFileSync(file);
    const appends = vi.spyOn(Journal.prototype, 'append');
    expect(() => store.consume(row)).toThrow('store_locked');
    expect(appends).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
