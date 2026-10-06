import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger } from '../budget';
import type { BudgetEstimate, BudgetRate } from '../budget-types';
import { Journal, JournalError } from '../journal';
import { ReceiptNonceStore } from '../receipt/nonces';
import { compiledFixture } from './compiled-fixture';
import { readJournal as audit, budgetFixture, crashProcess as killed } from './recovery-fixture';

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-recovery-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function token(pid = process.pid): string {
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return `${boot}:${
    stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19]
  }`;
}
function owner(pid = 2147483647, startToken = token()) {
  return {
    pid,
    startToken,
    createdAt: '2000-01-01T00:00:00.000Z',
    id: randomUUID(),
    pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
  };
}
const rate: BudgetRate = {
  resource: 'model',
  currency: 'USD',
  unit: 'token',
  price: 1,
  units: 1,
  source: 'fixture',
  fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: '2026-10-05T00:00:00Z' },
};
const estimate: BudgetEstimate = {
  money: { currency: 'USD', minor: 10 },
  tokens: 1,
  timeMs: 1,
  rates: [rate],
};
function budget(dir: string): BudgetLedger {
  return budgetFixture(dir, rate);
}
const row = { nonce: 'n', operationKey: 'op', receiptDigest: 'a'.repeat(64), attempt: 1 };
function nonces(dir: string): ReceiptNonceStore {
  const store = new ReceiptNonceStore(dir);
  store.initialize();
  return store;
}

describe('crash-safe final-tail recovery', () => {
  it.each([
    'quarantine',
    'marker',
  ])('survives real SIGKILL immediately after %s publication', async (stage) => {
    const dir = directory();
    const module = compiledFixture(dir, 'journal');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{}\n{"partial":', { mode: 0o600 });
    await killed(
      `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(${JSON.stringify(stage)}==='quarantine'?to.includes('.quarantine-'):to.endsWith('.recovery'))process.kill(process.pid,'SIGKILL');};const {Journal}=require(${JSON.stringify(module)});new Journal(${JSON.stringify(dir)});`
    );
    const events = audit(dir);
    expect(events).toHaveLength(2);
    expect(audit(dir)).toEqual(events);
    for (const name of fs.readdirSync(dir).filter((value) => value.includes('.quarantine-')))
      expect(fs.statSync(path.join(dir, name)).nlink).toBe(1);
  });
  it.each([
    Buffer.from('{"partial":'),
    Buffer.from([0x7b, 0x22, 0xe2, 0x82]),
  ])('quarantines exact incomplete final bytes and records recovery once %#', (tail) => {
    const dir = directory();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('{"value":1}\n'), tail]), { mode: 0o600 });
    const events = audit(dir);
    expect(events[0]).toEqual({ value: 1 });
    expect(events[1]).toMatchObject({ v: 1, type: 'journal_tail_recovered', bytes: tail.length });
    const quarantine = fs.readdirSync(dir).filter((name) => name.includes('.quarantine-'));
    expect(quarantine).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantine[0]))).toEqual(tail);
    expect(fs.statSync(path.join(dir, quarantine[0])).mode & 0o777).toBe(0o600);
    const before = fs.readFileSync(file);
    expect(audit(dir)).toEqual(events);
    expect(audit(dir)).toEqual(events);
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it.each([
    '{bad}\n{}\n{',
    '{}\n{bad}\n',
    '{}\n{}',
    '\n{',
    '\ufffd\n{',
  ])('rejects middle/complete corruption without quarantine or journal changes: %s', (text) => {
    const dir = directory();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, text, { mode: 0o600 });
    expect(() => new Journal(dir)).toThrow(JournalError);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(fs.readdirSync(dir)).toEqual(['events.jsonl']);
  });
  it.each([
    'quarantine-publish',
    'marker-publish',
    'truncate',
    'event-write',
    'event-flush',
    'marker-remove',
  ])('resumes idempotently after interrupted recovery at %s', (stage) => {
    const dir = directory();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, '{}\n{"partial":', { mode: 0o600 });
    const rename = fs.renameSync;
    const truncate = fs.ftruncateSync;
    const write = fs.writeSync;
    const sync = fs.fsyncSync;
    const unlink = fs.unlinkSync;
    let written = false;
    let fired = false;
    const fail = () => {
      fired = true;
      throw new Error('simulated crash');
    };
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (
        (stage === 'quarantine-publish' && String(to).includes('.quarantine-')) ||
        (stage === 'marker-publish' && String(to).endsWith('.recovery'))
      )
        fail();
    });
    vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, length) => {
      truncate(fd, length);
      if (stage === 'truncate') fail();
    });
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number
    ) => {
      const journalWrite = fs.readlinkSync(`/proc/self/fd/${fd}`) === file;
      if (journalWrite) written = true;
      if (stage === 'event-write' && journalWrite) {
        write(fd, bytes, offset, 7);
        return fail();
      }
      return write(fd, bytes, offset, length);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      sync(fd);
      if (stage === 'event-flush' && written) fail();
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((name) => {
      if (stage === 'marker-remove' && String(name).endsWith('.recovery')) fail();
      unlink(name);
    });
    expect(() => new Journal(dir)).toThrow(JournalError);
    expect(fired).toBe(true);
    vi.restoreAllMocks();
    const events = audit(dir);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'journal_tail_recovered' });
    expect(audit(dir)).toEqual(events);
    expect(fs.existsSync(`${file}.recovery`)).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.quarantine-'))).toHaveLength(1);
  });
});

