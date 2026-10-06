import { spawn } from 'node:child_process';
import path from 'node:path';
import { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import { Journal } from '../journal';

export function budgetFixture(directory: string, rate: BudgetRate): BudgetLedger {
  const ledger = new BudgetLedger(path.join(directory, 'ledger.json'), 'c', 100);
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
export function readJournal(directory: string): unknown[] {
  const journal = new Journal(directory);
  try {
    return journal.read();
  } finally {
    journal.close();
  }
}
export async function crashProcess(script: string, timeoutMs = 4000): Promise<void> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (bytes) => {
    stderr += bytes;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('crash boundary not reached'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') resolve();
      else reject(new Error(`writer did not crash: ${stderr}`));
    });
  });
}
