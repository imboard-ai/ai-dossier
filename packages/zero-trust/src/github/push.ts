/** Verified expected-SHA (CAS) push of the receipt-bound candidate to the contributor fork
 * (#1066; PRD §5.7, §5.9 "Push candidate"; decision record rows 4/4b; scenarios 10, 17, 18).
 * Controller-only: it handles the broker's push credential, so worker-facing code and the
 * package index never import it.
 *
 * One attempt: authorize (verify the receipt, burn its single-use nonce) → persist branch,
 * candidate and expected remote SHA → preflight the remote ref → push exactly the candidate
 * with `--force-with-lease=refs/heads/<branch>:<expected>` under a broker lease → read the
 * ref back. Only a read-back equal to the candidate confirms the push. */
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalCandidate } from '../canonical/reconstruct';
import { TrustedGit } from '../canonical/trusted-git';
import {
  type Intent,
  type IntentInput,
  idempotencyKey,
  type MutationResult,
  type ReconcileResult,
  type WriteAdapter,
  WriteRefusedError,
} from '../intents';
import type { SignedReceipt } from '../receipt/issue';
import type { ReceiptNonceStore } from '../receipt/nonces';
import { authorizeShipping, type ReceiptContext } from '../receipt/verify';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import type { ForkCredentialBroker } from './broker';
import {
  type ForkBranch,
  ForkRefError,
  type ForkRepository,
  parseForkTarget,
  readForkBranch,
} from './fork-ref';
import type { GitHubRead } from './reconcile';

/** Re-reads while the remote still shows the expected SHA after git reported success:
 * GitHub's API can trail a push briefly. Exhausting them leaves the push ambiguous. */
export const READ_BACK_DELAYS_MS: readonly number[] = Object.freeze([1000, 3000]);
const PUSH_TIMEOUT_MS = 120_000;
const SHA = /^[a-f0-9]{40}$/u;

export class ForkPushError extends Error {
  constructor(
    readonly code: 'not_a_push' | 'invalid_ledger' | 'unverified_remote' | 'push_uncertain'
  ) {
    super(`Fork push refused: ${code}`);
    this.name = 'ForkPushError';
  }
}

/** What admits one push attempt. A retry needs a fresh receipt: its nonce is single-use. */
export interface ShippingAuthorization {
  readonly receipt: SignedReceipt;
  /** Fresh controller facts (policy, bindings, allowlist) for this attempt. */
  readonly context: ReceiptContext;
  /** The reconstructed candidate (#1007); the push repository holds only its objects. */
  readonly candidate: CanonicalCandidate;
}

/** A durable store of its own; satisfied by `Journal` in a controller directory. */
export interface PushLedgerStore {
  read(): unknown[];
  append(event: unknown): void;
}

export interface ForkPusherOptions {
  readonly broker: Pick<ForkCredentialBroker, 'withForkPush'>;
  /** Credential-free reader (`anonymousReader`). */
  readonly read: GitHubRead;
  readonly fork: ForkRepository;
  readonly ledger: PushLedgerStore;
  readonly trustedControllerKey: string;
  readonly nonces: ReceiptNonceStore;
  /** Supplies the receipt, context and candidate for the attempt being made. */
  readonly authorize: (intent: Intent) => Promise<ShippingAuthorization>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Tests only: an absolute path to a local bare repository that stands in for the fork. */
  readonly localRemote?: string;
}

interface Intended {
  readonly attempt: number;
  readonly branch: string;
  readonly candidateSha: string;
  readonly expectedRemoteSha: string | null;
}
export interface PushLedger {
  /** By intent key: the last persisted attempt. */
  readonly intended: ReadonlyMap<string, Intended>;
  /** By branch: the last SHA a read-back confirmed. */
  readonly verified: ReadonlyMap<string, string>;
}
type PushEvent =
  | ({ v: 1; type: 'push_intended'; key: string } & Intended)
  | { v: 1; type: 'push_verified'; key: string; branch: string; remoteSha: string };

function invalid(): never {
  throw new ForkPushError('invalid_ledger');
}

