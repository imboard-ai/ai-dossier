/**
 * Multi-registry parallel query orchestration.
 * Queries all configured registries in parallel using Promise.allSettled()
 * and merges results with source labels.
 */

import { sha256Hex } from '@ai-dossier/core';
import type { ResolvedRegistry } from './config';
import { resolveRegistries } from './config';
import { loadCredentials } from './credentials';
import type {
  DossierContentResult,
  DossierEvidenceResult,
  DossierInfo,
  DossierListItem,
  ListDossiersOptions,
  SearchOptions,
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

export interface MultiRegistryGetDossierResult {
  result: LabeledDossierInfo | null;
  errors: Array<{ registry: string; error: string }>;
}

export interface MultiRegistryGetContentResult {
  result: (DossierContentResult & { _registry: string }) | null;
  errors: Array<{ registry: string; error: string }>;
}

export interface MultiRegistryGetEvidenceResult {
  result: (DossierEvidenceResult & { _registry: string }) | null;
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
 * Search dossiers across all registries using server-side search.
 * Each registry filters results server-side; this function merges them.
 */
async function multiRegistrySearch(
  query: string,
  options: SearchOptions = {}
): Promise<MultiRegistrySearchResult> {
  const registries = resolveRegistries();

  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const result = await client.searchDossiers(query, options);
      const dossiers = (result.dossiers || []).map((d) => ({
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
 * Get dossier info from the first registry that has it.
 * Tries all registries in parallel, returns the first success.
 * Returns error details when all registries fail.
 * When DOSSIER_DEBUG is set, logs which registry served the request to stderr.
 */
async function multiRegistryGetDossier(
  name: string,
  version: string | null = null
): Promise<MultiRegistryGetDossierResult> {
  const registries = resolveRegistries();

  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const meta = await client.getDossier(name, version);
      return { ...meta, _registry: reg.name };
    })
  );

  const errors: Array<{ registry: string; error: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[multi-registry] getDossier '${name}' served by '${r.value._registry}'\n`
        );
      }
      return { result: r.value, errors: [] };
    }
    errors.push({
      registry: registries[i].name,
      error: r.reason?.message || String(r.reason),
    });
  }

  return { result: null, errors };
}

/** Delay before the single retry of a failed content fetch (#1240). */
const CONTENT_RETRY_DELAY_MS = 500;

/**
 * Returns a diagnostic error message when `content` does not match the registry's
 * `X-Dossier-Digest`, or null when it matches (or no digest was sent). The digest
 * carries an algorithm prefix (`sha256:<hex>`); sha256Hex returns bare hex.
 */
function contentDigestMismatch(reg: ResolvedRegistry, result: DossierContentResult): string | null {
  if (!result.digest) return null;
  const expected = result.digest.replace(/^sha256:/i, '').toLowerCase();
  const actual = sha256Hex(result.content).toLowerCase();
  if (actual === expected) return null;
  return (
    `checksum mismatch after download (url: ${result.url ?? reg.url}, ` +
    `status: ${result.status ?? 'unknown'}, expected sha256: ${expected}, actual sha256: ${actual})`
  );
}

/** A failure worth one retry: a digest mismatch or a not-found for content that may exist. */
function isTransientContentFailure(reason: unknown): boolean {
  const e = reason as { statusCode?: number; digestMismatch?: boolean; message?: string } | null;
  if (!e) return false;
  if (e.digestMismatch || e.statusCode === 404) return true;
  return /not found/i.test(e.message ?? '');
}

async function fetchContentOnce(
  registries: ResolvedRegistry[],
  name: string,
  version: string | null
): Promise<{ result: MultiRegistryGetContentResult; retryable: boolean }> {
  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const result = await client.getDossierContent(name, version);
      const mismatch = contentDigestMismatch(reg, result);
      if (mismatch) {
        throw Object.assign(new Error(mismatch), { digestMismatch: true });
      }
      return { ...result, _registry: reg.name };
    })
  );

  const errors: Array<{ registry: string; error: string }> = [];
  let retryable = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[multi-registry] getContent '${name}' served by '${r.value._registry}'\n`
        );
      }
      return { result: { result: r.value, errors: [] }, retryable: false };
    }
    if (isTransientContentFailure(r.reason)) retryable = true;
    errors.push({
      registry: registries[i].name,
      error: r.reason?.message || String(r.reason),
    });
  }

  return { result: { result: null, errors }, retryable };
}

/**
 * Get dossier content from the first registry that has it, verifying the
 * registry's digest. A registry whose content fails the digest check counts as
 * failed. When every registry fails and at least one failure was a digest
 * mismatch or not-found — both seen transiently (#1240) — the fetch is retried
 * once after a short delay. Returns error details (one per registry queried)
 * when all registries still fail.
 * When DOSSIER_DEBUG is set, logs which registry served the request to stderr.
 */
async function multiRegistryGetContent(
  name: string,
  version: string | null = null,
  { retryDelayMs = CONTENT_RETRY_DELAY_MS }: { retryDelayMs?: number } = {}
): Promise<MultiRegistryGetContentResult> {
  const registries = resolveRegistries();

  const first = await fetchContentOnce(registries, name, version);
  if (first.result.result || !first.retryable) return first.result;

  if (process.env.DOSSIER_DEBUG) {
    process.stderr.write(`[multi-registry] getContent '${name}' failed, retrying once\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return (await fetchContentOnce(registries, name, version)).result;
}

/**
 * Get dossier evidence sidecar from the first registry that has it.
 * Returns error details when all registries fail.
 * When DOSSIER_DEBUG is set, logs which registry served the request to stderr.
 */
async function multiRegistryGetEvidence(
  name: string,
  version: string | null = null
): Promise<MultiRegistryGetEvidenceResult> {
  const registries = resolveRegistries();

  const results = await Promise.allSettled(
    registries.map(async (reg) => {
      const token = getTokenForRegistry(reg.name);
      const client = getClientForRegistry(reg.url, token);
      const result = await client.getDossierEvidence(name, version);
      return { ...result, _registry: reg.name };
    })
  );

  const errors: Array<{ registry: string; error: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[multi-registry] getEvidence '${name}' served by '${r.value._registry}'\n`
        );
      }
      return { result: r.value, errors: [] };
    }
    errors.push({
      registry: registries[i].name,
      error: r.reason?.message || String(r.reason),
    });
  }

  return { result: null, errors };
}

export {
  multiRegistryList,
  multiRegistryListFrom,
  multiRegistrySearch,
  multiRegistryGetDossier,
  multiRegistryGetContent,
  multiRegistryGetEvidence,
};
