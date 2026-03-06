import { getErrorMessage } from '@ai-dossier/core';
import config from './config';
import { DOSSIER_DEFAULTS } from './constants';
import type { ManifestDossier } from './types';

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
    ...DOSSIER_DEFAULTS,
    ...dossier,
    url: config.getCdnUrl(dossier.path),
  };
}
