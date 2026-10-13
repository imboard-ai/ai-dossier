/** Controller-owned export sources. Publish before completion/authorization, under
 * the run's lifetime guard; no worker path or credential store enters this boundary. */
import path from 'node:path';
import { replacePrivate } from '../durable-fs';
import { prDisclosure } from '../github/pr-body';
import type { SignedReceipt } from '../receipt/issue';
import { canonicalJson } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { jsonRecord, optionalBytes, RECORD_BYTES } from '../retention/files';
import { offlineReceipt } from '../retention/offline-receipt';
import { parsePortfolio } from '../retention/portfolio';
import { parseVerification } from '../retention/verification';
import type { CommandRecord } from './evidence-runner';
import type { RunStore } from './run-store';

const MAX_BYTES = RECORD_BYTES;
function existing(file: string): unknown | undefined {
  try {
    const bytes = optionalBytes(path.dirname(file), path.basename(file), MAX_BYTES);
    return bytes === null ? undefined : jsonRecord(bytes, MAX_BYTES);
  } catch {
    throw new Error('invalid_export_evidence');
  }
}
function publish(file: string, value: unknown): void {
  assertSecretFree(value);
  replacePrivate(file, Buffer.from(`${canonicalJson(value, MAX_BYTES - 1)}\n`));
}

export function retainReceipt(store: RunStore, receipt: SignedReceipt): void {
  store.withPinnedDirectory((root) => {
    const file = path.join(root, 'receipt-evidence.json');
    const previous = existing(file);
    if (previous !== undefined && !Array.isArray(previous))
      throw new Error('invalid_export_evidence');
    const receipts = (previous ?? []) as unknown[];
    const checked = [...receipts, receipt].map((r) =>
      offlineReceipt(r, store.run, store.contributionId)
    );
    if (checked.some((r) => r.receipt.upstreamRepositoryId !== store.upstreamRepositoryId))
      throw new Error('invalid_export_evidence');
    const unique = [...new Map(checked.map((r) => [r.digest, r])).values()];
    // Export permits 128 verification entries, including the independent source.
    if (unique.length > 127) throw new Error('export_evidence_limit');
    publish(file, unique);
  });
}

export function retainVerification(
  store: RunStore,
  candidateSha: string,
  records: readonly CommandRecord[]
): void {
  store.withPinnedDirectory((root) => {
    const file = path.join(root, 'verification-evidence.json');
    const previous = existing(file);
    if (previous !== undefined) parseVerification(previous, store.runId);
    // Preserve the actual supervised counts and statuses, including skipped/null.
    const value = JSON.parse(
      canonicalJson({ runId: store.runId, candidateSha, records }, MAX_BYTES)
    );
    parseVerification(value, store.runId);
    publish(file, value);
  });
}

export function retainPortfolio(
  store: RunStore,
  candidateSha: string,
  policyCitations: readonly { path: string; line: number; ruleId: string; excerpt: string }[]
): void {
  store.withPinnedDirectory((root) => {
    const file = path.join(root, 'portfolio-evidence.json');
    const previous = existing(file);
    if (previous !== undefined) parsePortfolio(previous, store.runId);
    const value = {
      runId: store.runId,
      disclosure: prDisclosure(candidateSha),
      policyCitations,
    };
    parsePortfolio(value, store.runId);
    publish(file, value);
  });
}
