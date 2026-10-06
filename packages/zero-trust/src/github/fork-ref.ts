/** Credential-free reads of the contributor fork's branch ref (PRD §5.7 "credential-free
 * reconciliation reads"; decision record row 4b). The fork is named by repository id: a
 * read is answered only after GitHub confirms that owner/name still resolves to that id. */
import { isRecord } from '../state';
import type { ForkRepository } from './fork';
import { isGitHubLogin, isRepoName, isSafeRef } from './handoff';
import type { GitHubRead } from './reconcile';

export class ForkRefError extends Error {
  constructor(
    readonly code: 'invalid_target' | 'fork_unverified' | 'ref_unknown',
    /** The HTTP status that caused it, when one was received (rate limit, 5xx, …). */
    readonly status?: number
  ) {
    super(`Fork ref read refused: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'ForkRefError';
  }
}

/** The verified fork (#1065's `ForkRepository`/`ForkReady`), the only push target. */
export type ForkRef = Pick<ForkRepository, 'repositoryId' | 'owner' | 'repo'>;
export interface ForkBranch {
  readonly fork: ForkRef;
  readonly branch: string;
}

/** `push_branch` intent targets name the fork by id: `fork:<repositoryId>:branch:<name>`. */
const TARGET = /^fork:([1-9][0-9]{0,15}):branch:(.+)$/u;

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function forkRepository(fork: ForkRef): ForkRef {
  if (
    !fork ||
    !Number.isSafeInteger(fork.repositoryId) ||
    fork.repositoryId <= 0 ||
    !isGitHubLogin(fork.owner) ||
    !isRepoName(fork.repo)
  )
    throw new ForkRefError('invalid_target');
  return Object.freeze({ repositoryId: fork.repositoryId, owner: fork.owner, repo: fork.repo });
}

/** The journaled `push_branch` target for a branch of the verified fork. */
export function forkTarget(fork: ForkRef, branch: string): string {
  if (!isSafeRef(branch)) throw new ForkRefError('invalid_target');
  return `fork:${forkRepository(fork).repositoryId}:branch:${branch}`;
}

/** Parses a journaled target; it must name exactly the bound fork. */
export function parseForkTarget(target: string, fork: ForkRef): ForkBranch {
  const bound = forkRepository(fork);
  const match = typeof target === 'string' ? TARGET.exec(target) : null;
  if (!match || Number(match[1]) !== bound.repositoryId || !isSafeRef(match[2]))
    throw new ForkRefError('invalid_target');
  return Object.freeze({ fork: bound, branch: match[2] as string });
}

async function get(read: GitHubRead, path: string) {
  try {
    return await read(path);
  } catch {
    throw new ForkRefError('ref_unknown');
  }
}

/** The branch's commit SHA on the fork, or null when the branch does not exist. Anything
 * else (wrong repository id, rate limit, malformed answer) throws: never a guess. */
export async function readForkBranch(read: GitHubRead, at: ForkBranch): Promise<string | null> {
  const fork = forkRepository(at.fork);
  if (!isSafeRef(at.branch)) throw new ForkRefError('invalid_target');
  const repo = `/repos/${encodeURIComponent(fork.owner)}/${encodeURIComponent(fork.repo)}`;
  const identity = await get(read, repo);
  if (identity.status !== 200 || !isRecord(identity.body) || identity.body.id !== fork.repositoryId)
    throw new ForkRefError('fork_unverified', identity.status);
  const ref = `refs/heads/${at.branch}`;
  // The endpoint takes `heads/<branch>`; the answer names the full ref.
  const answer = await get(
    read,
    `${repo}/git/ref/heads/${at.branch.split('/').map(encodeURIComponent).join('/')}`
  );
  if (answer.status === 404) return null;
  const body = isRecord(answer.body) ? answer.body : null;
  const object = isRecord(body?.object) ? body.object : null;
  if (
    answer.status !== 200 ||
    body?.ref !== ref ||
    object?.type !== 'commit' ||
    !isCommitSha(object.sha)
  )
    throw new ForkRefError('ref_unknown', answer.status);
  return object.sha;
}
