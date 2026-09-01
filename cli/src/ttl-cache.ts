/**
 * Shared TTL math for the CLI's cache-with-expiry files — `cache-resolver.ts`'s
 * dossier resolution cache and `engine-version.ts`'s npm-latest cache both
 * need "read a configured TTL in seconds, with a default" and "is this
 * timestamp still within that TTL" (#537 review — the two files had
 * near-line-for-line copies of both).
 *
 * File I/O itself stays per-module: `cache-resolver.ts`'s resolution files
 * need org-scoped-path safety and symlink-swap defense that
 * `engine-version.ts`'s single fixed-path cache file does not, so forcing a
 * shared read/write would either under-harden one or over-complicate the
 * other. Only the TTL math — which has no such asymmetry — is shared here.
 */

import { getConfig } from './config';

/** Read a `cache.*` TTL config key (seconds), falling back to `defaultSeconds` when unset/invalid. */
export function getConfiguredTtlSeconds(configKey: string, defaultSeconds: number): number {
  const raw = getConfig(configKey);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return defaultSeconds;
}

/** Whether an ISO timestamp is still within `ttlSeconds` of now (never negative-age). */
export function isWithinTtl(timestampIso: string, ttlSeconds: number): boolean {
  const ageMs = Date.now() - new Date(timestampIso).getTime();
  return ageMs >= 0 && ageMs < ttlSeconds * 1000;
}
