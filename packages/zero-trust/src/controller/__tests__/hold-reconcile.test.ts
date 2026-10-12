/** #1186: a model failure must not leave a budget hold that refuses every later phase. */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../../budget';
import { ModelError } from '../../model/adapter';
import { rig } from './composition-fixture';
import { compositionHooks } from './composition-hooks';

compositionHooks();
describe('unreconciled model holds (#1186)', () => {
  it('a timed-out planning call is charged at its estimate and the run resumes', async () => {
    let failed = false;
    const h = rig({
      beforeModel: async (request) => {
        if (!failed && request.tools[0]?.function.name !== 'report_decision') {
          failed = true;
          throw new ModelError('model_timeout');
        }
      },
    });
    const first = (await h.authorize(h.controller.start(h.config))) as {
      runId: string;
      state: string;
    };
    expect(failed).toBe(true);
    expect(first.state).not.toBe('awaiting_contributor');
    const ledgerFile = path.join(
      h.config.executionProfile.stateDir,
      'runs',
      first.runId.replace(/-run-\d+$/u, ''),
      'budget',
      'ledger.json'
    );
    const reserved = () =>
      new BudgetLedger(ledgerFile, first.runId.replace(/-run-\d+$/u, ''))
        .snapshot()
        .reservations.filter((r) => r.status === 'reserved');
    expect(reserved()).toHaveLength(1);
    const resumed = (await h.authorize(h.controller.resume(first.runId))) as { state: string };
    expect(resumed.state).toBe('awaiting_contributor');
    expect(reserved()).toEqual([]);
  }, 60000);
});
