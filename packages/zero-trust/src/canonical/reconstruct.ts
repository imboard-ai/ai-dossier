import {
  CanonicalError,
  comparePaths,
  createManifest,
  type SourceEntry,
  type SourceLimits,
  type SourceManifest,
  sha256,
  sourceLimits,
  validateManifest,
  validateSourcePath,
} from './export';
import { TrustedGit } from './trusted-git';

export interface ContributorApproval {
  readonly login: string;
  readonly name: string;
  readonly email: string;
  /** Exact UTC second, recorded once by the authenticated controller. */
  readonly timestamp: string;
}
export const CANONICAL_COMMITTER = Object.freeze({
  name: 'ai-dossier (LLM-assisted contribution)',
  email: 'ai-dossier@users.noreply.github.com',
});
export interface CommitInputs {
  readonly baseSha: string;
  readonly author: ContributorApproval;
  readonly committerTimestamp: string;
  /** Fixed UTF-8 message, including its final newline. */
  readonly message: string;
}
export interface CandidateRecord extends CommitInputs {
  readonly version: 1;
  readonly manifestDigest: string;
  readonly treeSha: string;
  readonly candidateSha: string;
}
export interface CandidateAuthority {
  readonly baseSha: string;
  readonly author: ContributorApproval;
  /** Controller-owned binding. Never accept this digest from the worker. */
  readonly recordDigest: string;
}
export interface CanonicalCandidate {
  readonly record: CandidateRecord;
  readonly authority: CandidateAuthority;
  /** Raw Git object data only; no refs, config, attributes, hooks or alternates. */
  readonly pack: Buffer;
}
const MAX_PACK_BYTES = 128 * 1024 * 1024;
function oid(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value))
    throw new CanonicalError('invalid_manifest');
  return value;
}
function text(value: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Prevent Git header injection.
    /[<>\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.from(value).toString('utf8') !== value
  )
    throw new CanonicalError('altered_identity');
  return value;
}
function date(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value))
    throw new CanonicalError('altered_identity');
  const epoch = Date.parse(value);
  if (
    !Number.isFinite(epoch) ||
    epoch < 0 ||
    new Date(epoch).toISOString() !== value.replace('Z', '.000Z')
  )
    throw new CanonicalError('altered_identity');
  return `${epoch / 1000} +0000`;
}
function approval(raw: ContributorApproval): ContributorApproval {
  const { login, name, email, timestamp } = raw;
  date(timestamp);
  return Object.freeze({
    login: text(login, 128),
    name: text(name, 256),
    email: text(email, 256),
    timestamp,
  });
}
function inputs(raw: CommitInputs): CommitInputs {
  const { baseSha, author, committerTimestamp, message } = raw;
  date(committerTimestamp);
  if (
    typeof message !== 'string' ||
    !message.endsWith('\n') ||
    !message.trim() ||
    Buffer.byteLength(message) > 65536 ||
    message.includes('\u0000') ||
    Buffer.from(message).toString('utf8') !== message
  )
    throw new CanonicalError('altered_identity');
  return Object.freeze({
    baseSha: oid(baseSha),
    author: approval(author),
    committerTimestamp,
    message,
  });
}
function importBase(git: TrustedGit, pack: Buffer, baseSha: string): void {
  if (!Buffer.isBuffer(pack) || !pack.length || pack.length > MAX_PACK_BYTES)
    throw new CanonicalError('limit_exceeded');
  // Copy once: caller cannot mutate bytes between checks/import.
  try {
    git.run(['index-pack', '--strict', '--stdin'], Buffer.from(pack));
  } catch {
    throw new CanonicalError('unsupported');
  }
  if (git.run(['cat-file', '-t', baseSha]).toString().trim() !== 'commit')
    throw new CanonicalError('unsupported');
}
/** Raw trees preserve modes, duplicate names and bytes which ls-tree text would hide. */
function inspectTree(
  git: TrustedGit,
  tree: string,
  overrides: Partial<SourceLimits>
): SourceManifest {
  const limits = sourceLimits(overrides);
  const entries: SourceEntry[] = [];
  let total = 0;
  const walk = (sha: string, prefix: string, depth: number): void => {
    if (depth > limits.depth) throw new CanonicalError('limit_exceeded');
    const bytes = git.run(['cat-file', 'tree', oid(sha)]);
    let offset = 0;
    while (offset < bytes.length) {
      if (entries.length >= limits.entries) throw new CanonicalError('limit_exceeded');
      const space = bytes.indexOf(32, offset);
      const nul = bytes.indexOf(0, space + 1);
      if (space < offset || nul < space || nul + 21 > bytes.length)
        throw new CanonicalError('unsupported');
      const mode = bytes.subarray(offset, space).toString('ascii');
      const nameBytes = bytes.subarray(space + 1, nul);
      const name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes) || name.includes('/'))
        throw new CanonicalError('invalid_path');
      const path = prefix ? `${prefix}/${name}` : name;
      validateSourcePath(path);
      const child = bytes.subarray(nul + 1, nul + 21).toString('hex');
      offset = nul + 21;
      if (mode === '40000') {
        entries.push({ path, mode: '040000', bytes: '', sha256: sha256('') });
        walk(child, path, depth + 1);
      } else if (mode === '100644' || mode === '100755') {
        const size = Number(git.run(['cat-file', '-s', child]).toString().trim());
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > limits.fileBytes ||
          total + size > limits.totalBytes
        )
          throw new CanonicalError('limit_exceeded');
        const blob = git.run(['cat-file', 'blob', child]);
        total += blob.length;
        entries.push({ path, mode, bytes: blob.toString('base64'), sha256: sha256(blob) });
      } else throw new CanonicalError('unsupported');
    }
  };
  walk(tree, '', 0);
  return createManifest(entries, limits);
}
function baseTree(git: TrustedGit, base: string): string {
  const match = /^tree ([a-f0-9]{40})\n/u.exec(git.run(['cat-file', 'commit', base]).toString());
  if (!match) throw new CanonicalError('unsupported');
  return match[1] as string;
}
function buildTree(git: TrustedGit, manifest: SourceManifest): string {
  const directories = new Map<
    string,
    { mode: string; type: string; sha: string; name: string }[]
  >();
  directories.set('', []);
  for (const entry of manifest.entries) {
    if (entry.mode === '040000') directories.set(entry.path, []);
  }
  for (const entry of manifest.entries) {
    if (entry.mode === '040000') continue;
    const split = entry.path.lastIndexOf('/');
    const parent = split < 0 ? '' : entry.path.slice(0, split);
    const name = entry.path.slice(split + 1);
    const sha = git
      .run(['hash-object', '-w', '--no-filters', '--stdin'], Buffer.from(entry.bytes, 'base64'))
      .toString()
      .trim();
    directories.get(parent)?.push({ mode: entry.mode, type: 'blob', sha: oid(sha), name });
  }
  const paths = [...directories.keys()].sort(
    (a, b) => b.split('/').length - a.split('/').length || comparePaths(b, a)
  );
  let root = '';
  for (const path of paths) {
    const children = directories.get(path) as {
      mode: string;
      type: string;
      sha: string;
      name: string;
    }[];
    // Git's directory ordering uses a trailing slash, not localeCompare.
    children.sort((a, b) =>
      comparePaths(a.name + (a.type === 'tree' ? '/' : ''), b.name + (b.type === 'tree' ? '/' : ''))
    );
    const tree = git
      .run(
        ['mktree', '-z'],
        Buffer.concat(
          children.map((child) =>
            Buffer.from(`${child.mode} ${child.type} ${child.sha}\t${child.name}\u0000`)
          )
        )
      )
      .toString()
      .trim();
    if (!path) root = oid(tree);
    else if (children.length) {
      const split = path.lastIndexOf('/');
      directories
        .get(split < 0 ? '' : path.slice(0, split))
        ?.push({ mode: '040000', type: 'tree', sha: oid(tree), name: path.slice(split + 1) });
    }
  }
  return root;
}
function commitBytes(input: CommitInputs, tree: string): string {
  return `tree ${tree}\nparent ${input.baseSha}\nauthor ${input.author.name} <${input.author.email}> ${date(input.author.timestamp)}\ncommitter ${CANONICAL_COMMITTER.name} <${CANONICAL_COMMITTER.email}> ${date(input.committerTimestamp)}\n\n${input.message}`;
}
function commit(git: TrustedGit, input: CommitInputs, tree: string): string {
  const sha = oid(
    git
      .run(['commit-tree', tree, '-p', input.baseSha], input.message, {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_AUTHOR_DATE: date(input.author.timestamp),
        GIT_COMMITTER_NAME: CANONICAL_COMMITTER.name,
        GIT_COMMITTER_EMAIL: CANONICAL_COMMITTER.email,
        GIT_COMMITTER_DATE: date(input.committerTimestamp),
      })
      .toString()
      .trim()
  );
  if (!git.run(['cat-file', 'commit', sha]).equals(Buffer.from(commitBytes(input, tree))))
    throw new CanonicalError('commit_mismatch');
  return sha;
}
function recordDigest(record: CandidateRecord): string {
  return sha256(JSON.stringify(record));
}
/** Establish once from controller-approved inputs. Persist record + authority + manifest privately. */
export function createCandidate(
  source: SourceManifest,
  approved: CommitInputs,
  baselinePack: Buffer,
  limits: Partial<SourceLimits> = {}
): CanonicalCandidate {
  const input = inputs(approved);
  const manifest = validateManifest(source, limits);
  const git = new TrustedGit();
  try {
    importBase(git, baselinePack, input.baseSha);
    inspectTree(git, baseTree(git, input.baseSha), limits);
    const treeSha = buildTree(git, manifest);
    const candidateSha = commit(git, input, treeSha);
    const record = Object.freeze({
      version: 1 as const,
      ...input,
      manifestDigest: manifest.digest,
      treeSha,
      candidateSha,
    });
    const authority = Object.freeze({
      baseSha: input.baseSha,
      author: input.author,
      recordDigest: recordDigest(record),
    });
    const pack = git.run(['pack-objects', '--stdout', '--revs'], `${candidateSha}\n`);
    return Object.freeze({ record, authority, pack });
  } finally {
    git.close();
  }
}
/** Rebuild the only authorized SHA, independently of worker refs/config and mutable files. */
export function reconstructCandidate(
  source: SourceManifest,
  persisted: CandidateRecord,
  trusted: CandidateAuthority,
  baselinePack: Buffer,
  limits: Partial<SourceLimits> = {}
): CanonicalCandidate {
  const input = inputs(persisted);
  const expectedAuthor = approval(trusted.author);
  if (input.baseSha !== oid(trusted.baseSha)) throw new CanonicalError('wrong_parent');
  if (JSON.stringify(input.author) !== JSON.stringify(expectedAuthor))
    throw new CanonicalError('altered_identity');
  const { version, manifestDigest, treeSha, candidateSha } = persisted;
  const record: CandidateRecord = Object.freeze({
    version,
    ...input,
    manifestDigest,
    treeSha: oid(treeSha),
    candidateSha: oid(candidateSha),
  });
  if (version !== 1 || recordDigest(record) !== trusted.recordDigest)
    throw new CanonicalError('invalid_manifest');
  const manifest = validateManifest(source, limits);
  if (manifest.digest !== record.manifestDigest) throw new CanonicalError('tree_mismatch');
  const candidate = createCandidate(manifest, input, baselinePack, limits);
  if (candidate.record.treeSha !== record.treeSha) throw new CanonicalError('tree_mismatch');
  if (candidate.record.candidateSha !== record.candidateSha)
    throw new CanonicalError('commit_mismatch');
  return candidate;
}
