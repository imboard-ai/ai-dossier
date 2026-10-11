/** Trusted local contributor command, never dispatched from model or repository data. */
import path from 'node:path';
import { BudgetLedger } from '../budget';
import { assertSecretFree } from '../redaction';
import { RunStore } from './run-store';

export interface CeilingApproval {
  readonly previousMinor: number;
  readonly ceilingMinor: number;
  readonly approvalId: string;
  readonly actor: 'user';
}

/** Lifetime RunStore guard excludes active controllers. Ledger's CAS and atomic
 * publication retain all session/hold history across crash and repeated commands. */
export function approveBudgetCeiling(
  root: string,
  runId: string,
  approval: CeilingApproval,
  now: Date
): void {
  assertSecretFree(approval);
  const copy = structuredClone(approval);
  if (Object.keys(copy).length !== 4 || copy.actor !== 'user')
    throw new Error('invalid_ceiling_approval');
  const store = RunStore.open(root, runId);
  try {
    if (store.run.state !== 'paused_user') throw new Error('budget_extension_requires_pause');
    const ledger = new BudgetLedger(
      path.join(store.storeDirectory('budget'), 'ledger.json'),
      store.contributionId
    );
    ledger.extendCeiling({
      sessionId: store.budgetSessionId(1),
      previousMinor: copy.previousMinor,
      ceiling: { currency: store.config.budget.currency, minor: copy.ceilingMinor },
      approvalId: copy.approvalId,
      approvedAt: now.toISOString(),
      actor: 'user',
    });
  } finally {
    store.close();
  }
}
