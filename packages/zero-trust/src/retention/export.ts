import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { contributionIdOf } from '../controller/ids';
import type { RunStore } from '../controller/run-store';
import { assertDirectoryAncestors, syncDirectory } from '../durable-fs';
import { handoffMarker } from '../github/handoff';
import {
  type RelocationEvidence,
  type TrackedPr,
  validateRelocationEvidence,
} from '../github/track';
import {
  canonicalJson,
  evidenceVerified,
  parseCommandEvidence,
  RECEIPT_SCHEMA,
} from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { type RunRecord, restoreRun } from '../state';
import { maintenanceBoundary } from './errors';
import { contributionEvidence } from './evidence';
import { inDirectory, refuse } from './files';
import { offlineReceipt, signatureSchema } from './offline-receipt';
import {
  hash,
  nullable,
  object,
  outcome,
  portableFacts,
  portableFields,
  sha,
  text,
} from './portable';
import { type ContributionSummary, readContributionSummary } from './retention';

export const EXPORT_VERSION = 'ztfc-export-v1' as const;
const statusSchema = object({
  ...portableFields,
  state: text,
  snapshotExpired: { type: 'boolean' },
});
const trackedPrSchema = object({
  binding: object({
    upstream: object({ owner: text, repo: text }),
    base: text,
    headOwner: text,
    branch: text,
  }),
  fork: object({ repositoryId: { type: 'integer', minimum: 1 }, owner: text, repo: text }),
  number: { type: 'integer', minimum: 1 },
  url: text,
  marker: text,
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
      ...portableFields,
      schemaVersion: { const: 'ztfc-summary-v1' },
      runId: text,
      snapshotExpired: { const: true },
      links: { type: 'array', items: text },
      receiptDigests: { type: 'array', maxItems: 128, items: hash },
    })
  ),
  receipts: {
    type: 'array',
    maxItems: 128,
    items: object({
      receipt: RECEIPT_SCHEMA,
      digest: hash,
      signature: signatureSchema,
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
  originalPr: nullable(trackedPrSchema),
  relocations: {
    type: 'array',
    maxItems: 128,
    items: object({ from: trackedPrSchema, to: trackedPrSchema, author: text, body: text }),
  },
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
  originalPr: TrackedPr | null;
  relocations: RelocationEvidence[];
  outcome: string;
  disclosure: string | null;
  policyCitations: ReturnType<typeof contributionEvidence>['policyCitations'];
}
const validate = new Ajv({ strict: true }).compile<ContributionExport>(EXPORT_SCHEMA);
export function validateContributionExport(input: unknown): ContributionExport {
  return maintenanceBoundary('export', () => {
    try {
      input = JSON.parse(canonicalJson(input, 1024 * 1024));
    } catch {
      refuse('invalid-input', 'export');
    }
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
    const contributionId = contributionIdOf(run.runId);
    if (!contributionId) refuse();
    const observedPr = run.history.some((event) => event.to === 'submitted');
    const prPrefix = run.upstreamIssue.replace(/\/issues\/[1-9][0-9]*$/u, '/pull/');
    const boundPr = (url: string) =>
      url.startsWith(prPrefix) && /^[1-9][0-9]*$/u.test(url.slice(prPrefix.length));
    let previous: RelocationEvidence | undefined;
    if (input.relocations.length && !input.originalPr) refuse();
    for (const raw of input.relocations) {
      const proof = validateRelocationEvidence(raw);
      if (
        !boundPr(proof.from.url) ||
        !boundPr(proof.to.url) ||
        proof.author.toLowerCase() !== run.contributor.toLowerCase() ||
        !proof.from.marker.startsWith(`<!-- ai-dossier:ztfc contribution=${contributionId} `) ||
        (previous && JSON.stringify(previous.to) !== JSON.stringify(proof.from))
      )
        refuse();
      previous = proof;
    }
    if (
      input.relocations.length &&
      JSON.stringify(input.relocations[0].from) !== JSON.stringify(input.originalPr)
    )
      refuse();
    if (previous && previous.to.url !== input.pr) refuse();
    const historicalPr = input.summary?.pr;
    if (historicalPr !== null && historicalPr !== undefined) {
      if (!boundPr(historicalPr)) refuse();
      if (
        historicalPr !== input.pr &&
        !input.relocations.some((proof) => proof.from.url === historicalPr)
      )
        refuse();
    }
    if (
      (input.pr !== null &&
        (!observedPr ||
          !input.pr.startsWith(prPrefix) ||
          !/^[1-9][0-9]*$/u.test(input.pr.slice(prPrefix.length)))) ||
      (input.status.verifiedSha !== null && input.pr === null)
    )
      refuse();
    if (input.outcome === 'merged' || input.outcome === 'declined') {
      const revisionMerge =
        input.outcome === 'merged' &&
        run.state === 'blocked' &&
        run.history.some((entry) => entry.to === 'revising');
      if ((!revisionMerge && run.state !== input.outcome) || !input.pr || !input.status.outcomeSha)
        refuse();
    } else if (
      input.status.outcomeSha !== null ||
      (input.outcome === 'awaiting_review' && !input.pr) ||
      (input.outcome === 'blocked' &&
        (!input.pr ||
          !['blocked', 'blocked_cleanup', 'cancelled', 'failed', 'unsupported'].includes(
            run.state
          )))
    )
      refuse();
    if (
      (run.state === 'merged' || (run.state === 'declined' && observedPr)) &&
      input.outcome !== run.state
    )
      refuse();
    for (const envelope of input.receipts) {
      offlineReceipt(envelope, run, contributionId);
    }
    for (const proof of input.relocations) {
      const target = run.upstreamIssue.replace('https://github.com/', '').replace('/issues/', '#');
      const applicable = input.receipts;
      if (
        !applicable.some(
          ({ receipt }) =>
            proof.from.marker ===
            handoffMarker({
              contributionId,
              target,
              operationKind: 'pr_create',
              candidateSha: receipt.candidateSha,
            })
        ) ||
        applicable.some(
          ({ receipt }) =>
            receipt.forkRepositoryId !== proof.from.fork.repositoryId ||
            receipt.defaultBranch !== proof.from.binding.base ||
            receipt.contributor.toLowerCase() !== proof.from.fork.owner.toLowerCase()
        )
      )
        refuse();
    }
    for (const envelope of input.receipts) {
      if (
        !(input.verification ?? []).some(
          (record) =>
            record.receiptDigest === envelope.digest &&
            record.verified === envelope.receipt.verified
        )
      )
        refuse();
    }
    for (const record of input.verification ?? []) {
      parseCommandEvidence(record.commands);
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
        (['merged', 'declined'].includes(input.summary.outcome) &&
          input.summary.outcome !== input.outcome) ||
        (input.summary.verifiedSha !== null &&
          input.summary.verifiedSha !== input.status.verifiedSha) ||
        (input.summary.outcomeSha !== null &&
          input.summary.outcomeSha !== input.status.outcomeSha) ||
        JSON.stringify(input.summary.costTotals) !== JSON.stringify(input.status.costTotals) ||
        JSON.stringify(input.summary.receiptDigests) !==
          JSON.stringify(input.receipts.map((r) => r.digest)))
    )
      refuse();
    return structuredClone(input);
  });
}
/** Shared no-write preflight: expiry cannot publish evidence the export cannot represent. */
export function preflightExport(
  store: RunStore,
  facts: ReturnType<typeof contributionEvidence>,
  persisted: ContributionSummary | null
): ContributionExport {
  const summary: ContributionExport['summary'] = persisted
    ? {
        schemaVersion: 'ztfc-summary-v1',
        runId: store.runId,
        snapshotExpired: true,
        ...portableFacts(persisted.facts),
        links: persisted.facts.links,
        receiptDigests: persisted.facts.receiptDigests,
      }
    : null;
  return validateContributionExport({
    schemaVersion: EXPORT_VERSION,
    run: structuredClone(store.run),
    status: {
      state: store.run.state,
      ...portableFacts(facts),
      snapshotExpired: persisted !== null,
    },
    summary,
    receipts: facts.receipts,
    verification: facts.verification,
    pr: facts.pr,
    originalPr: facts.originalPr,
    relocations: facts.relocations,
    outcome: facts.outcome,
    disclosure: facts.disclosure,
    policyCitations: facts.policyCitations,
  });
}
/** Offline export. The caller's RunStore owns the guard for the complete operation. */
export function exportContribution(store: RunStore, outFile: string): ContributionExport {
  return maintenanceBoundary('export', () =>
    store.withPinnedDirectory((root) => {
      const bundle = preflightExport(
        store,
        contributionEvidence(store, root),
        readContributionSummary(store)
      );
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
    })
  );
}
