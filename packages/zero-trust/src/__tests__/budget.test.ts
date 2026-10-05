import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetLedger, budgetTotals, estimateBudget, requireBudgetRates } from '../budget';
import {
  BudgetError,
  type BudgetEstimate,
  type BudgetRate,
  type BudgetSession,
} from '../budget-types';

const price = (resource = 'model', unit: BudgetRate['unit'] = 'token', cost = 1): BudgetRate => ({
  resource,
  currency: 'USD',
  unit,
  price: cost,
  units: 1,
  source: 'provider-price-v1',
  fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: '2026-10-05T00:00:00Z' },
});
const session = (id = 'initial', ceiling = 100): BudgetSession => ({
  id,
  ceiling: { currency: 'USD', minor: ceiling },
  cleanupAllowance: 10,
  tokenLimit: 1000,
  timeLimitMs: 10000,
});
const estimate = (cost = 40): BudgetEstimate => ({
  money: { currency: 'USD', minor: cost },
  tokens: 10,
  timeMs: 100,
  rates: [price()],
});
function code(fn: () => unknown, expected: string): void {
  try {
    fn();
    throw new Error('Expected admission rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect((error as BudgetError).code).toBe(expected);
  }
}

describe('durable budget admission (operator, S1; scenarios 8/9/19/20)', () => {
  let dir: string;
  let file: string;
  let ledger: BudgetLedger;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-budget-'));
    file = path.join(dir, 'ledger.json');
    ledger = new BudgetLedger(file, 'contribution-1', 50);
    ledger.initialize(['model'], [price()]);
    ledger.startSession(session());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects missing startup pricing without creating a ledger', () => {
    const missing = new BudgetLedger(path.join(dir, 'missing.json'), 'c');
    code(() => missing.initialize(['free-model'], []), 'missing_rate');
    expect(fs.existsSync(missing.file)).toBe(false);
    code(() => requireBudgetRates([price()], ['vm']), 'missing_rate');
  });

  it.each([
    NaN,
    Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects noninteger or unbounded money %s without mutation', (minor) => {
    const before = fs.readFileSync(file, 'utf8');
    code(
      () => ledger.reserve('initial', { ...estimate(), money: { currency: 'USD', minor } }),
      'invalid_budget'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('races two asynchronous independent reservers without overcommitting', async () => {
    const second = new BudgetLedger(file, 'contribution-1');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => ledger.reserve('initial', estimate(60))),
      Promise.resolve().then(() => second.reserve('initial', estimate(60))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(budgetTotals(ledger.snapshot(), 'initial').reserved).toBe(60);
  });

  it('keeps the cleanup allowance unavailable to work but allows teardown', () => {
    ledger.reserve('initial', estimate(90));
    code(() => ledger.reserve('initial', estimate(1)), 'ceiling_exceeded');
    ledger.reserve(
      'initial',
      { ...estimate(10), rates: [price('cleanup', 'vm_increment')] },
      'teardown'
    );
    expect(budgetTotals(ledger.snapshot(), 'initial').reserved).toBe(100);
    code(() => ledger.reserve('initial', estimate(1), 'teardown'), 'ceiling_exceeded');
  });

  it('retains unknown reservations on reload and explicit reconciliation releases only that row', () => {
    const r = ledger.reserve('initial', estimate(70));
    ledger.settle(r.id, null);
    const resumed = new BudgetLedger(file, 'contribution-1');
    expect(resumed.snapshot().reservations[0].status).toBe('reserved');
    code(() => resumed.reserve('initial', estimate(21)), 'ceiling_exceeded');
    code(() => resumed.release(r.id, ''), 'invalid_budget');
    resumed.release(r.id, 'provider confirmed never started');
    resumed.reserve('initial', estimate(90));
    expect(resumed.snapshot().reservations).toHaveLength(2);
    code(() => resumed.settle(r.id, null), 'already_reconciled');
  });

  it('preserves estimated and reported charges separately and blocks on overruns', () => {
    const r = ledger.reserve('initial', estimate(40));
    ledger.settle(r.id, {
      money: { currency: 'USD', minor: 95 },
      tokens: 20,
      timeMs: 200,
      source: 'provider invoice',
    });
    const row = ledger.snapshot().reservations[0];
    expect(row.estimate.money.minor).toBe(40);
    expect(row.observed?.money.minor).toBe(95);
    expect(budgetTotals(ledger.snapshot(), 'initial').spent).toBe(95);
    code(() => ledger.reserve('initial', estimate(0)), 'ceiling_exceeded');
    ledger.reserve(
      'initial',
      { ...estimate(5), rates: [price('cleanup', 'vm_increment')] },
      'teardown'
    );
    code(() => ledger.release(r.id, 'not billed'), 'already_reconciled');
  });

  it('uses conservative estimates when provider reports a smaller charge', () => {
    const r = ledger.reserve('initial', estimate(80));
    ledger.settle(r.id, {
      money: { currency: 'USD', minor: 1 },
      tokens: 1,
      timeMs: 1,
      source: 'usage',
    });
    expect(budgetTotals(ledger.snapshot(), 'initial')).toEqual({
      spent: 80,
      reserved: 0,
      tokens: 10,
      timeMs: 100,
    });
    code(() => ledger.reserve('initial', estimate(11)), 'ceiling_exceeded');
  });

  it('allocates independent revision ceilings without resetting history or old holds', () => {
    const settled = ledger.reserve('initial', estimate(20));
    ledger.settle(settled.id, {
      money: { currency: 'USD', minor: 20 },
      tokens: 10,
      timeMs: 100,
      source: 'invoice',
    });
    ledger.reserve('initial', estimate(70));
    ledger.startSession(session('revision', 50));
    ledger.reserve('revision', estimate(40));
    code(() => ledger.reserve('revision', estimate(1)), 'ceiling_exceeded');
    code(() => ledger.startSession(session('initial', 1000)), 'invalid_budget');
    const state = ledger.snapshot();
    expect(state.sessions).toHaveLength(2);
    expect(budgetTotals(state, 'initial').spent).toBe(20);
    expect(budgetTotals(state, 'initial').reserved).toBe(70);
    expect(budgetTotals(state, 'revision').reserved).toBe(40);
  });

  it.each([
    'tokens',
    'timeMs',
  ] as const)('enforces cumulative %s on zero-cost models', (dimension) => {
    ledger.startSession({ ...session('free'), tokenLimit: 15, timeLimitMs: 150 });
    const e = { ...estimate(0), rates: [price('free', 'token', 0)] };
    ledger.reserve('free', e);
    const next = { ...e, tokens: 1, timeMs: 1, [dimension]: dimension === 'tokens' ? 6 : 51 };
    code(() => ledger.reserve('free', next), 'limit_exceeded');
    code(() => ledger.reserve('free', { ...e, [dimension]: 0 }), 'invalid_budget');
  });

  it('opens read-only across model changes and pins old rate evidence', () => {
    ledger.reserve('initial', estimate());
    const before = fs.readFileSync(file, 'utf8');
    const newModel = price('cheaper', 'token', 0);
    requireBudgetRates([newModel], ['cheaper']);
    const resumed = new BudgetLedger(file, 'contribution-1');
    expect(resumed.snapshot().reservations[0].estimate.rates[0]).toEqual(price());
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('accepts a finite zero-money session for free models while enforcing its resource limits', () => {
    ledger.startSession({
      ...session('zero', 0),
      cleanupAllowance: 0,
      tokenLimit: 10,
      timeLimitMs: 100,
    });
    ledger.reserve('zero', { ...estimate(0), rates: [price('local', 'token', 0)] });
    code(
      () => ledger.reserve('zero', { ...estimate(0), rates: [price('local', 'token', 0)] }),
      'limit_exceeded'
    );
    code(() => ledger.reserve('zero', estimate(1)), 'ceiling_exceeded');
  });

  it('fails closed on missing, corrupt, mismatched, or structurally forged persisted state', () => {
    code(() => new BudgetLedger(file, 'other').snapshot(), 'identity_mismatch');
    const state = ledger.snapshot();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...state,
        reservations: [{ ...ledger.reserve('initial', estimate()), purpose: 'anything' }],
      })
    );
    code(() => ledger.reserve('initial', estimate()), 'corrupt_ledger');
    fs.writeFileSync(file, '{');
    code(() => ledger.snapshot(), 'corrupt_ledger');
    fs.unlinkSync(file);
    code(() => ledger.reserve('initial', estimate()), 'missing_ledger');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not steal a held or orphaned lock, and ignores leftover partial temp writes', () => {
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(`${file}.lock`, 'unknown owner');
    fs.writeFileSync(`${file}.tmp-crashed`, '{partial');
    code(() => ledger.reserve('initial', estimate()), 'lock_timeout');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    fs.unlinkSync(`${file}.lock`); // operator proved writer absent in this isolated fixture
    ledger.reserve('initial', estimate(90));
    expect(ledger.snapshot().reservations).toHaveLength(1);
  });

  it('rejects currency mismatch, unpriced and forged zero-bound reservations', () => {
    code(() => ledger.reserve('initial', { ...estimate(), rates: [] }), 'missing_rate');
    code(
      () => ledger.reserve('initial', { ...estimate(), money: { currency: 'EUR', minor: 1 } }),
      'invalid_budget'
    );
    const r = ledger.reserve('initial', estimate());
    code(
      () =>
        ledger.settle(r.id, {
          money: { currency: 'EUR', minor: 1 },
          tokens: 1,
          timeMs: 1,
          source: 'invoice',
        }),
      'invalid_budget'
    );
    expect(ledger.snapshot().reservations[0].status).toBe('reserved');
    code(() => ledger.reserve('unknown', estimate()), 'unknown_session');
    code(() => ledger.release('unknown', 'none'), 'unknown_reservation');
  });

  function compiledModule(): string {
    // Compile the current source, never a possibly stale pool dist/. No build prerequisite.
    const sourceDir = path.resolve(__dirname, '..');
    for (const name of ['budget', 'budget-types']) {
      const source = fs.readFileSync(path.join(sourceDir, `${name}.ts`), 'utf8');
      fs.writeFileSync(
        path.join(dir, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText
      );
    }
    return path.join(dir, 'budget.js');
  }

  it('races real processes sharing one persisted file', async () => {
    const module = compiledModule();
    const script = `const {BudgetLedger}=require(${JSON.stringify(module)}); try {new BudgetLedger(${JSON.stringify(file)},'contribution-1').reserve('initial',${JSON.stringify(estimate(60))});process.exitCode=0;}catch(e){process.exitCode=e.code==='ceiling_exceeded'?2:3;}`;
    const racers = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    );
    const exits = await Promise.all(
      racers.map(
        (child) =>
          new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
          })
      )
    );
    expect(exits.filter((c) => c === 0)).toHaveLength(1);
    expect(exits.filter((c) => c === 2)).toHaveLength(7);
    expect(budgetTotals(ledger.snapshot(), 'initial').reserved).toBe(60);
  });

  it.each([
    'before-rename',
    'after-rename',
  ] as const)('fails closed on fsync failure %s and recovers only committed state', (when) => {
    const original = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      calls += 1;
      if (calls === (when === 'before-rename' ? 1 : 2)) throw new Error('injected disk failure');
      original(fd);
    });
    expect(() => ledger.reserve('initial', estimate(90))).toThrow('injected disk failure');
    vi.restoreAllMocks();
    code(() => ledger.reserve('initial', estimate(1)), 'persistence_uncertain');
    const recovered = new BudgetLedger(file, 'contribution-1');
    expect(recovered.snapshot().reservations).toHaveLength(when === 'before-rename' ? 0 : 1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toHaveLength(0);
    if (when === 'after-rename')
      code(() => recovered.reserve('initial', estimate(1)), 'ceiling_exceeded');
    else recovered.reserve('initial', estimate(90));
  });

  it('normalizes directory aliases into one lock and refuses symlink ledger files', () => {
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias, 'dir');
    const second = new BudgetLedger(path.join(alias, 'ledger.json'), 'contribution-1', 20);
    expect(second.file).toBe(ledger.file);
    fs.writeFileSync(`${file}.lock`, 'held');
    code(() => second.reserve('initial', estimate()), 'lock_timeout');
    fs.unlinkSync(`${file}.lock`);
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(file, link);
    expect(() => new BudgetLedger(link, 'contribution-1').snapshot()).toThrow();
    expect(ledger.snapshot().reservations).toHaveLength(0);
  });

  it('survives SIGKILL between durable reserve and settlement without freeing the hold', async () => {
    const module = compiledModule();
    const script = `const {BudgetLedger}=require(${JSON.stringify(module)});const r=new BudgetLedger(${JSON.stringify(file)},'contribution-1').reserve('initial',${JSON.stringify(estimate(90))});process.send(r.id);setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const id = await new Promise<string>((resolve, reject) => {
      child.once('message', (message) => resolve(String(message)));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Child exited before reservation')));
    });
    child.kill('SIGKILL');
    await exited;
    const resumed = new BudgetLedger(file, 'contribution-1');
    expect(resumed.snapshot().reservations[0].id).toBe(id);
    code(() => resumed.reserve('initial', estimate(1)), 'ceiling_exceeded');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    resumed.settle(id, {
      money: { currency: 'USD', minor: 90 },
      tokens: 10,
      timeMs: 100,
      source: 'reconciled invoice',
    });
    expect(budgetTotals(resumed.snapshot(), 'initial').spent).toBe(90);
  });

  it.each([
    'before',
    'after',
  ] as const)('recovers a real writer killed %s atomic rename without stealing its lock', async (when) => {
    const module = compiledModule();
    const script = `const fs=require('node:fs');const {BudgetLedger}=require(${JSON.stringify(module)});const rename=fs.renameSync;fs.renameSync=(...args)=>{if(${JSON.stringify(when)}==='after')rename(...args);process.send('at-rename');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);};new BudgetLedger(${JSON.stringify(file)},'contribution-1').reserve('initial',${JSON.stringify(estimate(90))});`;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Writer exited before rename')));
      });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const resumed = new BudgetLedger(file, 'contribution-1', 20);
    expect(resumed.snapshot().reservations).toHaveLength(when === 'before' ? 0 : 1);
    code(() => resumed.reserve('initial', estimate(1)), 'lock_timeout');
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    // Fixture supervisor has joined the killed writer; reconciliation is now explicit.
    fs.unlinkSync(`${file}.lock`);
    if (when === 'after') code(() => resumed.reserve('initial', estimate(1)), 'ceiling_exceeded');
    else resumed.reserve('initial', estimate(90));
  });
});

describe('maximum estimates', () => {
  it('pins a single rate snapshot even when a provider object exposes changing getters', () => {
    let reads = 0;
    const r = {
      ...price(),
      get price() {
        reads += 1;
        return reads === 1 ? 2 : 0;
      },
    };
    const e = estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'model',
          maxInputTokens: 0,
          maxOutputTokens: 3,
          retries: 0,
          streamingTimeMs: 1,
        },
      },
      [r]
    );
    expect(reads).toBe(1);
    expect(e.money.minor).toBe(6);
    expect(e.rates[0].price).toBe(2);
  });
  it('accounts for retries, max output, streaming, VM minimums, retained storage and FX rounding', () => {
    const model = {
      ...price(),
      currency: 'EUR',
      price: 3,
      units: 2,
      fx: { currency: 'USD', numerator: 3, denominator: 2, timestamp: '2026-10-05T00:00:00Z' },
    };
    const e = estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'model',
          maxInputTokens: 2,
          maxOutputTokens: 3,
          retries: 1,
          streamingTimeMs: 10,
          streamingResource: 'stream',
        },
        vm: { resource: 'vm', durationMs: 61, minimumBillingIncrementMs: 60 },
        storage: { resource: 'disk', bytes: 2, retentionMs: 3 },
      },
      [
        model,
        price('stream', 'millisecond', 1),
        price('vm', 'vm_increment', 4),
        price('disk', 'byte_millisecond', 1),
      ]
    );
    expect(e.money.minor).toBe(23 + 20 + 8 + 6);
    expect(e.tokens).toBe(10);
    expect(e.timeMs).toBe(140);
    expect(e.rates).toHaveLength(4);
  });

  it('rounds sub-minor prices upwards and never loses fractions to floating point', () => {
    const r = { ...price(), units: 1000000 };
    const e = estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'model',
          maxInputTokens: 0,
          maxOutputTokens: 1,
          retries: 0,
          streamingTimeMs: 1,
        },
      },
      [r]
    );
    expect(e.money.minor).toBe(1);
  });

  it('rejects overflow, wrong units, missing FX and absent model bounds', () => {
    const request = {
      currency: 'USD',
      model: {
        resource: 'model',
        maxInputTokens: 0,
        maxOutputTokens: 1,
        retries: 0,
        streamingTimeMs: 1,
      },
    };
    code(
      () =>
        estimateBudget(
          { ...request, model: { ...request.model, retries: Number.MAX_SAFE_INTEGER } },
          [price()]
        ),
      'invalid_budget'
    );
    code(() => estimateBudget(request, [price('model', 'vm_increment')]), 'invalid_budget');
    code(
      () => estimateBudget(request, [{ ...price(), fx: { ...price().fx, numerator: 0 } }]),
      'invalid_budget'
    );
    code(
      () =>
        estimateBudget({ ...request, model: { ...request.model, streamingTimeMs: 0 } }, [
          price('model', 'token', 0),
        ]),
      'invalid_budget'
    );
    code(() => estimateBudget({ currency: 'USD' }, []), 'missing_rate');
  });
});
