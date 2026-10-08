import { budgetTotals, validateBudgetSnapshot } from '../budget';
import type { RunStore } from '../controller/run-store';
import { replayHandoffs } from '../github/handoff-driver';
import { replayTrack } from '../github/track';
import type { SignedReceipt } from '../receipt/issue';
import type { CommandEvidence } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { isRunContinuation } from '../state';
import { digest, JOURNAL_BYTES, jsonRecord, optionalBytes, refuse, strictJsonLines } from './files';
import { offlineReceipt } from './offline-receipt';
import { parsePortfolio } from './portfolio';
import { parseVerification } from './verification';

/** Bounded selected sources only; no credential/replay store or environment. */
export function contributionEvidence(store: RunStore, root: string): ContributionEvidence {
  const sources: Record<string, string> = {};
  const select = (name: string) => {
    const bytes = optionalBytes(root, name, name.endsWith('jsonl') ? JOURNAL_BYTES : undefined);
    if (bytes) sources[name] = digest(bytes);
    return bytes;
  };
  // Scan raw snapshots before any projection, including discarded fields.
  for (const name of ['run.json', 'config.json', 'control/events.jsonl']) {
    const bytes = select(name);
    if (!bytes) refuse();
    if (name.endsWith('jsonl')) {
      strictJsonLines(bytes);
    } else jsonRecord(bytes);
  }
  let pr: string | null = null;
  let verifiedSha: string | null = null;
  let outcomeSha: string | null = null;
  let outcome = 'unknown';
  const handoffs = select('handoff/events.jsonl');
  const links: string[] = [store.run.upstreamIssue];
  if (handoffs) {
    const events = strictJsonLines(handoffs);
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
    const events = strictJsonLines(tracking);
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
      receipts.push(offlineReceipt(envelope, store.run, store.contributionId));
    }
  }
  const portfolioBytes = select('portfolio-evidence.json');
  let disclosure: string | null = null;
  let policyCitations: { path: string; line: number; ruleId: string; excerpt: string }[] | null =
    null;
  if (portfolioBytes) {
    ({ disclosure, policyCitations } = parsePortfolio(jsonRecord(portfolioBytes), store.runId));
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
    verificationRecords = [
      ...(verification ?? []),
      parseVerification(jsonRecord(verificationBytes), store.runId),
    ];
  }
  if ((verificationRecords?.length ?? 0) > 128) refuse('size-limit', 'evidence');
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
export interface ContributionEvidence {
  upstreamIssue: string;
  links: string[];
  pr: string | null;
  verifiedSha: string | null;
  outcomeSha: string | null;
  outcome: string;
  costTotals:
    | {
        sessionId: string;
        currency: string;
        spent: number;
        reserved: number;
        tokens: number;
        timeMs: number;
      }[]
    | null;
  receipts: SignedReceipt[];
  verification:
    | {
        receiptDigest: string | null;
        candidateSha: string;
        verified: boolean;
        commands: CommandEvidence[];
      }[]
    | null;
  disclosure: string | null;
  policyCitations: { path: string; line: number; ruleId: string; excerpt: string }[] | null;
  receiptDigests: string[];
  evidenceDigest: string;
}
