import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetLedger, effectiveBudgetSession } from '../budget';
import { ReasonCode, transitionRun } from '../state';
import { rig, TIME } from './__tests__/composition-fixture';
import { compositionHooks } from './__tests__/composition-hooks';
import { approveBudgetCeiling } from './budget-extension';
import { RunStore } from './run-store';
import { assembleStatus } from './status';

compositionHooks();
function paused() {
  const h = rig();
  const root = path.join(h.config.executionProfile.stateDir, 'runs');
  const store = RunStore.create(root, h.config, new Date(TIME));
  const file = path.join(store.storeDirectory('budget'), 'ledger.json');
  const ledger = new BudgetLedger(file, store.contributionId);
  ledger.initialize([], h.config.modelProfile.rates);
  const sessionId = store.budgetSessionId(1);
  ledger.startSession({
    id: sessionId,
    ceiling: { currency: 'USD', minor: 1000 },
    cleanupAllowance: 100,
    tokenLimit: 1000,
    timeLimitMs: 10000,
  });
  store.persistRun(transitionRun(store.run, ReasonCode.GatePassed, TIME));
  store.persistRun(transitionRun(store.run, ReasonCode.UserPaused, TIME));
  const id = store.runId;
  store.close();
  return { root, id, file, ledger, sessionId, h };
}
const approval = {
  actor: 'user' as const,
  approvalId: 'user-ceiling-1',
  previousMinor: 1000,
  ceilingMinor: 2000,
};
describe('explicit user budget ceiling approval', () => {
  it('CAS records immutable approval history; stale/replayed and malformed approval do not mutate', () => {
    const h = paused();
    const before = h.ledger.snapshot();
    approveBudgetCeiling(h.root, h.id, approval, new Date(TIME));
    expect(h.ledger.snapshot().sessions).toEqual(before.sessions);
    expect(effectiveBudgetSession(h.ledger.snapshot(), h.sessionId).ceiling.minor).toBe(2000);
    const store = RunStore.open(h.root, h.id);
    expect(
      assembleStatus({
        run: store.run,
        now: new Date(TIME),
        budget: h.ledger.snapshot(),
        sessionId: h.sessionId,
      }).budgetRemaining.amount
    ).toBe(2000);
    store.close();
    const bytes = fs.readFileSync(h.file);
    for (const input of [
      approval,
      { ...approval, actor: 'model' },
      { ...approval, previousMinor: 2000, ceilingMinor: 2000 },
      { ...approval, previousMinor: 2000, ceilingMinor: Infinity },
      { ...approval, extra: true },
    ]) {
      expect(() =>
        approveBudgetCeiling(h.root, h.id, input as typeof approval, new Date(TIME))
      ).toThrow();
      expect(fs.readFileSync(h.file)).toEqual(bytes);
    }
    expect(() =>
      approveBudgetCeiling(
        h.root,
        h.id,
        { ...approval, previousMinor: 2000, ceilingMinor: 3000 },
        new Date(NaN)
      )
    ).toThrow();
    expect(fs.readFileSync(h.file)).toEqual(bytes);
  });
  it('cannot change an active run or clear an unknown hold; cleanup reserve survives', () => {
    const h = paused();
    const rate = h.h.config.modelProfile.rates.find((r) => r.resource === 'local-qemu');
    if (!rate) throw new Error('fixture rate missing');
    const hold = h.ledger.reserve(h.sessionId, {
      money: { currency: 'USD', minor: 900 },
      tokens: 0,
      timeMs: 1,
      rates: [rate],
    });
    approveBudgetCeiling(h.root, h.id, approval, new Date(TIME));
    const reopened = new BudgetLedger(h.file, h.ledger.contributionId);
    expect(() =>
      reopened.reserve(h.sessionId, {
        money: { currency: 'USD', minor: 1 },
        tokens: 0,
        timeMs: 1,
        rates: [rate],
      })
    ).toThrow('Reconcile recovered reservations');
    expect(reopened.snapshot().reservations[0]).toEqual(hold);
    expect(
      reopened.reserve(
        h.sessionId,
        { money: { currency: 'USD', minor: 100 }, tokens: 0, timeMs: 1, rates: [rate] },
        'teardown'
      ).purpose
    ).toBe('teardown');
    const store = RunStore.open(h.root, h.id);
    store.persistRun(transitionRun(store.run, ReasonCode.ResumePlanning, TIME));
    store.close();
    const bytes = fs.readFileSync(h.file);
    expect(() =>
      approveBudgetCeiling(
        h.root,
        h.id,
        { ...approval, previousMinor: 2000, ceilingMinor: 3000 },
        new Date(TIME)
      )
    ).toThrow('budget_extension_requires_pause');
    expect(fs.readFileSync(h.file)).toEqual(bytes);
  });
  it('rejects damaged extension chains and duplicate approvals on reopen', () => {
    const h = paused();
    approveBudgetCeiling(h.root, h.id, approval, new Date(TIME));
    const valid = h.ledger.snapshot();
    const first = valid.ceilingExtensions?.[0];
    if (!first) throw new Error('extension missing');
    for (const damage of [
      null,
      [{ ...first, previousMinor: 999 }],
      [{ ...first, ceiling: { currency: 'EUR', minor: 2000 } }],
      [first, { ...first, previousMinor: 2000, ceiling: { currency: 'USD', minor: 3000 } }],
    ]) {
      fs.writeFileSync(h.file, JSON.stringify({ ...valid, ceilingExtensions: damage }), {
        mode: 0o600,
      });
      expect(() => new BudgetLedger(h.file, h.ledger.contributionId)).toThrow(
        'Invalid budget ledger'
      );
    }
  });
  it('competing approvals have one CAS winner and terminal runs refuse extension', async () => {
    const h = paused();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => approveBudgetCeiling(h.root, h.id, approval, new Date(TIME))),
      Promise.resolve().then(() =>
        approveBudgetCeiling(
          h.root,
          h.id,
          { ...approval, approvalId: 'user-ceiling-2', ceilingMinor: 3000 },
          new Date(TIME)
        )
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.ledger.snapshot().ceilingExtensions).toHaveLength(1);
    const store = RunStore.open(h.root, h.id);
    store.persistRun(transitionRun(store.run, ReasonCode.UserCancelled, TIME));
    store.close();
    const bytes = fs.readFileSync(h.file);
    expect(() =>
      approveBudgetCeiling(
        h.root,
        h.id,
        { ...approval, previousMinor: 2000, ceilingMinor: 4000 },
        new Date(TIME)
      )
    ).toThrow('budget_extension_requires_pause');
    expect(fs.readFileSync(h.file)).toEqual(bytes);
  });
});
