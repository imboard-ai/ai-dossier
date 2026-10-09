import {
  type AcquiredSource,
  resolveBase,
  type SourceGitHubRead,
  type SourceUpstream,
} from '../canonical/acquire';
import {
  CanonicalError,
  comparePaths,
  createManifest,
  parentPaths,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../canonical/export';
import {
  baseManifest,
  type CanonicalCandidate,
  type CommitInputs,
  createCandidate,
} from '../canonical/reconstruct';
import { assertNoSecrets } from '../redaction';
import { ReasonCode, type RunRecord, restoreRun, transitionRun } from '../state';
import { WorkspaceOverlay } from './workspace-overlay';

export type BaseCheck =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'advanced'; readonly newSha: string }
  | { readonly kind: 'unknown' };
function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

/** One credential-free read. Invalid facts and failed reads never admit a push. */
export async function checkBase(
  read: SourceGitHubRead,
  upstream: SourceUpstream & { readonly defaultBranch: string },
  verifiedBaseSha: string
): Promise<BaseCheck> {
  try {
    if (!validSha(verifiedBaseSha)) return Object.freeze({ kind: 'unknown' });
    const current = await resolveBase(read, upstream);
    return Object.freeze(
      current === verifiedBaseSha ? { kind: 'unchanged' } : { kind: 'advanced', newSha: current }
    );
  } catch {
    return Object.freeze({ kind: 'unknown' });
  }
}

export interface RebaseInput {
  readonly overlay: WorkspaceOverlay;
  readonly oldBaseManifest: SourceManifest;
  readonly newBase: AcquiredSource;
  /** Same recorded author/message, NEW parent and controller clock timestamp. */
  readonly approval: CommitInputs;
}
export type RebaseResult =
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  | {
      readonly kind: 'rebased';
      readonly candidate: CanonicalCandidate;
      readonly manifest: SourceManifest;
      readonly overlay: WorkspaceOverlay;
    };

/** No text merging, guest reads, receipt reuse or publication. */
export function rebaseCandidate(input: RebaseInput): RebaseResult {
  const oldBase = validateManifest(input.oldBaseManifest);
  if (oldBase.digest !== input.overlay.base.digest) throw new CanonicalError('tree_mismatch');
  const nextBase = validateManifest(input.newBase.manifest);
  const pack = Buffer.from(input.newBase.pack);
  if (baseManifest(pack, input.approval.baseSha).digest !== nextBase.digest)
    throw new CanonicalError('tree_mismatch');
  const oldEntries = new Map(oldBase.entries.map((entry) => [entry.path, entry]));
  const nextEntries = new Map(nextBase.entries.map((entry) => [entry.path, entry]));
  const writes = input.overlay.writtenEntries();
  const conflicts = writes
    .filter((entry) => {
      assertNoSecrets(entry.path);
      const old = oldEntries.get(entry.path);
      const next = nextEntries.get(entry.path);
      return (
        old?.sha256 !== next?.sha256 ||
        old?.mode !== next?.mode ||
        parentPaths(entry.path).some((parent) => {
          const ancestor = nextEntries.get(parent);
          return ancestor !== undefined && ancestor.mode !== '040000';
        })
      );
    })
    .map((entry) => entry.path)
    .sort(comparePaths);
  if (conflicts.length) return Object.freeze({ kind: 'conflict', paths: Object.freeze(conflicts) });
  for (const entry of writes) {
    for (const parent of parentPaths(entry.path))
      if (!nextEntries.has(parent))
        nextEntries.set(parent, { path: parent, mode: '040000', bytes: '', sha256: sha256('') });
    nextEntries.set(entry.path, entry);
  }
  const manifest = createManifest([...nextEntries.values()]);
  const candidate = createCandidate(manifest, input.approval, pack);
  const overlay = new WorkspaceOverlay(nextBase);
  for (const entry of writes)
    overlay.write(entry.path, Buffer.from(entry.bytes, 'base64').toString('utf8'));
  return Object.freeze({ kind: 'rebased', candidate, manifest, overlay });
}