export function replayPushes(events: readonly unknown[]): PushLedger {
  const intended = new Map<string, Intended>();
  const verified = new Map<string, string>();
  for (const raw of events) {
    if (isRecoveryEvent(raw)) continue;
    const e = raw as PushEvent;
    if (typeof e !== 'object' || e === null || e.v !== 1 || typeof e.key !== 'string') invalid();
    const prior = intended.get(e.key);
    if (e.type === 'push_intended') {
      if (
        !Number.isSafeInteger(e.attempt) ||
        e.attempt < 1 ||
        e.attempt > 2 ||
        (prior ? prior.attempt >= e.attempt : false) ||
        typeof e.branch !== 'string' ||
        typeof e.candidateSha !== 'string' ||
        !SHA.test(e.candidateSha) ||
        !(e.expectedRemoteSha === null || SHA.test(e.expectedRemoteSha ?? '')) ||
        (prior &&
          (prior.branch !== e.branch ||
            prior.candidateSha !== e.candidateSha ||
            prior.expectedRemoteSha !== e.expectedRemoteSha))
      )
        invalid();
      const { attempt, branch, candidateSha, expectedRemoteSha } = e;
      intended.set(e.key, Object.freeze({ attempt, branch, candidateSha, expectedRemoteSha }));
    } else if (e.type === 'push_verified') {
      if (
        typeof e.branch !== 'string' ||
        typeof e.remoteSha !== 'string' ||
        !SHA.test(e.remoteSha) ||
        (prior && (prior.branch !== e.branch || prior.candidateSha !== e.remoteSha))
      )
        invalid();
      verified.set(e.branch, e.remoteSha);
    } else invalid();
  }
  return { intended, verified };
}