describe('ownership-proven store recovery', () => {
  it('crash after successful reservation with no lock still fences resume and observes zero new ledger writes', async () => {
    const dir = directory();
    const ledger = budget(dir);
    const module = compiledFixture(dir, 'budget');
    await killed(
      `const {BudgetLedger}=require(${JSON.stringify(module)});new BudgetLedger(${JSON.stringify(ledger.file)},'c').reserve('s',${JSON.stringify(estimate)});process.kill(process.pid,'SIGKILL');`
    );
    expect(fs.existsSync(`${ledger.file}.lock`)).toBe(false);
    const before = fs.readFileSync(ledger.file);
    const resumed = new BudgetLedger(ledger.file, 'c');
    const rename = vi.spyOn(fs, 'renameSync');
    expect(() => resumed.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    expect(rename.mock.calls.filter(([, to]) => to === ledger.file)).toHaveLength(0);
    expect(fs.readFileSync(ledger.file)).toEqual(before);
    const id = resumed.snapshot().reservations[0].id;
    resumed.settle(id, null);
    expect(() => resumed.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    resumed.release(id, 'provider confirmed never started');
    resumed.reserve('s', estimate);
  });
  it.each([
    'budget',
    'nonces',
  ])('survives real SIGKILL immediately after %s owner publication', async (kind) => {
    const dir = directory();
    const ledger = kind === 'budget' ? budget(dir) : undefined;
    if (!ledger) nonces(dir);
    const module = compiledFixture(dir, ledger ? 'budget' : 'receipt/nonces');
    const lock = ledger ? `${ledger.file}.lock` : path.join(dir, 'receipt.lock');
    const action = ledger
      ? `new M.BudgetLedger(${JSON.stringify(ledger.file)},'c').reserve('s',${JSON.stringify(estimate)})`
      : `new M.ReceiptNonceStore(${JSON.stringify(dir)}).consume(${JSON.stringify(row)})`;
    await killed(
      `const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to===${JSON.stringify(lock)})process.kill(process.pid,'SIGKILL');};const M=require(${JSON.stringify(module)});${action};`
    );
    expect(fs.statSync(lock).nlink).toBe(1);
    if (ledger) new BudgetLedger(ledger.file, 'c').reserve('s', estimate);
    else new ReceiptNonceStore(dir).consume(row);
    expect(
      audit(ledger ? `${ledger.file}.recovery-journal` : path.join(dir, 'lock-recovery'))
    ).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it.each([
    'ledger 1.json',
    '账本.json',
    'ledger\\name.json',
  ])('audits valid filesystem basename %s', (name) => {
    const dir = directory();
    const file = path.join(dir, name);
    const ledger = new BudgetLedger(file, 'c');
    ledger.initialize(['model'], [rate]);
    ledger.startSession({
      id: 's',
      ceiling: { currency: 'USD', minor: 100 },
      cleanupAllowance: 10,
      tokenLimit: 100,
      timeLimitMs: 100,
    });
    fs.writeFileSync(`${file}.lock`, JSON.stringify(owner()), { mode: 0o600 });
    ledger.reserve('s', estimate);
    expect(audit(`${file}.recovery-journal`)).toHaveLength(1);
  });
  it('missing or empty established recovery history never clears pending holds', () => {
    const dir = directory();
    const ledger = budget(dir);
    const held = ledger.reserve('s', estimate);
    fs.writeFileSync(`${ledger.file}.lock`, JSON.stringify(owner()), { mode: 0o600 });
    expect(() => ledger.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    const recovery = path.join(`${ledger.file}.recovery-journal`, 'events.jsonl');
    fs.unlinkSync(recovery);
    expect(() => ledger.reserve('s', estimate)).toThrow();
    expect(fs.existsSync(recovery)).toBe(false);
    fs.writeFileSync(recovery, '', { mode: 0o600 });
    expect(() => new BudgetLedger(ledger.file, 'c').reserve('s', estimate)).toThrow();
    expect(ledger.snapshot().reservations[0].id).toBe(held.id);
    fs.rmSync(`${ledger.file}.recovery-journal`, { recursive: true });
    expect(() => new BudgetLedger(ledger.file, 'c').reserve('s', estimate)).toThrow(
      'Reconcile recovered reservations'
    );
    expect(() => ledger.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
  });
  it('replays a durable reclaim audit after death before lock unlink without duplication', () => {
    const dir = directory();
    const store = nonces(dir);
    const lock = path.join(dir, 'receipt.lock');
    fs.writeFileSync(lock, JSON.stringify(owner()), { mode: 0o600 });
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (file === lock) throw new Error('crash after audit');
      unlink(file);
    });
    expect(() => store.consume(row)).toThrow('crash after audit');
    vi.restoreAllMocks();
    new ReceiptNonceStore(dir).consume(row);
    expect(audit(path.join(dir, 'lock-recovery'))).toHaveLength(1);
    expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
  });
  it('real SIGKILL while nonce lock is held releases kernel guard, preserves nonce and reclaims owner', async () => {
    const dir = directory();
    nonces(dir);
    const module = compiledFixture(dir, 'receipt/nonces');
    const script = `const fs=require('node:fs');const remove=fs.rmSync;fs.rmSync=(file,...args)=>{if(String(file).endsWith('/receipt.lock')){process.send('held');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}return remove(file,...args);};const {ReceiptNonceStore}=require(${JSON.stringify(module)});new ReceiptNonceStore(${JSON.stringify(dir)}).consume(${JSON.stringify(row)});`;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (bytes) => {
      stderr += bytes;
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child did not reach held lock')), 4000);
        child.once('message', () => {
          clearTimeout(timer);
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`child exited before held lock: ${stderr}`));
        });
      });
      expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('store_locked');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
    expect(audit(path.join(dir, 'lock-recovery'))).toHaveLength(1);
  });
  it('reclaims a dead budget owner once and fences old reservations across reopen', () => {
    const dir = directory();
    const ledger = budget(dir);
    const held = ledger.reserve('s', estimate);
    const dead = owner();
    fs.writeFileSync(`${ledger.file}.lock`, JSON.stringify(dead), { mode: 0o600 });
    expect(() => ledger.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    expect(audit(`${ledger.file}.recovery-journal`)).toEqual([
      expect.objectContaining({
        type: 'lock_reclaimed',
        owner: dead,
        pendingReservations: [held.id],
      }),
    ]);
    const reopened = new BudgetLedger(ledger.file, 'c');
    expect(() => reopened.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    reopened.settle(held.id, null);
    expect(() => reopened.reserve('s', estimate)).toThrow('Reconcile recovered reservations');
    reopened.reserve('s', estimate, 'teardown');
    reopened.release(held.id, 'provider proves never started');
    reopened.reserve('s', estimate);
    expect(audit(`${ledger.file}.recovery-journal`)).toHaveLength(1);
  });
  it.each([
    'dead',
    'reused',
  ])('reclaims %s nonce owner and replays history before authorization', (kind) => {
    const dir = directory();
    const store = nonces(dir);
    store.consume(row);
    const dead = kind === 'dead' ? owner() : owner(process.pid, `${token().split(':')[0]}:0`);
    fs.writeFileSync(path.join(dir, 'receipt.lock'), JSON.stringify(dead), { mode: 0o600 });
    expect(() => store.consume(row)).toThrow('replayed_nonce');
    expect(audit(path.join(dir, 'lock-recovery'))).toHaveLength(1);
    expect(() => new ReceiptNonceStore(dir).consume(row)).toThrow('replayed_nonce');
    expect(audit(path.join(dir, 'lock-recovery'))).toHaveLength(1);
  });
  it('recovers nonce torn tail without forgetting consumed attempts', () => {
    const dir = directory();
    const store = nonces(dir);
    store.consume(row);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"nonce":');
    expect(() => store.consume(row)).toThrow('replayed_nonce');
    expect(() => store.consume({ ...row, nonce: 'other' })).toThrow('replayed_operation');
    store.consume({ ...row, nonce: 'retry', attempt: 2 });
  });
  it.each(['budget', 'nonces'])('never age-reclaims a live %s owner', (kind) => {
    const dir = directory();
    const ledger = kind === 'budget' ? budget(dir) : undefined;
    const store = kind === 'nonces' ? nonces(dir) : undefined;
    const file = ledger ? `${ledger.file}.lock` : path.join(dir, 'receipt.lock');
    const live = JSON.stringify(owner(process.pid));
    fs.writeFileSync(file, live, { mode: 0o600 });
    const journalWrites = vi.spyOn(Journal.prototype, 'append');
    const ledgerWrites = vi.spyOn(fs, 'renameSync');
    expect(() => (ledger ? ledger.reserve('s', estimate) : store?.consume(row))).toThrow();
    expect(journalWrites).not.toHaveBeenCalled();
    expect(ledgerWrites).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(live);
    expect(
      fs.existsSync(ledger ? `${ledger.file}.recovery-journal` : path.join(dir, 'lock-recovery'))
    ).toBe(false);
  });
  it.each(['malformed', 'symlink', 'hardlink'])('fails closed on %s owner metadata', (kind) => {
    const dir = directory();
    const store = nonces(dir);
    const target = path.join(dir, 'target');
    const lock = path.join(dir, 'receipt.lock');
    fs.writeFileSync(target, JSON.stringify(owner()), { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(target, lock);
    else if (kind === 'hardlink') fs.linkSync(target, lock);
    else fs.writeFileSync(lock, 'unknown owner', { mode: 0o600 });
    expect(() => store.consume(row)).toThrow();
    expect(fs.existsSync(lock)).toBe(true);
    expect(audit(dir)).toHaveLength(1);
  });
  it('journal failure leaves the dead lock and denies admission', () => {
    const dir = directory();
    const store = nonces(dir);
    const lock = path.join(dir, 'receipt.lock');
    const text = JSON.stringify(owner());
    fs.writeFileSync(lock, text, { mode: 0o600 });
    vi.spyOn(Journal.prototype, 'append').mockImplementationOnce(() => {
      throw new JournalError();
    });
    expect(() => store.consume(row)).toThrow();
    expect(fs.readFileSync(lock, 'utf8')).toBe(text);
    expect(audit(dir)).toHaveLength(1);
  });
  it('racing real budget reclaimers retain one audit and never overcommit', async () => {
    const dir = directory();
    const ledger = budget(dir);
    fs.writeFileSync(`${ledger.file}.lock`, JSON.stringify(owner()), { mode: 0o600 });
    const module = compiledFixture(dir, 'budget');
    const script = `const {BudgetLedger}=require(${JSON.stringify(module)});try {new BudgetLedger(${JSON.stringify(ledger.file)},'c',5000).reserve('s',${JSON.stringify({ ...estimate, money: { currency: 'USD', minor: 60 } })});process.exitCode=0;}catch(e){process.exitCode=['ceiling_exceeded','persistence_uncertain'].includes(e.code)?2:3;}`;
    const codes = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
            child.once('error', reject);
            child.once('exit', resolve);
          })
      )
    );
    expect(codes.filter((code) => code === 0)).toHaveLength(1);
    expect(codes.filter((code) => code === 2)).toHaveLength(7);
    expect(ledger.snapshot().reservations).toHaveLength(1);
    expect(audit(`${ledger.file}.recovery-journal`)).toHaveLength(1);
  });
});
