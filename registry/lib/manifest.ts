import { getErrorMessage } from '@ai-dossier/core';
import config from './config';
import { DOSSIER_DEFAULTS } from './constants';
import type { ManifestDossier } from './types';

// Fetches manifest via CDN for read-only list/search (fast, cached).
// Write operations (publish/delete) use github.getManifest() instead
// to access the sha needed for atomic updates via the GitHub API.
export async function fetchManifestDossiers(): Promise<ManifestDossier[]> {
  const manifestUrl = config.getManifestUrl();

  let response: Response;
  try {
    response = await fetch(manifestUrl);
  } catch (error) {
    throw new Error(`Failed to fetch manifest from ${manifestUrl}: ${getErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch manifest from ${manifestUrl}: HTTP ${response.status}`);
  }

  const manifest = (await response.json()) as { dossiers?: ManifestDossier[] };

  if (!Array.isArray(manifest.dossiers)) {
    throw new Error(`Invalid manifest from ${manifestUrl}: missing or malformed "dossiers" array`);
  }

  return manifest.dossiers;
}

export function normalizeDossier(dossier: ManifestDossier): ManifestDossier & { url: string } {
  if (!dossier.path) {
    throw new Error(`Cannot normalize dossier "${dossier.name}": missing path`);
  }

  return {
    name: dossier.name,
    title: dossier.title,
    version: dossier.version,
    path: dossier.path,
    description: dossier.description ?? DOSSIER_DEFAULTS.description,
    category: dossier.category ?? DOSSIER_DEFAULTS.category,
    tags: Array.isArray(dossier.tags) ? dossier.tags : DOSSIER_DEFAULTS.tags,
    authors: Array.isArray(dossier.authors) ? dossier.authors : DOSSIER_DEFAULTS.authors,
    tools_required: Array.isArray(dossier.tools_required)
      ? dossier.tools_required
      : DOSSIER_DEFAULTS.tools_required,
    url: config.getCdnUrl(dossier.path),
  };
}
