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
    ...DOSSIER_DEFAULTS,
    ...dossier,
    url: config.getCdnUrl(dossier.path),
  };
}