export class ForkPusher implements WriteAdapter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly options: ForkPusherOptions) {
    if (options.localRemote !== undefined && !path.isAbsolute(options.localRemote))
      throw new ForkPushError('not_a_push');
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ledger();
  }

  ledger(): PushLedger {
    return replayPushes(this.options.ledger.read());
  }

  private record(event: PushEvent): void {
    assertNoSecrets(JSON.stringify(event));
    replayPushes([...this.options.ledger.read(), event]);
    this.options.ledger.append(event);
  }

  private target(intent: Intent | IntentInput): ForkBranch {
    if (intent.operationKind !== 'push_branch' || intent.candidateSha === null)
      throw new ForkPushError('not_a_push');
    return parseForkTarget(intent.target, this.options.fork);
  }

  /** Absent, or the SHA the last verified push left on this branch. A retry keeps the
   * value persisted by its first attempt. The controller puts this in the receipt grant. */
  expectedRemoteSha(intent: IntentInput): string | null {
    const at = this.target(intent);
    const ledger = this.ledger();
    const persisted = ledger.intended.get(idempotencyKey(intent));
    if (persisted) return persisted.expectedRemoteSha;
    return ledger.verified.get(at.branch) ?? null;
  }

  /** `HandoffAdmission.remoteBranchSha` (#1067): the fork branch read back from the remote,
   * null when absent. A present SHA that no verified push left there is refused. */
  async remoteBranchSha(target: string): Promise<string | null> {
    const at = parseForkTarget(target, this.options.fork);
    const remote = await readForkBranch(this.options.read, at);
    if (remote === null) return null;
    if (this.ledger().verified.get(at.branch) !== remote)
      throw new ForkPushError('unverified_remote');
    return remote;
  }

  /** Lost push response (scenario 18): the remote ref decides. */
  async reconcile(intent: Intent): Promise<ReconcileResult> {
    const at = this.target(intent);
    const expected = this.expectedRemoteSha(intent);
    let remote: string | null;
    try {
      remote = await readForkBranch(this.options.read, at);
    } catch (error) {
      if (error instanceof ForkRefError) return { kind: 'unknown' };
      throw error;
    }
    if (remote === intent.candidateSha) return { kind: 'found', ...this.verified(intent, at) };
    // Nothing of ours landed: the driver admits exactly one retry.
    if (remote === expected) return { kind: 'absent' };
    throw new WriteRefusedError('remote_diverged');
  }

  async mutate(intent: Intent): Promise<MutationResult> {
    const at = this.target(intent);
    const sha = intent.candidateSha as string;
    const expected = this.expectedRemoteSha(intent);
    const candidate = await this.admit(intent, expected);
    // Write-ahead: a crash from here on is reconciled against these values.
    this.record({
      v: 1,
      type: 'push_intended',
      key: intent.key,
      attempt: intent.attempts,
      branch: at.branch,
      candidateSha: sha,
      expectedRemoteSha: expected,
    });
    const before = await readForkBranch(this.options.read, at);
    if (before === sha) return this.verified(intent, at);
    if (before !== expected) throw new WriteRefusedError('remote_diverged');
    const status = await this.options.broker.withForkPush(
      intent,
      { repositoryId: at.fork.repositoryId },
      async (credential, signal) => {
        if (signal.aborted) throw new ForkPushError('push_uncertain');
        return this.casPush(candidate, at, expected, credential.env());
      }
    );
    return this.readBack(intent, at, expected, status === 0);
  }

  /** Scenarios 10 and 17: every refusal happens here, before a token is minted. */
  private async admit(intent: Intent, expected: string | null): Promise<CanonicalCandidate> {
    try {
      const { receipt, context, candidate } = await this.options.authorize(intent);
      const record = candidate?.record;
      // Only the reconstructed, receipt-bound candidate on the verified parent ships.
      if (
        record?.candidateSha !== intent.candidateSha ||
        context.candidateSha !== intent.candidateSha ||
        record.baseSha !== context.parentSha ||
        context.forkRepositoryId !== this.options.fork.repositoryId
      )
        throw new ForkPushError('not_a_push');
      await authorizeShipping(
        receipt,
        this.options.trustedControllerKey,
        context,
        intent,
        expected,
        this.options.nonces,
        this.now
      );
      return candidate;
    } catch {
      throw new WriteRefusedError('authorization_refused');
    }
  }

  /** Exit status of one push of exactly the candidate. No remotes, no wildcards, no
   * plain force: the lease names the only remote value the update may replace. */
  private casPush(
    candidate: CanonicalCandidate,
    at: ForkBranch,
    expected: string | null,
    credentialEnv: Readonly<Record<string, string>>
  ): number | null {
    const sha = candidate.record.candidateSha;
    const git = new TrustedGit();
    try {
      git.run(['index-pack', '--stdin', '--strict'], candidate.pack);
      if (git.run(['cat-file', '-t', sha]).toString().trim() !== 'commit')
        throw new ForkPushError('not_a_push');
      const local = this.options.localRemote;
      const url = local
        ? `file://${fs.realpathSync(local)}`
        : `https://github.com/${at.fork.owner}/${at.fork.name}.git`;
      const ref = `refs/heads/${at.branch}`;
      return git.exec(
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          `--force-with-lease=${ref}:${expected ?? ''}`,
          url,
          `${sha}:${ref}`,
        ],
        {
          env: credentialEnv,
          config: local ? ['protocol.file.allow=always'] : [],
          timeoutMs: PUSH_TIMEOUT_MS,
        }
      ).status;
    } finally {
      git.close();
    }
  }

  /** Confirms only a remote equal to the candidate; anything else fails closed. */
  private async readBack(
    intent: Intent,
    at: ForkBranch,
    expected: string | null,
    reportedPushed: boolean
  ): Promise<MutationResult> {
    const delays = reportedPushed ? READ_BACK_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      const remote = await readForkBranch(this.options.read, at);
      if (remote === intent.candidateSha) return this.verified(intent, at);
      if (remote !== expected) throw new WriteRefusedError('remote_diverged');
      const delay = delays[attempt];
      // Still at the expected value: nothing landed, or the read trails. Reconcile decides.
      if (delay === undefined) throw new ForkPushError('push_uncertain');
      await this.sleep(delay);
    }
  }

  private verified(intent: Intent, at: ForkBranch): MutationResult {
    const sha = intent.candidateSha as string;
    if (this.ledger().verified.get(at.branch) !== sha)
      this.record({
        v: 1,
        type: 'push_verified',
        key: intent.key,
        branch: at.branch,
        remoteSha: sha,
      });
    return { artifactRef: `${intent.target}@${sha}`, remoteSha: sha };
  }
}