export const MAX_SESSION_REBASES = 2;
export interface DriftObservation {
  readonly verifiedBase: string;
  readonly currentBase: string | null;
  readonly limitation: string;
}
export interface ShippingBaseInput {
  readonly run: RunRecord;
  readonly overlay: WorkspaceOverlay;
  readonly approval: CommitInputs;
  /** Durable session-wide count; unchanged checks do not reset it. */
  readonly rebases: number;
  /** True as soon as THIS candidate's push intent is journaled, not just after success. */
  readonly pushIntentJournaled: boolean;
}
export interface ShippingBaseDeps {
  readonly read: SourceGitHubRead;
  readonly upstream: SourceUpstream & { readonly defaultBranch: string };
  readonly acquire: (baseSha: string) => AcquiredSource;
  readonly now: () => Date;
}
export type ShippingBaseResult =
  | { readonly kind: 'unchanged'; readonly run: RunRecord; readonly rebases: number }
  | { readonly kind: 'recorded'; readonly run: RunRecord; readonly observation: DriftObservation }
  | {
      readonly kind: 'hand_off';
      readonly reason: 'base_unknown' | 'base_unstable' | 'rebase_conflict' | 'rebase_unavailable';
      readonly paths?: readonly string[];
    }
  | (Extract<RebaseResult, { kind: 'rebased' }> & {
      readonly run: RunRecord;
      readonly rebases: number;
    });

/** Called before initial push AND shipRevision. Caller persists the returned candidate,
 * overlay, run and session count before verification; only unchanged admits proceeding
 * to receipt authorization. A recorded observation never authorizes a new push. */
export async function checkShippingBase(
  deps: ShippingBaseDeps,
  input: ShippingBaseInput
): Promise<ShippingBaseResult> {
  const run = restoreRun(input.run);
  if (
    !['shipping', 'awaiting_contributor'].includes(run.state) ||
    !Number.isSafeInteger(input.rebases) ||
    input.rebases < 0 ||
    input.rebases > MAX_SESSION_REBASES ||
    typeof input.pushIntentJournaled !== 'boolean' ||
    !validSha(input.approval.baseSha)
  )
    throw new CanonicalError('invalid_manifest');
  const verifiedBase = input.approval.baseSha;
  const check = await checkBase(deps.read, deps.upstream, verifiedBase);
  if (input.pushIntentJournaled || run.state === 'awaiting_contributor') {
    const currentBase =
      check.kind === 'advanced' ? check.newSha : check.kind === 'unchanged' ? verifiedBase : null;
    return Object.freeze({
      kind: 'recorded',
      run,
      observation: Object.freeze({
        verifiedBase,
        currentBase,
        limitation: `Verified base ${verifiedBase}; current base ${currentBase ?? 'unknown'}. The current merge result has not been verified.`,
      }),
    });
  }
  if (check.kind === 'unknown') return Object.freeze({ kind: 'hand_off', reason: 'base_unknown' });
  if (check.kind === 'unchanged')
    return Object.freeze({ kind: 'unchanged', run, rebases: input.rebases });
  if (input.rebases >= MAX_SESSION_REBASES)
    return Object.freeze({ kind: 'hand_off', reason: 'base_unstable' });
  try {
    const now = deps.now();
    const timestamp = now.toISOString();
    if (timestamp <= `${input.approval.committerTimestamp.slice(0, -1)}.000Z`)
      throw new CanonicalError('altered_identity');
    const rebased = rebaseCandidate({
      overlay: input.overlay,
      oldBaseManifest: input.overlay.base,
      newBase: deps.acquire(check.newSha),
      approval: {
        ...input.approval,
        baseSha: check.newSha,
        committerTimestamp: timestamp.replace(/\.\d{3}Z$/u, 'Z'),
      },
    });
    if (rebased.kind === 'conflict')
      return Object.freeze({ kind: 'hand_off', reason: 'rebase_conflict', paths: rebased.paths });
    return Object.freeze({
      ...rebased,
      run: transitionRun(run, ReasonCode.BaseAdvanced, timestamp),
      rebases: input.rebases + 1,
    });
  } catch {
    return Object.freeze({ kind: 'hand_off', reason: 'rebase_unavailable' });
  }
}
