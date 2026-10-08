import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toSpkiPem } from '@ai-dossier/core';
import Ajv from 'ajv';
import type { RunStore } from '../controller/run-store';
import { assertDirectoryAncestors, syncDirectory } from '../durable-fs';
import { receiptDigest } from '../receipt/issue';
import { canonicalJson, evidenceVerified, parseReceipt, RECEIPT_SCHEMA } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { type RunRecord, restoreRun } from '../state';
import { contributionEvidence } from './evidence';
import { inDirectory, refuse } from './files';
import { readContributionSummary } from './retention';

export const EXPORT_VERSION = 'ztfc-export-v1' as const;
const text = { type: 'string', maxLength: 8192 };
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const number = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const costs = nullable({
  type: 'array',
  maxItems: 128,
  items: object({
    sessionId: text,
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    spent: number,
    reserved: number,
    tokens: number,
    timeMs: number,
  }),
});
const outcome = { enum: ['unknown', 'awaiting_review', 'merged', 'declined', 'blocked'] };
const statusSchema = object({
  state: text,
  upstreamIssue: text,
  pr: nullable(text),
  verifiedSha: nullable(sha),
  outcomeSha: nullable(sha),
  outcome,
  costTotals: costs,
  snapshotExpired: { type: 'boolean' },
});
/** Portable public schema, also used by the runtime validator before any output write. */
export const EXPORT_SCHEMA = object({
  schemaVersion: { const: EXPORT_VERSION },
  run: object({
    schemaVersion: { const: 1 },
    runId: text,
    upstreamIssue: text,
    contributor: text,
    state: text,
    reasonCode: text,
    createdAt: text,
    updatedAt: text,
    history: {
      type: 'array',
      items: object({ from: text, to: text, reasonCode: text, timestamp: text }),
    },
  }),
  status: statusSchema,
  summary: nullable(
    object({
      schemaVersion: { const: 'ztfc-summary-v1' },
      runId: text,
      snapshotExpired: { const: true },
      upstreamIssue: text,
      links: { type: 'array', items: text },
      pr: nullable(text),
      verifiedSha: nullable(sha),
      outcomeSha: nullable(sha),
      outcome,
      costTotals: costs,
      receiptDigests: { type: 'array', maxItems: 128, items: hash },
    })
  ),
  receipts: {
    type: 'array',
    maxItems: 128,
    items: object({
      receipt: RECEIPT_SCHEMA,
      digest: hash,
      signature: {
        type: 'object',
        additionalProperties: false,
        required: ['algorithm', 'signature', 'public_key', 'signed_at'],
        properties: {
          algorithm: { const: 'ed25519' },
          signature: text,
          public_key: text,
          signed_at: text,
          key_id: text,
        },
      },
    }),
  },
  verification: nullable({
    type: 'array',
    maxItems: 128,
    items: object({
      receiptDigest: nullable(hash),
      candidateSha: sha,
      verified: { type: 'boolean' },
      commands: RECEIPT_SCHEMA.properties.commands,
    }),
  }),
  pr: nullable(text),
  outcome,
  disclosure: nullable(text),
  policyCitations: nullable({
    type: 'array',
    maxItems: 128,
    items: object({
      path: text,
      line: { type: 'integer', minimum: 1 },
      ruleId: text,
      excerpt: text,
    }),
  }),
});
export interface ContributionExport {
  schemaVersion: typeof EXPORT_VERSION;
  run: RunRecord;
  status: {
    state: string;
    upstreamIssue: string;
    pr: string | null;
    verifiedSha: string | null;
    outcomeSha: string | null;
    outcome: string;
    costTotals: ReturnType<typeof contributionEvidence>['costTotals'];
    snapshotExpired: boolean;
  };
  summary: {
    schemaVersion: 'ztfc-summary-v1';
    runId: string;
    snapshotExpired: true;
    upstreamIssue: string;
    links: string[];
    pr: string | null;
    verifiedSha: string | null;
    outcomeSha: string | null;
    outcome: string;
    costTotals: ReturnType<typeof contributionEvidence>['costTotals'];
    receiptDigests: string[];
  } | null;
  receipts: ReturnType<typeof contributionEvidence>['receipts'];
  verification: ReturnType<typeof contributionEvidence>['verification'];
  pr: string | null;
  outcome: string;
  disclosure: string | null;
  policyCitations: ReturnType<typeof contributionEvidence>['policyCitations'];
}
const validate = new Ajv({ strict: true }).compile<ContributionExport>(EXPORT_SCHEMA);
export function validateContributionExport(input: unknown): ContributionExport {
  input = JSON.parse(canonicalJson(input, 1024 * 1024));
  assertSecretFree(input);
  if (!validate(input)) refuse();
  const run = restoreRun(input.run);
  if (
    input.status.state !== run.state ||
    input.status.upstreamIssue !== run.upstreamIssue ||
    input.status.pr !== input.pr ||
    input.status.outcome !== input.outcome ||
    input.status.snapshotExpired !== (input.summary !== null)
  )
    refuse();
  for (const envelope of input.receipts) {
    const receipt = parseReceipt(envelope.receipt);
    if (receipt.runId !== run.runId || receiptDigest(receipt) !== envelope.digest) refuse();
    if (
      !verify(
        null,
        Buffer.from(canonicalJson(receipt)),
        createPublicKey(toSpkiPem(envelope.signature.public_key)),
        Buffer.from(envelope.signature.signature, 'base64')
      )
    )
      refuse();
  }
  for (const record of input.verification ?? []) {
    if (record.verified !== evidenceVerified(record.commands)) refuse();
    if (record.receiptDigest !== null) {
      const envelope = input.receipts.find((r) => r.digest === record.receiptDigest);
      if (
        !envelope ||
        record.candidateSha !== envelope.receipt.candidateSha ||
        JSON.stringify(record.commands) !== JSON.stringify(envelope.receipt.commands)
      )
        refuse();
    }
  }
  if (
    input.summary &&
    (input.summary.runId !== run.runId ||
      input.summary.upstreamIssue !== run.upstreamIssue ||
      input.summary.pr !== input.pr ||
      input.summary.outcome !== input.outcome ||
      input.summary.verifiedSha !== input.status.verifiedSha ||
      input.summary.outcomeSha !== input.status.outcomeSha ||
      JSON.stringify(input.summary.costTotals) !== JSON.stringify(input.status.costTotals) ||
      JSON.stringify(input.summary.receiptDigests) !==
        JSON.stringify(input.receipts.map((r) => r.digest)))
  )
    refuse();
  return structuredClone(input);
}
/** Offline export. The caller's RunStore owns the guard for the complete operation. */
export function exportContribution(store: RunStore, outFile: string): ContributionExport {
  return store.withPinnedDirectory((root) => {
    const facts = contributionEvidence(store, root);
    const persisted = readContributionSummary(store);
    if (persisted && JSON.stringify(persisted.facts) !== JSON.stringify(facts)) refuse();
    const summary: ContributionExport['summary'] = persisted
      ? {
          schemaVersion: 'ztfc-summary-v1',
          runId: store.runId,
          snapshotExpired: true,
          upstreamIssue: facts.upstreamIssue,
          links: facts.links,
          pr: facts.pr,
          verifiedSha: facts.verifiedSha,
          outcomeSha: facts.outcomeSha,
          outcome: facts.outcome,
          costTotals: facts.costTotals,
          receiptDigests: facts.receiptDigests,
        }
      : null;
    const bundle = validateContributionExport({
      schemaVersion: EXPORT_VERSION,
      run: structuredClone(store.run),
      status: {
        state: store.run.state,
        upstreamIssue: store.run.upstreamIssue,
        pr: facts.pr,
        verifiedSha: facts.verifiedSha,
        outcomeSha: facts.outcomeSha,
        outcome: facts.outcome,
        costTotals: facts.costTotals,
        snapshotExpired: persisted !== null,
      },
      summary,
      receipts: facts.receipts,
      verification: facts.verification,
      pr: facts.pr,
      outcome: facts.outcome,
      disclosure: facts.disclosure,
      policyCitations: facts.policyCitations,
    });
    // Pin the destination's ancestors too; O_EXCL never follows/overwrites a leaf.
    outFile = path.resolve(outFile);
    assertDirectoryAncestors(path.dirname(outFile));
    inDirectory('/', path.dirname(outFile).slice(1), (parent) => {
      const fd = fs.openSync(
        path.join(parent, path.basename(outFile)),
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        fs.writeFileSync(fd, JSON.stringify(bundle));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDirectory(parent);
    });
    return bundle;
  });
}
