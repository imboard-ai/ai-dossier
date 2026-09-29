import path from 'node:path';
import type { DossierFrontmatter } from '@ai-dossier/core';
import { getErrorMessage } from '@ai-dossier/core';
import config from './config';
import { DOSSIER_DEFAULTS, GITHUB_API_VERSION, USER_AGENT } from './constants';
import { dossierFilePath, evidenceFilePath, sanitizeActor } from './dossier';
import createLogger from './logger';
import type {
  DeleteResult,
  FileContent,
  GitHubCommitResponse,
  Manifest,
  ManifestDossier,
} from './types';

const log = createLogger('github');

export class PathTraversalError extends Error {
  constructor(filePath: string) {
    super(`Path traversal detected: ${filePath}`);
    this.name = 'PathTraversalError';
  }
}

function sanitizePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath);
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new PathTraversalError(filePath);
  }
  return normalized;
}

async function throwGitHubApiError(response: Response): Promise<never> {
  let errorMessage: string;
  try {
    const data = (await response.json()) as { message?: string };
    errorMessage = data.message || JSON.stringify(data);
  } catch {
    errorMessage = await response.text().catch(() => 'unknown error');
  }
  throw new Error(`GitHub API error: ${response.status} - ${errorMessage}`);
}

async function githubRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const url = endpoint.startsWith('http') ? endpoint : `${config.auth.github.apiUrl}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.content.botToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (err) {
    throw new Error(`GitHub API request failed for ${url}: ${getErrorMessage(err)}`);
  }

  if (!response.ok) {
    log.error('GitHub API request failed', {
      method: options.method || 'GET',
      endpoint,
      status: response.status,
      statusText: response.statusText,
    });
  }

  return response;
}

export async function getFileContent(filePath: string): Promise<FileContent | null> {
  const safePath = sanitizePath(filePath);
  const { org, repo } = config.content;
  const response = await githubRequest(`/repos/${org}/${repo}/contents/${safePath}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(no body)');
    throw new Error(`GitHub API error: ${response.status} - ${body}`);
  }

  const data = (await response.json()) as { content: string; sha: string };
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

export async function deleteFile(
  filePath: string,
  message: string,
  sha: string
): Promise<GitHubCommitResponse> {
  const safePath = sanitizePath(filePath);
  const { org, repo } = config.content;

  const response = await githubRequest(`/repos/${org}/${repo}/contents/${safePath}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha }),
  });

  if (!response.ok) {
    await throwGitHubApiError(response);
  }

  return response.json() as Promise<GitHubCommitResponse>;
}

export async function createOrUpdateFile(
  filePath: string,
  content: string,
  message: string,
  sha: string | null = null
): Promise<GitHubCommitResponse> {
  const safePath = sanitizePath(filePath);
  const { org, repo } = config.content;
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content).toString('base64'),
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await githubRequest(`/repos/${org}/${repo}/contents/${safePath}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwGitHubApiError(response);
  }

  return response.json() as Promise<GitHubCommitResponse>;
}

export type ActorTrailerKey = 'Published-By' | 'Removed-By';

/**
 * Append a git trailer naming the authenticated GitHub login that performed a write
 * (`<message>\n\n<key>: <login>`). The registry commits with its own server token, so the
 * trailer is the only record in `dossier-content` history of which member acted. The login is
 * sanitized like the changelog so it cannot inject extra message lines; a missing or empty
 * login leaves the message unchanged.
 */
export function withActorTrailer(
  message: string,
  key: ActorTrailerKey,
  login: string | null | undefined
): string {
  const actor = sanitizeActor(login);
  return actor ? `${message}\n\n${key}: ${actor}` : message;
}

export async function getManifest(): Promise<Manifest> {
  const result = await getFileContent('index.json');

  if (!result) {
    return { dossiers: [], sha: null };
  }

  let manifest: Omit<Manifest, 'sha'>;
  try {
    manifest = JSON.parse(result.content);
  } catch (e) {
    throw new Error(`Failed to parse manifest (index.json): ${getErrorMessage(e)}`);
  }
  return { ...manifest, sha: result.sha };
}

export async function updateManifest(
  currentManifest: Manifest,
  dossierEntry: ManifestDossier,
  publishedBy: string | null = null
): Promise<GitHubCommitResponse> {
  const { sha, ...manifest } = currentManifest;

  const existingIndex = manifest.dossiers.findIndex((d) => d.name === dossierEntry.name);

  if (existingIndex >= 0) {
    manifest.dossiers[existingIndex] = dossierEntry;
  } else {
    manifest.dossiers.push(dossierEntry);
  }

  manifest.dossiers.sort((a, b) => a.name.localeCompare(b.name));

  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const message = withActorTrailer(
    existingIndex >= 0
      ? `Update manifest: ${dossierEntry.name} v${dossierEntry.version}`
      : `Add to manifest: ${dossierEntry.name} v${dossierEntry.version}`,
    'Published-By',
    publishedBy
  );

  return createOrUpdateFile('index.json', content, message, sha);
}

