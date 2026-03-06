import path from 'node:path';
import type { DossierFrontmatter } from '@ai-dossier/core';
import { getErrorMessage } from '@ai-dossier/core';
import config from './config';
import { DOSSIER_DEFAULTS, GITHUB_API_VERSION, USER_AGENT } from './constants';
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
  dossierEntry: ManifestDossier
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
  const message =
    existingIndex >= 0
      ? `Update manifest: ${dossierEntry.name} v${dossierEntry.version}`
      : `Add to manifest: ${dossierEntry.name} v${dossierEntry.version}`;

  return createOrUpdateFile('index.json', content, message, sha);
}

export async function removeFromManifest(
  currentManifest: Manifest,
  dossierName: string
): Promise<GitHubCommitResponse> {
  const { sha, ...manifest } = currentManifest;

  const existingIndex = manifest.dossiers.findIndex((d) => d.name === dossierName);

  if (existingIndex < 0) {
    throw new Error(`Dossier '${dossierName}' not found in manifest`);
  }

  manifest.dossiers.splice(existingIndex, 1);

  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const message = `Remove from manifest: ${dossierName}`;

  return createOrUpdateFile('index.json', content, message, sha);
}

export async function publishDossier(
  fullPath: string,
  content: string,
  metadata: DossierFrontmatter,
  changelog: string
): Promise<{ file: GitHubCommitResponse; manifest: GitHubCommitResponse }> {
  const filePath = `${fullPath}.ds.md`;

  const existing = await getFileContent(filePath);

  const fileMessage = existing
    ? `Update ${metadata.name} to v${metadata.version}: ${changelog}`
    : `Publish ${metadata.name} v${metadata.version}: ${changelog}`;

  log.info('Writing content file', { step: '1/2', filePath });
  const fileResult = await createOrUpdateFile(
    filePath,
    content,
    fileMessage,
    existing?.sha ?? null
  );
  log.info('Content file written', { step: '1/2' });

  log.info('Updating manifest', { step: '2/2', dossier: metadata.name });
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

  let manifestResult: GitHubCommitResponse;
  try {
    manifestResult = await updateManifest(manifest, dossierEntry);
  } catch (err) {
    log.error('File written but manifest update failed — orphaned file needs cleanup', {
      filePath,
      error: getErrorMessage(err),
    });
    throw err;
  }
  log.info('Manifest updated', { step: '2/2', dossier: metadata.name });

  return { file: fileResult, manifest: manifestResult };
}

export async function deleteDossier(
  dossierName: string,
  expectedVersion: string | null = null
): Promise<DeleteResult> {
  const filePath = `${dossierName}.ds.md`;

  const existing = await getFileContent(filePath);

  if (!existing) {
    return { found: false };
  }

  const manifest = await getManifest();
  const dossierEntry = manifest.dossiers.find((d) => d.name === dossierName);

  if (!dossierEntry) {
    const fileResult = await deleteFile(
      filePath,
      `Delete orphaned file: ${dossierName}`,
      existing.sha
    );
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

  log.info('Deleting content file', { step: '1/2', filePath });
  const fileResult = await deleteFile(
    filePath,
    `Delete ${dossierName} v${dossierEntry.version}`,
    existing.sha
  );
  log.info('Content file deleted', { step: '1/2' });

  log.info('Removing from manifest', { step: '2/2', dossier: dossierName });
  let manifestResult: GitHubCommitResponse;
  try {
    manifestResult = await removeFromManifest(manifest, dossierName);
  } catch (err) {
    log.error('File deleted but manifest update failed — manual cleanup required', {
      filePath,
      error: getErrorMessage(err),
    });
    throw err;
  }
  log.info('Manifest updated', { step: '2/2' });

  return {
    found: true,
    version: dossierEntry.version,
    file: fileResult,
    manifest: manifestResult,
  };
}
