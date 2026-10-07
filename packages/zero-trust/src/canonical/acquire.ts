import { fileURLToPath } from 'node:url';
import { isCommitSha } from '../github/fork-ref';
import { isRepoName } from '../github/handoff';
import { CanonicalError, type SourceManifest } from './export';
import { baseManifest, importPack, MAX_PACK_BYTES } from './reconstruct';
import { createSourceGit } from './trusted-git';

/** Structural read capability: no import chain into credential-bearing modules. */
export type SourceGitHubRead = (
  path: string
) => Promise<{ readonly status: number; readonly body: unknown }>;
export interface SourceUpstream {
  readonly owner: string;
  readonly repo: string;
}
function name(value: string): string {
  if (!isRepoName(value)) throw new CanonicalError('unsupported');
  return value;
}
export function sourceUrl(upstream: SourceUpstream): string {
  return `https://github.com/${name(upstream.owner)}/${name(upstream.repo)}.git`;
}
function sha(value: unknown): string {
  if (!isCommitSha(value)) throw new CanonicalError('unavailable');
  return value;
}
export async function resolveBase(
  read: SourceGitHubRead,
  upstream: SourceUpstream & { readonly defaultBranch: string }
): Promise<string> {
  sourceUrl(upstream);
  if (typeof upstream.defaultBranch !== 'string' || !upstream.defaultBranch.trim())
    throw new CanonicalError('unavailable');
  try {
    const path = `/repos/${upstream.owner}/${upstream.repo}/branches/${encodeURIComponent(upstream.defaultBranch)}`;
    const response = await read(path);
    if (response.status !== 200) throw new CanonicalError('unavailable');
    return sha((response.body as { commit?: { sha?: unknown } } | null)?.commit?.sha);
  } catch {
    throw new CanonicalError('unavailable');
  }
}
export interface AcquireSourceOptions {
  /** Offline local bare fixtures only. Refused outside Vitest, never a production remote. */
  readonly remoteUrlForTest?: string;
}
export interface AcquiredSource {
  readonly pack: Buffer;
  readonly manifest: SourceManifest;
}
export function acquireSource(
  upstream: SourceUpstream & { readonly baseSha: string },
  options: AcquireSourceOptions = {}
): AcquiredSource {
  let url = sourceUrl(upstream);
  const base = sha(upstream.baseSha);
  let sourceFetch: 'https' | 'file-test' = 'https';
  if (options.remoteUrlForTest !== undefined) {
    if (!process.env.VITEST) throw new CanonicalError('unsupported');
    try {
      const remote = new URL(options.remoteUrlForTest);
      if (remote.protocol !== 'file:' || remote.host || remote.search || remote.hash)
        throw new Error('not a local file');
      fileURLToPath(remote);
      url = remote.href;
      sourceFetch = 'file-test';
    } catch {
      throw new CanonicalError('unsupported');
    }
  }
  const fetchPack = (shallow: boolean): Buffer => {
    const git = createSourceGit();
    try {
      const fetched = git.exec(
        [
          'fetch',
          ...(shallow ? ['--depth=1'] : []),
          '--no-tags',
          '--no-recurse-submodules',
          url,
          base,
        ],
        { sourceFetch }
      );
      if (fetched.fileLimitExceeded) throw new CanonicalError('limit_exceeded');
      if (fetched.status !== 0) throw new CanonicalError('unavailable');
      const result = git.exec(['pack-objects', '--stdout', '--revs'], {
        input: `${base}\n`,
        maxOutputBytes: MAX_PACK_BYTES,
      });
      if (result.outputLimitExceeded || result.stdout.length > MAX_PACK_BYTES)
        throw new CanonicalError('limit_exceeded');
      if (result.status !== 0) throw new CanonicalError('unavailable');
      return result.stdout;
    } finally {
      git.close();
    }
  };
  let pack = fetchPack(true);
  // Only a strict import rejection permits the explicitly authorized full-history retry.
  const probe = createSourceGit();
  try {
    try {
      importPack(probe, pack);
    } catch (error) {
      if (!(error instanceof CanonicalError) || error.reason !== 'unsupported') throw error;
      pack = fetchPack(false);
    }
  } finally {
    probe.close();
  }
  return Object.freeze({ pack, manifest: baseManifest(pack, base) });
}