export async function removeFromManifest(
  currentManifest: Manifest,
  dossierName: string,
  removedBy: string | null = null
): Promise<GitHubCommitResponse> {
  const { sha, ...manifest } = currentManifest;

  const existingIndex = manifest.dossiers.findIndex((d) => d.name === dossierName);

  if (existingIndex < 0) {
    throw new Error(`Dossier '${dossierName}' not found in manifest`);
  }

  manifest.dossiers.splice(existingIndex, 1);

  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const message = withActorTrailer(`Remove from manifest: ${dossierName}`, 'Removed-By', removedBy);

  return createOrUpdateFile('index.json', content, message, sha);
}

/** Deletes `<sidecarPath>` if it exists; a no-op (returns undefined) if it does not. */
async function deleteEvidenceSidecar(
  sidecarPath: string,
  message: string
): Promise<GitHubCommitResponse | undefined> {
  const existing = await getFileContent(sidecarPath);
  if (!existing) return undefined;
  return deleteFile(sidecarPath, message, existing.sha);
}

export interface PublishOptions {
  /** Evidence sidecar JSON; null/absent removes any stale sidecar. */
  evidence?: string | null;
  /** Authenticated GitHub login (verified JWT `sub`) — recorded as trailer + manifest field. */
  publishedBy?: string | null;
  /** ISO timestamp recorded as `published_at`; defaults to now. */
  publishedAt?: string;
}

export interface DeleteOptions {
  /** Only delete if the manifest's current version matches. */
  expectedVersion?: string | null;
  /** Authenticated GitHub login recorded as a `Removed-By` trailer. */
  removedBy?: string | null;
}

export async function publishDossier(
  fullPath: string,
  content: string,
  metadata: DossierFrontmatter,
  changelog: string,
  options: PublishOptions = {}
): Promise<{
  file: GitHubCommitResponse;
  manifest: GitHubCommitResponse;
  evidence?: GitHubCommitResponse;
  /** The sanitized publisher actually recorded (null when none). */
  publishedBy: string | null;
  publishedAt: string;
}> {
  const filePath = dossierFilePath(fullPath);
  const sidecarPath = evidenceFilePath(fullPath);

  const existing = await getFileContent(filePath);

  const evidence = options.evidence ?? null;
  const publisher = sanitizeActor(options.publishedBy);
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const fileMessage = withActorTrailer(
    existing
      ? `Update ${metadata.name} to v${metadata.version}: ${changelog}`
      : `Publish ${metadata.name} v${metadata.version}: ${changelog}`,
    'Published-By',
    publisher
  );

  log.info('Writing content file', { step: '1/3', filePath });
  const fileResult = await createOrUpdateFile(
    filePath,
    content,
    fileMessage,
    existing?.sha ?? null
  );
  log.info('Content file written', { step: '1/3' });

  let evidenceResult: GitHubCommitResponse | undefined;
  let evidenceAction: 'created' | 'updated' | 'removed-stale' | 'skipped' = 'skipped';
  if (typeof evidence === 'string') {
    // Evidence was supplied: a write failure here must abort the publish (rethrow) —
    // the manifest must never point at a content file whose evidence write is unknown.
    log.info('Writing evidence sidecar', { step: '2/3', sidecarPath });
    try {
      const existingEvidence = await getFileContent(sidecarPath);
      evidenceAction = existingEvidence ? 'updated' : 'created';
      evidenceResult = await createOrUpdateFile(
        sidecarPath,
        evidence,
        withActorTrailer(
          `Evidence for ${metadata.name} v${metadata.version}`,
          'Published-By',
          publisher
        ),
        existingEvidence?.sha ?? null
      );
    } catch (err) {
      log.error(
        `Content file ${existing ? 'updated' : 'created'} but evidence sidecar write failed — manifest not yet updated, manual reconciliation required`,
        {
          filePath,
          sidecarPath,
          dossier: metadata.name,
          version: metadata.version,
          error: getErrorMessage(err),
        }
      );
      throw err;
    }
  } else {
    // No evidence on this publish: a sidecar left over from an earlier version is keyed to a
    // checksum the new content no longer has, so it must be removed rather than left stale.
    // Best effort (log and continue) — this is cleanup, not the publish itself, and per AC2
    // a publish without evidence must behave exactly as it did before this cleanup existed.
    try {
      evidenceResult = await deleteEvidenceSidecar(
        sidecarPath,
        withActorTrailer(
          `Remove stale evidence for ${metadata.name} v${metadata.version}`,
          'Published-By',
          publisher
        )
      );
      evidenceAction = evidenceResult ? 'removed-stale' : 'skipped';
    } catch (err) {
      log.error('Best-effort stale evidence sidecar cleanup failed', {
        sidecarPath,
        dossier: metadata.name,
        version: metadata.version,
        error: getErrorMessage(err),
      });
    }
  }
  log.info('Evidence sidecar step complete', { step: '2/3', sidecarPath, action: evidenceAction });

  log.info('Updating manifest', { step: '3/3', dossier: metadata.name });
  const manifest = await getManifest();

  const OPTIONAL_MANIFEST_FIELDS = Object.keys(DOSSIER_DEFAULTS) as Array<
    keyof typeof DOSSIER_DEFAULTS
  >;

  const dossierEntry: ManifestDossier = {
    name: fullPath,
    title: metadata.title,
    version: metadata.version,
    path: filePath,
  };

  for (const field of OPTIONAL_MANIFEST_FIELDS) {
    if (metadata[field] !== undefined) {
      (dossierEntry as Record<string, unknown>)[field] = metadata[field];
    }
  }

  // Set after the frontmatter copy so author-written frontmatter can never supply these.
  // Recorded going forward only — entries published before #971 simply lack them.
  if (publisher) dossierEntry.published_by = publisher;
  dossierEntry.published_at = publishedAt;

  let manifestResult: GitHubCommitResponse;
  try {
    manifestResult = await updateManifest(manifest, dossierEntry, publisher);
  } catch (err) {
    log.error('File written but manifest update failed — orphaned file needs cleanup', {
      filePath,
      version: metadata.version,
      published_by: publisher,
      error: getErrorMessage(err),
    });
    throw err;
  }
  log.info('Manifest updated', { step: '3/3', dossier: metadata.name });

  return {
    file: fileResult,
    manifest: manifestResult,
    evidence: evidenceResult,
    publishedBy: publisher,
    publishedAt,
  };
}

