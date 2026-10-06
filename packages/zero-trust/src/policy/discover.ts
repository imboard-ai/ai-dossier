import type { GitHubRead } from '../github/reconcile';
import { assertNoSecrets } from '../redaction';

export const POLICY_FILE_LIMIT = 256 * 1024;
export const POLICY_TOTAL_LIMIT = 1024 * 1024;
export const POLICY_TEMPLATE_LIMIT = 20;
export const POLICY_TEMPLATE_DIRECTORY = '.github/PULL_REQUEST_TEMPLATE';
export const POLICY_PATHS: readonly string[] = Object.freeze([
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CONTRIBUTING.rst',
  'CONTRIBUTING.txt',
  'AI_POLICY.md',
  'AI-POLICY.md',
  '.github/AI_POLICY.md',
  'docs/AI_POLICY.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'README.md',
]);

export interface PolicyFile {
  readonly path: string;
  /** Git blob identity returned by the pinned Contents read. */
  readonly sha: string;
  /** Strict UTF-8 decoded bytes; always untrusted data. */
  readonly content: string;
}
export type PolicyDiscovery =
  | { readonly kind: 'known'; readonly files: readonly PolicyFile[] }
  | { readonly kind: 'unknown' };

export class PolicyInputError extends Error {
  constructor() {
    super('Invalid policy input');
    this.name = 'PolicyInputError';
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function templatePath(path: string): boolean {
  const name = path.slice(POLICY_TEMPLATE_DIRECTORY.length + 1);
  return (
    path.startsWith(`${POLICY_TEMPLATE_DIRECTORY}/`) &&
    /^[A-Za-z0-9_. -]{1,120}$/u.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** Validate a direct classifier input too: no unbounded or duplicate snapshots. */
export function validatePolicyFiles(files: readonly PolicyFile[]): void {
  if (!Array.isArray(files) || files.length > POLICY_PATHS.length + POLICY_TEMPLATE_LIMIT)
    throw new PolicyInputError();
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      (!POLICY_PATHS.includes(file.path) && !templatePath(file.path)) ||
      seen.has(file.path) ||
      typeof file.sha !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(file.sha) ||
      typeof file.content !== 'string'
    )
      throw new PolicyInputError();
    assertNoSecrets(file.path);
    const bytes = Buffer.byteLength(file.content);
    total += bytes;
    if (
      bytes > POLICY_FILE_LIMIT ||
      Buffer.from(file.content, 'utf8').toString('utf8') !== file.content ||
      total > POLICY_TOTAL_LIMIT
    )
      throw new PolicyInputError();
    seen.add(file.path);
  }
}

function decodeFile(body: unknown, path: string, expectedSha?: string): PolicyFile {
  const file = object(body);
  if (
    !file ||
    file.type !== 'file' ||
    file.path !== path ||
    typeof file.sha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(file.sha) ||
    (expectedSha !== undefined && file.sha !== expectedSha) ||
    file.encoding !== 'base64' ||
    typeof file.content !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    (file.size as number) < 0 ||
    (file.size as number) > POLICY_FILE_LIMIT ||
    file.content.length > Math.ceil(POLICY_FILE_LIMIT / 3) * 4 + 16384 ||
    (file.truncated !== undefined && file.truncated !== false)
  )
    throw new PolicyInputError();
  // GitHub wraps base64 at newlines. Reject every other ignored character and
  // noncanonical padding instead of Buffer's permissive partial decoding.
  const base64 = file.content.replace(/[\r\n]/gu, '');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64 || bytes.length !== file.size)
    throw new PolicyInputError();
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return Object.freeze({ path, sha: file.sha, content });
}

/** Credential-free, fixed-target reads at a commit. There is no retry/fallback.
 * Unknown exposes no partial files that could be mistaken for policy silence. */
export async function discoverPolicy(
  read: GitHubRead,
  upstream: { readonly owner: string; readonly repo: string; readonly ref: string }
): Promise<PolicyDiscovery> {
  try {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(upstream.owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/u.test(upstream.repo) ||
      upstream.repo === '.' ||
      upstream.repo === '..' ||
      !/^[a-f0-9]{40}$/u.test(upstream.ref)
    )
      return { kind: 'unknown' };
    const prefix = `/repos/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.repo)}/contents/`;
    const suffix = `?ref=${upstream.ref}`;
    const files: PolicyFile[] = [];
    async function getFile(path: string, expectedSha?: string): Promise<void> {
      const response = await read(
        `${prefix}${path.split('/').map(encodeURIComponent).join('/')}${suffix}`
      );
      if (response.status === 404 && expectedSha === undefined) return;
      if (response.status !== 200) throw new PolicyInputError();
      files.push(decodeFile(response.body, path, expectedSha));
      validatePolicyFiles(files);
    }
    for (const path of POLICY_PATHS) await getFile(path);
    const listing = await read(`${prefix}${POLICY_TEMPLATE_DIRECTORY}/${suffix}`);
    if (listing.status === 404) return { kind: 'known', files: Object.freeze(files) };
    if (
      listing.status !== 200 ||
      !Array.isArray(listing.body) ||
      listing.body.length > POLICY_TEMPLATE_LIMIT ||
      ('truncated' in listing.body && listing.body.truncated !== false)
    )
      return { kind: 'unknown' };
    const entries: { path: string; sha: string }[] = [];
    const seen = new Set<string>();
    for (const value of listing.body) {
      const entry = object(value);
      if (
        !entry ||
        entry.type !== 'file' ||
        typeof entry.path !== 'string' ||
        !templatePath(entry.path) ||
        entry.name !== entry.path.slice(POLICY_TEMPLATE_DIRECTORY.length + 1) ||
        typeof entry.sha !== 'string' ||
        !/^[a-f0-9]{40}$/u.test(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        (entry.size as number) < 0 ||
        (entry.size as number) > POLICY_FILE_LIMIT ||
        (entry.truncated !== undefined && entry.truncated !== false) ||
        seen.has(entry.path)
      )
        return { kind: 'unknown' };
      assertNoSecrets(entry.path);
      seen.add(entry.path);
      entries.push({ path: entry.path, sha: entry.sha });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of entries) await getFile(entry.path, entry.sha);
    return { kind: 'known', files: Object.freeze(files) };
  } catch {
    return { kind: 'unknown' };
  }
}
