import config from './config';
import { DOSSIER_DEFAULTS } from './constants';
import type { ManifestDossier } from './types';

export async function fetchManifestDossiers(): Promise<ManifestDossier[]> {
  const manifestUrl = config.getManifestUrl();
  const response = await fetch(manifestUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status}`);
  }

  const manifest = (await response.json()) as { dossiers: ManifestDossier[] };
  return manifest.dossiers;
}

export function normalizeDossier(dossier: ManifestDossier): ManifestDossier & { url: string } {
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
