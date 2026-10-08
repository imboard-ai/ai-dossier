import { createPublicKey, verify } from 'node:crypto';
import { toSpkiPem } from '@ai-dossier/core';
import Ajv from 'ajv';
import { budgetTotals, validateBudgetSnapshot } from '../budget';
import type { RunStore } from '../controller/run-store';
import { replayHandoffs } from '../github/handoff-driver';
import { replayTrack } from '../github/track';
import { receiptDigest, type SignedReceipt } from '../receipt/issue';
import {
  type CommandEvidence,
  canonicalJson,
  evidenceVerified,
  parseReceipt,
  RECEIPT_SCHEMA,
} from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { isRecord, isRunContinuation } from '../state';
import { digest, jsonRecord, optionalBytes, refuse } from './files';

const validateCommands = new Ajv({ strict: true }).compile<CommandEvidence[]>(
  RECEIPT_SCHEMA.properties.commands as object
);

/** Bounded selected sources only; no credential/replay store or environment. */
export function contributionEvidence(store: RunStore, root: string) {
  const sources: Record<string, string> = {};
  const select = (name: string) => {
    const bytes = optionalBytes(root, name);
    if (bytes) sources[name] = digest(bytes);
    return bytes;
  };
  // Scan raw snapshots before any projection, including discarded fields.
  for (const name of ['run.json', 'config.json', 'control/events.jsonl']) {
    const bytes = select(name);
    if (!bytes) refuse();
    if (name.endsWith('jsonl')) {
      if (!bytes.toString().endsWith('\n')) refuse();
      for (const line of bytes.toString().trimEnd().split('\n')) jsonRecord(Buffer.from(line));
    } else jsonRecord(bytes);
  }
  let pr: string | null = null;
  let verifiedSha: string | null = null;
  let outcomeSha: string | null = null;
  let outcome = 'unknown';
  const handoffs = select('handoff/events.jsonl');
  const links: string[] = [store.run.upstreamIssue];
  if (handoffs) {
    if (!handoffs.toString().endsWith('\n')) refuse();
    const events = handoffs
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => jsonRecord(Buffer.from(line)));
    const state = replayHandoffs(events);
    if (state.contributionId !== store.contributionId || !isRunContinuation(state.run, store.run))
      refuse();
    for (const record of state.handoffs.values()) {
      if (record.status !== 'observed') continue;
      if (record.artifactRef) links.push(record.artifactRef);
      if (record.input.operationKind === 'pr_create') {
        pr = record.artifactRef ?? null;
        verifiedSha = record.headSha ?? null;
      }
    }
  }
  const tracking = select('track/events.jsonl');
  if (tracking) {
    if (!tracking.toString().endsWith('\n')) refuse();
    const events = tracking
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => jsonRecord(Buffer.from(line)));
    const track = replayTrack(events);
    if (track.contributionId !== store.contributionId || !isRunContinuation(track.run, store.run))
      refuse();
    pr = track.pr.url;
    verifiedSha = track.verifiedSha;
    outcomeSha = track.outcomeSha ?? null;
    outcome = track.outcomeSha
      ? track.run.state
      : track.blockedReason
        ? 'blocked'
        : 'awaiting_review';
    if (!links.includes(pr)) links.push(pr);
  }
  const budget = select('budget/ledger.json');
  const costTotals = budget
    ? (() => {
        const state = validateBudgetSnapshot(jsonRecord(budget), store.contributionId);
        if (!state.sessions.length) return null;
        return state.sessions.map((session) => ({
          sessionId: session.id,
          currency: session.ceiling.currency,
          ...budgetTotals(state, session.id),
        }));
      })()
    : null;
  const receiptBytes = select('receipt-evidence.json');
  const receipts: SignedReceipt[] = [];
  if (receiptBytes) {
    const raw = jsonRecord(receiptBytes);
    if (!Array.isArray(raw) || raw.length > 128) refuse();
    for (const envelope of raw) {
      if (!isRecord(envelope) || !isRecord(envelope.signature)) refuse();
      const receipt = parseReceipt(envelope.receipt);
      if (
        receipt.runId !== store.runId ||
        receipt.contributionId !== store.contributionId ||
        envelope.digest !== receiptDigest(receipt)
      )
        refuse();
      if (
        envelope.signature.algorithm !== 'ed25519' ||
        typeof envelope.signature.public_key !== 'string' ||
        typeof envelope.signature.signature !== 'string'
      )
        refuse();
      if (
        !verify(
          null,
          Buffer.from(canonicalJson(receipt)),
          createPublicKey(toSpkiPem(envelope.signature.public_key)),
          Buffer.from(envelope.signature.signature, 'base64')
        )
      )
        refuse();
      receipts.push({
        receipt,
        digest: receiptDigest(receipt),
        signature: envelope.signature as unknown as SignedReceipt['signature'],
      });
    }
  }
  const portfolioBytes = select('portfolio-evidence.json');
  let disclosure: string | null = null;
  let policyCitations: { path: string; line: number; ruleId: string; excerpt: string }[] | null =
    null;
  if (portfolioBytes) {
    const raw = jsonRecord(portfolioBytes);
    if (
      !isRecord(raw) ||
      raw.runId !== store.runId ||
      typeof raw.disclosure !== 'string' ||
      !Array.isArray(raw.policyCitations) ||
      raw.policyCitations.length > 128
    )
      refuse();
    disclosure = raw.disclosure;
    policyCitations = raw.policyCitations.map((citation) => {
      if (
        !isRecord(citation) ||
        typeof citation.path !== 'string' ||
        !Number.isSafeInteger(citation.line) ||
        Number(citation.line) < 1 ||
        typeof citation.ruleId !== 'string' ||
        typeof citation.excerpt !== 'string'
      )
        refuse();
      return {
        path: citation.path,
        line: citation.line as number,
        ruleId: citation.ruleId,
        excerpt: citation.excerpt,
      };
    });
  }
  const verification:
    | {
        receiptDigest: string | null;
        candidateSha: string;
        verified: boolean;
        commands: CommandEvidence[];
      }[]
    | null = receiptBytes
    ? receipts.map(({ digest, receipt }) => ({
        receiptDigest: digest,
        candidateSha: receipt.candidateSha,
        verified: receipt.verified,
        commands: receipt.commands,
      }))
    : null;
  const verificationBytes = select('verification-evidence.json');
  let verificationRecords = verification;
  if (verificationBytes) {
    const raw = jsonRecord(verificationBytes);
    if (
      !isRecord(raw) ||
      raw.runId !== store.runId ||
      typeof raw.candidateSha !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(raw.candidateSha) ||
      !Array.isArray(raw.records) ||
      raw.records.length > 128
    )
      refuse();
    const commands = raw.records.map((record) => {
      if (
        !isRecord(record) ||
        !isRecord(record.log) ||
        !isRecord(record.evidence) ||
        record.phase !== 'verification' ||
        record.network !== 'none' ||
        typeof record.timedOut !== 'boolean' ||
        typeof record.captureReport !== 'boolean' ||
        !Number.isSafeInteger(record.durationMs) ||
        Number(record.durationMs) < 0 ||
        ![record.tests, record.failures].every(
          (value) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0)
        ) ||
        !Number.isSafeInteger(record.log.bytes) ||
        Number(record.log.bytes) < 0 ||
        typeof record.log.excerpt !== 'string' ||
        typeof record.log.excerptTruncated !== 'boolean' ||
        typeof record.log.redacted !== 'boolean' ||
        typeof record.log.outputTruncated !== 'boolean' ||
        record.log.digest !== record.evidence.sanitizedLogDigest ||
        record.status !== record.evidence.status ||
        record.id !== record.evidence.id ||
        record.argv !== record.evidence.command ||
        (record.exitCode ?? 'unknown') !== record.evidence.exitStatus ||
        (record.suites ?? 'unknown') !== record.evidence.suites
      )
        refuse();
      return record.evidence;
    });
    if (!validateCommands(commands)) refuse();
    verificationRecords = [
      ...(verification ?? []),
      {
        receiptDigest: null,
        candidateSha: raw.candidateSha,
        verified: evidenceVerified(commands),
        commands,
      },
    ];
  }
  const result = {
    upstreamIssue: store.run.upstreamIssue,
    links,
    pr,
    verifiedSha,
    outcomeSha,
    outcome,
    costTotals,
    receipts,
    verification: verificationRecords,
    disclosure,
    policyCitations,
    receiptDigests: receipts.map((r) => r.digest),
    evidenceDigest: digest(JSON.stringify(sources)),
  };
  assertSecretFree(result);
  return result;
}
