/** Verified expected-SHA (CAS) push of the receipt-bound candidate to the contributor fork
 * (#1066; PRD §5.7, §5.9 "Push candidate"; decision record rows 4/4b; scenarios 10, 17, 18).
 * Controller-only: it handles the broker's push credential, so worker-facing code and the
 * package index never import it.
 *
 * One attempt: authorize (verify the receipt, burn its single-use nonce) → persist branch,
 * candidate and expected remote SHA → preflight the remote ref → push exactly the candidate
 * with `--force-with-lease=refs/heads/<branch>:<expected>` under a broker lease → read the
 * ref back from the git server. Only a read-back equal to the candidate confirms the push. */
import type { CanonicalCandidate } from '../canonical/reconstruct';
import { type GitResult, TrustedGit } from '../canonical/trusted-git';
import {
  type Intent,
  type IntentInput,
  idempotencyKey,
  MAX_ATTEMPT_SEQUENCE,
  MutationDeferredError,
  type MutationResult,
  MutationVoidedError,
  ReconcileDeferredError,
  type ReconcileResult,
  type WriteAdapter,
  WriteRefusedError,
} from '../intents';
import type { SignedReceipt } from '../receipt/issue';
import type { ReceiptNonceStore } from '../receipt/nonces';
import { ReceiptError } from '../receipt/schema';
import { authorizeShipping, type ReceiptContext } from '../receipt/verify';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import { isRecord } from '../state';
import type { ForkCredentialBroker } from './broker';
import {
  type ForkBranch,
  type ForkRef,
  ForkRefError,
  isCommitSha,
  parseForkTarget,
  readForkBranch,
} from './fork-ref';
import type { HandoffAdmission } from './handoff-driver';
import type { GitHubRead } from './reconcile';
import type { TokenStore } from './token-journal';

const PUSH_TIMEOUT_MS = 120_000;
/** Nonce-store refusals that say nothing about the receipt. Every one is raised before the
 * store appends (lock busy, unreadable or poisoned store), so no nonce was consumed and
 * the attempt is withdrawn. A failed append itself surfaces as a plain error: ambiguous. */
const STORE_FAILURES = Object.freeze([
  'store_locked',
  'persistence_uncertain',
  'corrupt_store',
  'missing_store',
  'unsafe_store',
]);

