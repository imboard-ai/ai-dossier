import { budgetTotals, validateBudgetSnapshot } from '../budget';
import type { RunStore } from '../controller/run-store';
import { replayHandoffs } from '../github/handoff-driver';
import { type RelocationEvidence, replayTrack, validateRelocationEvidence } from '../github/track';
import type { SignedReceipt } from '../receipt/issue';
import type { CommandEvidence } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { isRunContinuation, restoreRun } from '../state';
import { digest, JOURNAL_BYTES, jsonRecord, optionalBytes, refuse, strictJsonLines } from './files';
import { offlineReceipt } from './offline-receipt';
import { parsePortfolio } from './portfolio';
import { parseVerification } from './verification';

/** Bounded selected sources only; no credential/replay store or environment. */
export interface EvidenceSnapshot {
  run: string;
  sources: Record<string, { length: number; digest: string }>;
}
type EvidenceStore = Pick<RunStore, 'run' | 'runId' | 'contributionId'>;
export function contributionEvidence(
  store: EvidenceStore,
  root: string,
  snapshot?: EvidenceSnapshot,
  read: (name: string) => Buffer | null = (name) =>
    optionalBytes(root, name, name.endsWith('jsonl') ? JOURNAL_BYTES : undefined)
): ContributionEvidence {
  const sources: Record<string, string> = {};
  const select = (name: string) => {
    const bytes = read(name);
    if (bytes) sources[name] = digest(bytes);
    if (bytes && snapshot) {
      snapshot.sources[name] = { length: bytes.length, digest: digest(bytes) };
      if (name === 'run.json') snapshot.run = bytes.toString('utf8');
    }
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
  const relocations: RelocationEvidence[] = [];
  if (tracking) {
    const events = strictJsonLines(tracking);
    const track = replayTrack(events);
    if (track.contributionId !== store.contributionId || !isRunContinuation(track.run, store.run))
      refuse();
    for (const event of events) {
      if (event && typeof event === 'object' && 'type' in event && event.type === 'rebound') {
        if (!('evidence' in event)) refuse();
        relocations.push(validateRelocationEvidence(event.evidence));
      }
    }
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
    relocations,
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
/** Verify frozen selected sources, with append-only prefixes for confirmed journals.
 * Current sources are validated separately; a new journal cannot rewrite the old facts. */
export function historicalEvidence(store: RunStore, root: string, snapshot: EvidenceSnapshot) {
  if (!snapshot || typeof snapshot.run !== 'string' || !snapshot.sources)
    refuse('invalid-summary', 'summary');
  const runBytes = Buffer.from(snapshot.run);
  const run = restoreRun(jsonRecord(runBytes));
  store.assertObservationContinuation(run);
  const seen = new Set<string>();
  const facts = contributionEvidence(
    { run, runId: run.runId, contributionId: store.contributionId },
    root,
    undefined,
    (name) => {
      seen.add(name);
      const anchor = snapshot.sources[name];
      if (!anchor) return null;
      if (
        !Number.isSafeInteger(anchor.length) ||
        anchor.length < 0 ||
        !/^[a-f0-9]{64}$/u.test(anchor.digest)
      )
        refuse('invalid-summary', 'summary');
      const current =
        name === 'run.json'
          ? runBytes
          : optionalBytes(root, name, name.endsWith('jsonl') ? JOURNAL_BYTES : undefined);
      if (
        !current ||
        current.length < anchor.length ||
        (!name.endsWith('jsonl') && current.length !== anchor.length)
      )
        refuse('invalid-summary', 'summary');
      const prefix = current.subarray(0, anchor.length);
      if (digest(prefix) !== anchor.digest) refuse('invalid-summary', 'summary');
      return prefix;
    }
  );
  if (Object.keys(snapshot.sources).some((name) => !seen.has(name)))
    refuse('invalid-summary', 'summary');
  return facts;
}
export interface ContributionEvidence {
  relocations: RelocationEvidence[];
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
