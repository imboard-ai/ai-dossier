import childProcess, { spawn } from 'node:child_process';
import path from 'node:path';
import { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import { Journal } from '../journal';

/** All constructors finish before any mutation starts. Join close (not exit) so
 * diagnostics are drained, and kill/join every owned child on failure/timeout. */
export async function raceReadyProcesses(script: string, count: number) {
  const children = Array.from({ length: count }, () => {
    const child = childProcess.spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (bytes) => {
      stderr = (stderr + bytes).slice(-4096);
    });
    let ready = false;
    const readiness = new Promise<void>((resolve, reject) => {
      child.once('message', (message) => {
        if (message !== 'ready') return reject(new Error('unexpected child readiness message'));
        ready = true;
        resolve();
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (!ready) reject(new Error(`child not ready: ${code}/${signal}: ${stderr}`));
      });
    });
    const closed = new Promise<{ code: number | null; signal: string | null; stderr: string }>(
      (resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal, stderr }));
      }
    );
    return { child, readiness, closed };
  });
  const timer = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
  }, 15_000);
  try {
    await Promise.all(children.map(({ readiness }) => readiness));
    await Promise.all(
      children.map(
        ({ child }) =>
          new Promise<void>((resolve, reject) => {
            child.send('go', (error) => (error ? reject(error) : resolve()));
          })
      )
    );
    return await Promise.all(children.map(({ closed }) => closed));
  } finally {
    clearTimeout(timer);
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map(({ closed }) => closed));
  }
}

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
