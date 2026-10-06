import fs from 'node:fs';
import path from 'node:path';
import { publishPrivate, readPrivate, syncDirectory } from '../durable-fs';
import { MAX_ATTEMPT_SEQUENCE } from '../intents';
import { Journal } from '../journal';
import { recordLockReclaim, StoreLockedError, withStoreLock } from '../lock';
import { isTailRecovery } from '../recovery';
import { canonicalJson, ReceiptError, snapshotJson } from './schema';

const HEADER = Buffer.from('{"v":1,"type":"receipt-nonces"}\n');

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
      const file = path.join(this.directory, 'events.jsonl');
      const marker = path.join(this.directory, 'nonce-initializing');
      if (!fs.existsSync(file)) {
        // A write-ahead creation intent distinguishes interrupted initialization
        // from missing established history. The header itself publishes whole.
        publishPrivate(marker, HEADER);
        publishPrivate(file, HEADER);
      } else if (!fs.existsSync(marker)) {
        const { journal, recoveredInitialization } = this.openJournal();
        journal.close();
        if (!recoveredInitialization) throw new ReceiptError('store_exists');
        return;
      }
      const { journal } = this.openJournal();
      journal.close();
    });
  }

  private openJournal(): { journal: Journal; recoveredInitialization: boolean } {
    const file = path.join(this.directory, 'events.jsonl');
    const marker = path.join(this.directory, 'nonce-initializing');
    const initializing = fs.existsSync(marker);
    if (initializing && !readPrivate(marker).equals(HEADER))
      throw new ReceiptError('corrupt_store');
    if (!fs.existsSync(file)) {
      if (!initializing) throw new ReceiptError('missing_store');
      publishPrivate(file, HEADER);
    }
    const journal = new Journal(this.directory);
    try {
      const events = journal.read();
      const domain = events.filter((event) => !isTailRecovery(event));
      let recoveredInitialization = initializing;
      if (!domain.length) {
        // Legacy torn first headers have no creation marker. No authorization
        // could have returned without the complete header. Recover ONLY a byte
        // prefix of that fixed header, backed by offset-zero quarantine evidence.
        const initial = events.find((event) => isTailRecovery(event) && event.offset === 0);
        const tail = isTailRecovery(initial)
          ? readPrivate(path.join(this.directory, initial.quarantine))
          : undefined;
        if (
          !initializing &&
          (!tail || tail.length >= HEADER.length || !HEADER.subarray(0, tail.length).equals(tail))
        )
          throw new ReceiptError('corrupt_store');
        journal.append({ v: 1, type: 'receipt-nonces' });
        recoveredInitialization = true;
      } else if (canonicalJson(domain[0]) !== '{"type":"receipt-nonces","v":1}') {
        throw new ReceiptError('corrupt_store');
      }
      if (initializing) {
        // No row is authorized until initialization finalization is durable.
        if (domain.length > 1) throw new ReceiptError('corrupt_store');
        fs.unlinkSync(marker);
        syncDirectory(this.directory);
      }
      return { journal, recoveredInitialization };
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  consume(input: NonceConsumption): void {
    const row = snapshotJson(input);
    validateRow(row);
    this.locked(() => {
      const { journal } = this.openJournal();
      try {
        const events = journal.read().filter((event) => !isTailRecovery(event));
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
      // Validation/replay failures append no new consumption, though recovery
      // evidence may already be durable. Uncertain persistence retains ownership.
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
    row.attempt > MAX_ATTEMPT_SEQUENCE
  )
    throw new ReceiptError('corrupt_store');
}
