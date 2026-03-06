/**
 * Multi-registry parallel query orchestration.
 * Queries all configured registries in parallel using Promise.allSettled()
 * and merges results with source labels.
 */

import type { ResolvedRegistry } from './config';
import { resolveRegistries } from './config';
import { loadCredentials } from './credentials';
import type {
  DossierContentResult,
  DossierInfo,
  DossierListItem,
  ListDossiersOptions,
} from './registry-client';
import { getClientForRegistry } from './registry-client';

export interface LabeledDossierListItem extends DossierListItem {
  _registry: string;
}

export interface LabeledDossierInfo extends DossierInfo {
  _registry: string;
}

export interface MultiRegistryListResult {
  dossiers: LabeledDossierListItem[];
  total: number;
  errors: Array<{ registry: string; error: string }>;
}

export interface MultiRegistrySearchResult {
  dossiers: LabeledDossierListItem[];
  total: number;
  errors: Array<{ registry: string; error: string }>;
}

function getTokenForRegistry(registryName: string): string | null {
  const creds = loadCredentials(registryName);
  return creds?.token || null;
}

/**
 * List dossiers from all configured registries in parallel.
 */
async function multiRegistryList(
  options: ListDossiersOptions = {}
): Promise<MultiRegistryListResult> {
  const registries = resolveRegistries();
  return multiRegistryListFrom(registries, options);
}

/**
 * List dossiers from specified registries in parallel.
 */
async function multiRegistryListFrom(
  registries: ResolvedRegistry[],
  options: ListDossiersOptions = {}
): Promise<MultiRegistryListResult> {
  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const result = await client.listDossiers(options);
      const dossiers = (result.dossiers || result.data || []).map((d) => ({
        ...d,
        _registry: reg.name,
      }));
      return { dossiers, total: result.total || dossiers.length };
    })
  );

  const allDossiers: LabeledDossierListItem[] = [];
  const errors: Array<{ registry: string; error: string }> = [];
  let total = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allDossiers.push(...result.value.dossiers);
      total += result.value.total;
    } else {
      errors.push({
        registry: registries[i].name,
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  return { dossiers: allDossiers, total, errors };
}

/**
 * Search dossiers across all registries.
 * Fetches all dossiers and filters client-side (same as single-registry search).
 */
async function multiRegistrySearch(
  query: string,
  options: ListDossiersOptions = {}
): Promise<MultiRegistrySearchResult> {
  const listResult = await multiRegistryList({ ...options, page: 1, perPage: 100 });

  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter(Boolean);

  const matched = listResult.dossiers.filter((d) => {
    const fields = [
      d.name || '',
      d.title || '',
      d.description || d.objective || '',
      ...(Array.isArray(d.category) ? d.category : [d.category || '']),
      ...(d.tags || []),
    ]
      .map((f) => String(f).toLowerCase())
      .join(' ');

    return terms.every((term) => fields.includes(term) || fields.indexOf(term) !== -1);
  });

  return {
    dossiers: matched,
    total: matched.length,
    errors: listResult.errors,
  };
}

/**
 * Get dossier info from the first registry that has it.
 * Tries all registries in parallel, returns the first success.
 */
async function multiRegistryGetDossier(
  name: string,
  version: string | null = null
): Promise<LabeledDossierInfo | null> {
  const registries = resolveRegistries();

  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const meta = await client.getDossier(name, version);
      return { ...meta, _registry: reg.name };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      return result.value;
    }
  }

  return null;
}

/**
 * Get dossier content from the first registry that has it.
 */
async function multiRegistryGetContent(
  name: string,
  version: string | null = null
): Promise<(DossierContentResult & { _registry: string }) | null> {
  const registries = resolveRegistries();

  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const result = await client.getDossierContent(name, version);
      return { ...result, _registry: reg.name };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      return result.value;
    }
  }

  return null;
}

export {
  multiRegistryList,
  multiRegistryListFrom,
  multiRegistrySearch,
  multiRegistryGetDossier,
  multiRegistryGetContent,
};
