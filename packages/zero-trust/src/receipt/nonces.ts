import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../journal';
import { recordLockReclaim, StoreLockedError, withStoreLock } from '../lock';
import { isTailRecovery } from '../recovery';
import { canonicalJson, ReceiptError, snapshotJson } from './schema';

export interface NonceConsumption {
  nonce: string;
  operationKey: string;
  receiptDigest: string;
  attempt: number;
}
/** LOCAL trusted filesystem only. All users of this directory take the same
 * exclusive lock, open the journal only under it, reread, append and fsync.
 * Dead owners are reclaimed only with process identity proof and durable audit.
 * This must not share a directory with IntentDriver's separate journal. */
export class ReceiptNonceStore {
  private readonly directory: string;
  private poisoned = false;
  constructor(directory: string) {
    const resolved = path.resolve(directory);
    if (fs.realpathSync(resolved) !== resolved || !fs.lstatSync(resolved).isDirectory())
      throw new ReceiptError('unsafe_store');
    this.directory = resolved;
  }
  initialize(): void {
    this.locked(() => {
      if (fs.existsSync(path.join(this.directory, 'events.jsonl')))
        throw new ReceiptError('store_exists');
      const journal = new Journal(this.directory);
      try {
        journal.append({ v: 1, type: 'receipt-nonces' });
      } finally {
        journal.close();
      }
    });
  }
  consume(input: NonceConsumption): void {
    const row = snapshotJson(input);
    validateRow(row);
    this.locked(() => {
      if (!fs.existsSync(path.join(this.directory, 'events.jsonl')))
        throw new ReceiptError('missing_store');
      const journal = new Journal(this.directory);
      try {
        const events = journal.read();
        if (canonicalJson(events[0]) !== '{"type":"receipt-nonces","v":1}')
          throw new ReceiptError('corrupt_store');
        const nonces = new Set<string>();
        const attempts = new Map<string, number>();
        for (const event of events.slice(1)) {
          if (isTailRecovery(event)) continue;
          validateRow(event);
          const prior = event as NonceConsumption;
          if (nonces.has(prior.nonce)) throw new ReceiptError('corrupt_store');
          if ((attempts.get(prior.operationKey) ?? 0) >= prior.attempt)
            throw new ReceiptError('corrupt_store');
          nonces.add(prior.nonce);
          attempts.set(prior.operationKey, prior.attempt);
        }
        if (nonces.has(row.nonce)) throw new ReceiptError('replayed_nonce');
        if ((attempts.get(row.operationKey) ?? 0) >= row.attempt)
          throw new ReceiptError('replayed_operation');
        // Successful return is the authorization; fsync precedes all side effects.
        journal.append(row);
      } finally {
        journal.close();
      }
    });
  }
  private locked<T>(work: () => T): T {
    if (this.poisoned) throw new ReceiptError('persistence_uncertain');
    const lock = path.join(this.directory, 'receipt.lock');
    try {
      return withStoreLock(
        lock,
        0,
        (owner) => {
          recordLockReclaim(path.join(this.directory, 'lock-recovery'), lock, owner, []);
        },
        work,
        (error) => !(error instanceof ReceiptError)
      );
    } catch (error) {
      // Retain the lock on every uncertain error. Validation/replay failures are
      // known not to have written, and may release it safely.
      if (error instanceof StoreLockedError || error instanceof SyntaxError)
        throw new ReceiptError('store_locked');
      if (!(error instanceof ReceiptError)) this.poisoned = true;
      throw error;
    }
  }
}
function validateRow(raw: unknown): asserts raw is NonceConsumption {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ReceiptError('corrupt_store');
  const row = raw as NonceConsumption;
  if (
    Object.keys(row).sort().join(',') !== 'attempt,nonce,operationKey,receiptDigest' ||
    typeof row.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.nonce) ||
    typeof row.operationKey !== 'string' ||
    row.operationKey.length < 1 ||
    row.operationKey.length > 4096 ||
    typeof row.receiptDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.receiptDigest) ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    row.attempt > 2
  )
    throw new ReceiptError('corrupt_store');
}