export class ForkPushError extends Error {
  constructor(
    readonly code:
      | 'not_a_push'
      | 'invalid_candidate'
      | 'invalid_ledger'
      | 'unverified_remote'
      | 'push_uncertain',
    /** Secret-free: a git outcome (`rejected`, `killed`, …) or a ledger position. */
    readonly detail?: string
  ) {
    super(`Fork push refused: ${code}${detail ? ` (${detail})` : ''}`);
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

/** Its own durable store (a `Journal` in a controller directory), owned by one controller. */
export type PushLedgerStore = TokenStore;

export interface ForkPusherOptions {
  readonly broker: Pick<ForkCredentialBroker, 'withForkPush'>;
  /** Credential-free reader (`anonymousReader`). */
  readonly read: GitHubRead;
  readonly fork: ForkRef;
  readonly ledger: PushLedgerStore;
  readonly trustedControllerKey: string;
  readonly nonces: ReceiptNonceStore;
  /** Supplies the receipt, context and candidate for the attempt being made. */
  readonly authorize: (intent: Intent) => Promise<ShippingAuthorization>;
  readonly now?: () => number;
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
  | ({ v: 1; type: 'push_intended'; key: string; repositoryId: number } & Intended)
  | {
      v: 1;
      type: 'push_verified';
      key: string;
      repositoryId: number;
      branch: string;
      remoteSha: string;
    };

function intendedValid(e: Record<string, unknown>, prior: Intended | undefined): boolean {
  if (
    !Number.isSafeInteger(e.attempt) ||
    (e.attempt as number) < 1 ||
    (e.attempt as number) > MAX_ATTEMPT_SEQUENCE ||
    typeof e.branch !== 'string' ||
    !isCommitSha(e.candidateSha) ||
    !(e.expectedRemoteSha === null || isCommitSha(e.expectedRemoteSha))
  )
    return false;
  // A retry repeats its first attempt's values exactly.
  return (
    !prior ||
    (prior.attempt < (e.attempt as number) &&
      prior.branch === e.branch &&
      prior.candidateSha === e.candidateSha &&
      prior.expectedRemoteSha === e.expectedRemoteSha)
  );
}

/** Replays one fork's ledger; an event for any other repository id is corruption. */
export function replayPushes(events: readonly unknown[], repositoryId: number): PushLedger {
  const intended = new Map<string, Intended>();
  const verified = new Map<string, string>();
  events.forEach((e, index) => {
    if (isRecoveryEvent(e)) return;
    const invalid = () => {
      throw new ForkPushError('invalid_ledger', `event ${index}`);
    };
    if (!isRecord(e) || e.v !== 1 || typeof e.key !== 'string' || e.repositoryId !== repositoryId)
      invalid();
    const event = e as Record<string, unknown> & { key: string };
    const prior = intended.get(event.key);
    if (event.type === 'push_intended') {
      if (!intendedValid(event, prior)) invalid();
      const { attempt, branch, candidateSha, expectedRemoteSha } = event as unknown as Intended;
      intended.set(event.key, Object.freeze({ attempt, branch, candidateSha, expectedRemoteSha }));
    } else if (event.type === 'push_verified') {
      if (
        typeof event.branch !== 'string' ||
        !isCommitSha(event.remoteSha) ||
        (prior && (prior.branch !== event.branch || prior.candidateSha !== event.remoteSha))
      )
        invalid();
      verified.set(event.branch as string, event.remoteSha as string);
    } else invalid();
  });
  return { intended, verified };
}

/** Outcome of the push plus the server's own answer for the ref (`undefined`: unknown). */
interface PushOutcome {
  readonly git: 'pushed' | 'rejected' | 'failed' | 'killed';
  readonly remote: string | null | undefined;
}

export class ForkPusher implements WriteAdapter {
  private readonly now: () => number;
  constructor(private readonly options: ForkPusherOptions) {
    this.now = options.now ?? Date.now;
    // Fail closed at startup on a corrupt or foreign ledger.
    this.snapshot();
  }

  snapshot(): PushLedger {
    return replayPushes(this.options.ledger.read(), this.options.fork.repositoryId);
  }

  private record(event: PushEvent): void {
    assertNoSecrets(JSON.stringify(event));
    replayPushes([...this.options.ledger.read(), event], this.options.fork.repositoryId);
    this.options.ledger.append(event);
  }

  private target(intent: IntentInput): { at: ForkBranch; sha: string } {
    if (intent.operationKind !== 'push_branch' || !isCommitSha(intent.candidateSha))
      throw new ForkPushError('not_a_push');
    return { at: parseForkTarget(intent.target, this.options.fork), sha: intent.candidateSha };
  }

  /** Absent, or the SHA the last verified push left on this branch. A retry keeps the
   * value persisted by its first attempt. The controller puts this in the receipt grant. */
  expectedRemoteSha(intent: IntentInput): string | null {
    const { at } = this.target(intent);
    const ledger = this.snapshot();
    const persisted = ledger.intended.get(idempotencyKey(intent));
    if (persisted) return persisted.expectedRemoteSha;
    return ledger.verified.get(at.branch) ?? null;
  }

  /** The fork branch read back from the remote, null when absent. A present SHA that no
   * verified push left there is refused. */
  async remoteBranchSha(target: string): Promise<string | null> {
    const at = parseForkTarget(target, this.options.fork);
    const remote = await readForkBranch(this.options.read, at);
    if (remote === null) return null;
    if (this.snapshot().verified.get(at.branch) !== remote)
      throw new ForkPushError('unverified_remote');
    return remote;
  }

  /** `HandoffAdmission.remoteBranchSha` (#1067) for the PR hand-off of `target`. */
  handoffReadBack(target: string): HandoffAdmission['remoteBranchSha'] {
    parseForkTarget(target, this.options.fork);
    return () => this.remoteBranchSha(target);
  }

  /** Lost push response (scenario 18): the remote ref decides. */
  async reconcile(intent: Intent): Promise<ReconcileResult> {
    const { at, sha } = this.target(intent);
    const expected = this.expectedRemoteSha(intent);
    let remote: string | null;
    try {
      remote = await this.readRef(at);
    } catch (error) {
      // Rate limit, 5xx, network: nothing is known yet, so nothing is decided.
      if (error instanceof ForkRefError) throw new ReconcileDeferredError(refFailure(error));
      throw error;
    }
    if (remote === sha) return { kind: 'found', ...this.verified(intent, at, sha) };
    // Nothing of ours landed: the driver admits exactly one retry.
    if (remote === expected) return { kind: 'absent' };
    throw diverged(expected, remote);
  }

  async mutate(intent: Intent): Promise<MutationResult> {
    const { at, sha } = this.target(intent);
    const expected = this.expectedRemoteSha(intent);
    // Preflight first: a transient read failure here has sent and consumed nothing.
    let before: string | null;
    try {
      before = await this.readRef(at);
    } catch (error) {
      if (error instanceof ForkRefError) throw new MutationDeferredError(refFailure(error));
      throw error;
    }
    if (before === sha) return this.verified(intent, at, sha);
    if (before !== expected) throw diverged(expected, before);
    const candidate = await this.admit(intent, sha, expected);
    // Write-ahead: a crash from here on is reconciled against these values.
    this.record({
      v: 1,
      type: 'push_intended',
      key: intent.key,
      repositoryId: at.fork.repositoryId,
      attempt: intent.attempts,
      branch: at.branch,
      candidateSha: sha,
      expectedRemoteSha: expected,
    });
    let handedOut = false;
    let outcome: PushOutcome;
    try {
      outcome = await this.options.broker.withForkPush(
        intent,
        { repositoryId: at.fork.repositoryId },
        (credential, signal) => {
          handedOut = true;
          return this.casPush(candidate, at, expected, credential.env(), signal);
        }
      );
    } catch (error) {
      // No credential ever reached git (the mint failed, was refused, or was cancelled), so
      // nothing can have been pushed. The nonce and this attempt's mint slot are spent: void
      // the attempt; the next one needs a fresh receipt but keeps the retry budget.
      if (!handedOut) throw new MutationVoidedError(voidReason(error));
      throw error;
    }
    if (outcome.remote === sha) return this.verified(intent, at, sha);
    if (outcome.remote !== undefined && outcome.remote !== expected)
      throw diverged(expected, outcome.remote);
    // Unknown, or still at the expected value (nothing landed): reconciliation decides.
    throw new ForkPushError('push_uncertain', outcome.git);
  }

  /** A readable answer naming another repository is positive evidence and blocks; any
   * other read failure (ForkRefError) leaves the decision to a later read. */
  private async readRef(at: ForkBranch): Promise<string | null> {
    try {
      return await readForkBranch(this.options.read, at);
    } catch (error) {
      if (error instanceof ForkRefError && error.code === 'fork_unverified' && error.status === 200)
        throw new WriteRefusedError('fork_unverified', `${at.fork.owner}/${at.fork.repo}`);
      throw error;
    }
  }

  /** Scenarios 10 and 17: every refusal happens here, before a token is minted. */
  private async admit(
    intent: Intent,
    sha: string,
    expected: string | null
  ): Promise<CanonicalCandidate> {
    let authorization: ShippingAuthorization;
    try {
      authorization = await this.options.authorize(intent);
    } catch (error) {
      // The controller could not produce one: no nonce was touched.
      throw new MutationDeferredError(`authorize:${(error as Error)?.name ?? 'Error'}`);
    }
    const { receipt, context, candidate } = authorization;
    try {
      // Only the reconstructed, receipt-bound candidate on the verified parent ships.
      if (
        candidate.record.candidateSha !== sha ||
        context.candidateSha !== sha ||
        candidate.record.baseSha !== context.parentSha ||
        context.forkRepositoryId !== this.options.fork.repositoryId
      )
        throw new ForkPushError('invalid_candidate');
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
    } catch (error) {
      if (error instanceof ReceiptError)
        throw STORE_FAILURES.includes(error.code)
          ? new MutationDeferredError(error.code)
          : new WriteRefusedError('authorization_refused', error.code);
      if (error instanceof ForkPushError)
        throw new WriteRefusedError('authorization_refused', error.code);
      throw error;
    }
  }

  /** One push of exactly the candidate, then the git server's answer for the ref. No
   * remotes, no wildcards, no plain force: the lease names the only value it may replace. */
  private async casPush(
    candidate: CanonicalCandidate,
    at: ForkBranch,
    expected: string | null,
    credentialEnv: Readonly<Record<string, string>>,
    signal: AbortSignal
  ): Promise<PushOutcome> {
    const sha = candidate.record.candidateSha;
    const ref = `refs/heads/${at.branch}`;
    const git = new TrustedGit();
    try {
      git.run(['index-pack', '--stdin', '--strict'], candidate.pack);
      if (git.run(['cat-file', '-t', sha]).toString().trim() !== 'commit')
        throw new ForkPushError('invalid_candidate');
      const { url, config } = this.remote(at);
      const options = { env: credentialEnv, config, signal, timeoutMs: PUSH_TIMEOUT_MS };
      const push = await git.execAsync(
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          `--force-with-lease=${ref}:${expected ?? ''}`,
          url,
          `${sha}:${ref}`,
        ],
        options
      );
      // The git server, not the API, answers the read-back: no cache can trail the push.
      const listed = signal.aborted
        ? undefined
        : await git.execAsync(['ls-remote', url, ref], options);
      return { git: pushOutcome(push, ref), remote: listed && lsRemote(listed, ref) };
    } finally {
      git.close();
    }
  }

  /** The fork's push URL; tests substitute a local bare repository. The URL names the
   * fork by owner/name, which the preflight bound to the repository id moments before.
   * The push itself is pinned to that id by the credential: the broker narrows the token
   * to exactly that repository, so if the name were renamed or transferred to another
   * repository in between, GitHub refuses the push (403) and the read-back stays put. */
  protected remote(at: ForkBranch): { url: string; config: readonly string[] } {
    return { url: `https://github.com/${at.fork.owner}/${at.fork.repo}.git`, config: [] };
  }

  private verified(intent: Intent, at: ForkBranch, sha: string): MutationResult {
    if (this.snapshot().verified.get(at.branch) !== sha)
      this.record({
        v: 1,
        type: 'push_verified',
        key: intent.key,
        repositoryId: at.fork.repositoryId,
        branch: at.branch,
        remoteSha: sha,
      });
    return { artifactRef: `${intent.target}@${sha}`, remoteSha: sha };
  }
}

/** A broker refusal code, or the error's name: secret-free either way. */
function voidReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const name = error instanceof Error ? error.name : 'unknown';
  const reason = `mint:${typeof code === 'string' ? code : name}`.toLowerCase();
  return /^[a-z_:0-9]{1,64}$/u.test(reason) ? reason : 'mint:failed';
}

function refFailure(error: ForkRefError): string {
  return `${error.code}${error.status === undefined ? '' : `:${error.status}`}`;
}

function diverged(expected: string | null, observed: string | null): WriteRefusedError {
  return new WriteRefusedError(
    'remote_diverged',
    `expected=${expected ?? 'absent'},observed=${observed ?? 'absent'}`
  );
}

/** `--porcelain` flags: `!` rejected (stale lease, protected branch), `=` up to date. */
function pushOutcome(push: GitResult, ref: string): PushOutcome['git'] {
  if (push.status === null) return 'killed';
  const line = push.stdout
    .toString()
    .split('\n')
    .find((l) => l.split('\t')[1]?.endsWith(`:${ref}`));
  if (line?.startsWith('!')) return 'rejected';
  return push.status === 0 ? 'pushed' : 'failed';
}

function lsRemote(listed: GitResult, ref: string): string | null | undefined {
  if (listed.status !== 0) return undefined;
  const lines = listed.stdout.toString().split('\n').filter(Boolean);
  const match = lines.map((l) => l.split('\t')).filter(([, name]) => name === ref);
  if (!match.length) return null;
  const sha = match.length === 1 ? match[0]?.[0] : undefined;
  return isCommitSha(sha) ? sha : undefined;
}