/** Best-effort: removes `<dossierName>`'s evidence sidecar if present. A failure is logged and
 * swallowed so a sidecar problem never fails an otherwise-successful dossier delete. */
async function deleteEvidenceSidecarBestEffort(
  dossierName: string,
  removedBy: string | null
): Promise<void> {
  const sidecarPath = evidenceFilePath(dossierName);
  try {
    await deleteEvidenceSidecar(
      sidecarPath,
      withActorTrailer(`Delete evidence for ${dossierName}`, 'Removed-By', removedBy)
    );
  } catch (err) {
    log.error('Best-effort evidence sidecar delete failed', {
      sidecarPath,
      error: getErrorMessage(err),
    });
  }
}

export async function deleteDossier(
  dossierName: string,
  options: DeleteOptions = {}
): Promise<DeleteResult> {
  const expectedVersion = options.expectedVersion ?? null;
  const removedBy = sanitizeActor(options.removedBy);
  const filePath = dossierFilePath(dossierName);

  const existing = await getFileContent(filePath);

  if (!existing) {
    // No content file, but a prior crashed publish/delete may have left an orphaned sidecar
    // (see publishDossier's crash-halfway note) — reconcile it even though there is nothing
    // else to delete here.
    await deleteEvidenceSidecarBestEffort(dossierName, removedBy);
    return { found: false };
  }

  const manifest = await getManifest();
  const dossierEntry = manifest.dossiers.find((d) => d.name === dossierName);

  if (!dossierEntry) {
    const fileResult = await deleteFile(
      filePath,
      withActorTrailer(`Delete orphaned file: ${dossierName}`, 'Removed-By', removedBy),
      existing.sha
    );
    await deleteEvidenceSidecarBestEffort(dossierName, removedBy);
    return { found: true, version: null, file: fileResult };
  }

  if (expectedVersion && dossierEntry.version !== expectedVersion) {
    return {
      found: true,
      versionMismatch: true,
      currentVersion: dossierEntry.version,
      requestedVersion: expectedVersion,
    };
  }

  log.info('Deleting content file', { step: '1/3', filePath });
  const fileResult = await deleteFile(
    filePath,
    withActorTrailer(`Delete ${dossierName} v${dossierEntry.version}`, 'Removed-By', removedBy),
    existing.sha
  );
  log.info('Content file deleted', { step: '1/3' });

  // The dossier is already gone from the manifest by this point, so a leftover sidecar is
  // inert — log and continue rather than failing a successful delete (contrast publishDossier,
  // where a sidecar write failure must abort: there the manifest has not yet been updated).
  log.info('Removing evidence sidecar (best effort)', { step: '2/3', dossier: dossierName });
  await deleteEvidenceSidecarBestEffort(dossierName, removedBy);

  log.info('Removing from manifest', { step: '3/3', dossier: dossierName });
  let manifestResult: GitHubCommitResponse;
  try {
    manifestResult = await removeFromManifest(manifest, dossierName, removedBy);
  } catch (err) {
    log.error('File deleted but manifest update failed — manual cleanup required', {
      filePath,
      version: dossierEntry.version,
      removed_by: removedBy,
      error: getErrorMessage(err),
    });
    throw err;
  }
  log.info('Manifest updated', { step: '3/3' });

  return {
    found: true,
    version: dossierEntry.version,
    file: fileResult,
    manifest: manifestResult,
  };
}
