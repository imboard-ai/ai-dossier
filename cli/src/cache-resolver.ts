/**
 * Versionless dossier name → resolved version mapping with TTL.
 *
 * Pinned versions (name@1.2.3) are content-addressable and never go stale.
 * Versionless names (name) are the only thing that ages, so the TTL belongs
 * on resolution, not on cached content bytes.
 *
 * Resolution cache lives at ~/.dossier/cache/.resolution/<name>.json, one
 * tiny file per dossier with { resolved_version, resolved_at, source_registry }.
 *
 * On registry failure, falls back to the highest-semver version already in
 * ~/.dossier/cache/<name>/ and prints a loud stderr warning so the staleness
 * is never silent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config';
import { safeDossierPath } from './helpers';
import { multiRegistryGetDossier } from './multi-registry';

export const DEFAULT_RESOLUTION_TTL_SECONDS = 300;
export const CACHE_DIR = path.join(os.homedir(), '.dossier', 'cache');
export const RESOLUTION_DIR = path.join(CACHE_DIR, '.resolution');

export interface ResolutionRecord {
  resolved_version: string;
  resolved_at: string;
  source_registry?: string;
}

export type ResolutionSource = 'cache' | 'registry' | 'stale-cache';

export interface ResolvedVersion {
  version: string;
  source: ResolutionSource;
  registry?: string;
  /** Present only when source === 'stale-cache' — explains why we did not reach the registry. */
  warning?: string;
}

export interface ResolveOptions {
  /** Skip the resolution cache and force a registry call. */
  fresh?: boolean;
  /** Override the TTL for this call. 0 forces a registry call. */
  maxAgeSeconds?: number;
}

function resolutionFilePath(dossierName: string): string {
  const safeDir = safeDossierPath(RESOLUTION_DIR, dossierName);
  return `${safeDir}.json`;
}

function readResolution(dossierName: string): ResolutionRecord | null {
  const file = resolutionFilePath(dossierName);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as ResolutionRecord;
    if (!parsed.resolved_version || !parsed.resolved_at) {
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[cache-resolver] resolution file ${file} missing required fields; ignoring\n`
        );
      }
      return null;
    }
    return parsed;
  } catch (err) {
    // Corrupted resolution file — warn (always) and fall through to re-resolve.
    // Silent fallback would hide a real corruption issue from operators.
    process.stderr.write(
      `⚠️  Resolution cache file unreadable (${file}): ${(err as Error).message}. Re-resolving from registry.\n`
    );
    return null;
  }
}

function writeResolution(dossierName: string, record: ResolutionRecord): void {
  const file = resolutionFilePath(dossierName);
  const targetDir = path.dirname(file);
  // Node's mkdir({recursive:true,mode}) only applies `mode` to the leaf directory it creates.
  // For org-scoped names (org/sub/name) we must chmod each intermediate dir under
  // RESOLUTION_DIR to 0o700 so resolution metadata never becomes world-readable.
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  let cursor = targetDir;
  while (cursor.startsWith(RESOLUTION_DIR) && cursor !== path.dirname(RESOLUTION_DIR)) {
    try {
      fs.chmodSync(cursor, 0o700);
    } catch {
      // best-effort; if chmod fails (e.g. not owner) we still proceed
    }
    if (cursor === RESOLUTION_DIR) break;
    cursor = path.dirname(cursor);
  }
  // Defend against symlink swap: if a non-regular file (symlink, fifo, etc.) sits at
  // the target path, refuse to write through it. lstat does not follow symlinks.
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) {
      fs.unlinkSync(file);
    }
  } catch {
    // ENOENT — fine, fresh write
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Highest-semver version currently cached on disk for this name, or null. */
export function highestCachedSemver(dossierName: string): string | null {
  try {
    const dir = safeDossierPath(CACHE_DIR, dossierName);
    if (!fs.existsSync(dir)) return null;
    const versions = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => f.replace('.meta.json', ''))
      .filter((v) => fs.existsSync(path.join(dir, `${v}.ds.md`)))
      .sort(compareSemver);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  } catch {
    return null;
  }
}

function getConfiguredTtlSeconds(): number {
  const raw = getConfig('cache.resolutionTtlSeconds');
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_RESOLUTION_TTL_SECONDS;
}

function formatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Resolve a versionless dossier name to a concrete version.
 *
 * Flow:
 *   1. If !fresh and a resolution file exists and is within TTL → return cached resolution.
 *   2. Otherwise call the registry. On success → write resolution file → return.
 *   3. On registry failure → fall back to highest-semver cached version with a
 *      loud stderr warning. If nothing is cached, rethrow.
 *
 * Callers should pass an already-stripped name (without @version suffix). For
 * pinned versions, skip this resolver entirely.
 */
export async function resolveCachedVersion(
  dossierName: string,
  opts: ResolveOptions = {}
): Promise<ResolvedVersion> {
  const ttl = opts.maxAgeSeconds ?? getConfiguredTtlSeconds();

  if (!opts.fresh && ttl > 0) {
    const cached = readResolution(dossierName);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.resolved_at).getTime();
      if (ageMs >= 0 && ageMs < ttl * 1000) {
        if (process.env.DOSSIER_DEBUG) {
          process.stderr.write(
            `[cache-resolver] '${dossierName}' served from resolution cache: ` +
              `version=${cached.resolved_version}, age=${formatAge(ageMs)}, ttl=${ttl}s, registry=${cached.source_registry ?? 'unknown'}\n`
          );
        }
        return {
          version: cached.resolved_version,
          source: 'cache',
          registry: cached.source_registry,
        };
      }
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[cache-resolver] '${dossierName}' resolution cache expired (age=${formatAge(ageMs)}, ttl=${ttl}s); re-resolving\n`
        );
      }
    } else if (process.env.DOSSIER_DEBUG) {
      process.stderr.write(
        `[cache-resolver] '${dossierName}' has no resolution cache; calling registry\n`
      );
    }
  } else if (process.env.DOSSIER_DEBUG) {
    process.stderr.write(
      `[cache-resolver] '${dossierName}' bypassing resolution cache (fresh=${opts.fresh ?? false}, ttl=${ttl}s)\n`
    );
  }

  let registryError: Error | null = null;
  try {
    const { result, errors } = await multiRegistryGetDossier(dossierName);
    if (result?.version) {
      writeResolution(dossierName, {
        resolved_version: result.version,
        resolved_at: new Date().toISOString(),
        source_registry: result._registry,
      });
      if (process.env.DOSSIER_DEBUG) {
        process.stderr.write(
          `[cache-resolver] '${dossierName}' resolved from registry '${result._registry}' to version ${result.version}\n`
        );
      }
      return { version: result.version, source: 'registry', registry: result._registry };
    }
    const message = errors.length > 0 ? errors.map((e) => e.error).join('; ') : 'no result';
    registryError = new Error(message);
  } catch (err) {
    registryError = err as Error;
  }

  // Registry unreachable — try stale fallback.
  const fallback = highestCachedSemver(dossierName);
  const lastKnown = readResolution(dossierName);
  if (fallback) {
    const ageHint = lastKnown
      ? ` (last successful check: ${formatAge(Date.now() - new Date(lastKnown.resolved_at).getTime())})`
      : ' (no record of last successful check)';
    const warning =
      `Registry unreachable — falling back to cached ${dossierName}@${fallback}${ageHint}.\n` +
      `   Cause: ${registryError?.message ?? 'unknown'}\n` +
      `   This may be stale. To force a fresh check once registry is reachable, re-run with --fresh ` +
      `(or --max-age 0).`;
    process.stderr.write(`⚠️  ${warning}\n`);
    return {
      version: fallback,
      source: 'stale-cache',
      registry: lastKnown?.source_registry,
      warning,
    };
  }

  throw new Error(
    `Failed to resolve ${dossierName}: registry unreachable and no cached version available.\n` +
      `   Underlying error: ${registryError?.message ?? 'unknown'}\n` +
      `   Try:\n` +
      `     1. Check network connectivity\n` +
      `     2. Verify registry is configured:  dossier config --list-registries\n` +
      `     3. Pin a known-good version:       dossier run ${dossierName}@<version>\n` +
      `     4. Re-run with --fresh once the registry is reachable.`
  );
}

/** Exposed for the `cache resolutions` subcommand. */
export function listResolutions(): Array<{ name: string; record: ResolutionRecord }> {
  if (!fs.existsSync(RESOLUTION_DIR)) return [];

  const entries: Array<{ name: string; record: ResolutionRecord }> = [];

  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.json')) {
        try {
          const record = JSON.parse(fs.readFileSync(full, 'utf8')) as ResolutionRecord;
          if (record.resolved_version && record.resolved_at) {
            const name = entry.name.replace(/\.json$/, '');
            entries.push({ name: prefix ? `${prefix}/${name}` : name, record });
          }
        } catch {
          // skip invalid entries
        }
      }
    }
  }

  walk(RESOLUTION_DIR, '');
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** Exposed for tests and the `cache clean` flow — remove all resolution files. */
export function clearResolutions(): void {
  if (fs.existsSync(RESOLUTION_DIR)) {
    fs.rmSync(RESOLUTION_DIR, { recursive: true, force: true });
  }
}

/**
 * Path to a cached dossier's content file (without checking existence).
 * Centralises the `<cache>/<name>/<version>.ds.md` layout used by
 * run/create/install-skill/pull so layout changes happen in one place.
 */
export function cachedContentPath(dossierName: string, version: string): string {
  return path.join(safeDossierPath(CACHE_DIR, dossierName), `${version}.ds.md`);
}

/**
 * Return cached dossier content as a string, or null if not cached.
 * Single source of truth for the `existsSync(contentFile) ? read : miss`
 * block that previously lived in run.ts, create.ts, and install-skill.ts.
 */
export function readCachedContent(dossierName: string, version: string): string | null {
  const file = cachedContentPath(dossierName, version);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a dossier's content + .meta.json to the cache.
 *
 * The .meta.json shape (`cached_at` + `version` + `source_registry`) is the
 * one read by `cache list` / `cache clean` and was previously duplicated
 * verbatim in run.ts, create.ts, install-skill.ts, and pull.ts.
 *
 * Best-effort by default (errors swallowed, matching create.ts/install-skill.ts).
 * Pass `throwOnError: true` for callers that want to surface write failures
 * (pull.ts wants this — a failed download cache write is a hard failure).
 */
export function writeCachedContent(
  dossierName: string,
  version: string,
  content: string,
  sourceRegistry: string | undefined,
  opts: { throwOnError?: boolean } = {}
): void {
  const dir = safeDossierPath(CACHE_DIR, dossierName);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${version}.ds.md`), content, 'utf8');
    fs.writeFileSync(
      path.join(dir, `${version}.meta.json`),
      JSON.stringify(
        {
          cached_at: new Date().toISOString(),
          version,
          source_registry: sourceRegistry,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    if (opts.throwOnError) throw err;
    // best-effort: swallow (matches prior create.ts / install-skill.ts behaviour)
  }
}

/**
 * Parse a `--max-age <seconds>` CLI option into a number, or return undefined
 * when unset. Throws when the value is provided but not a valid number.
 * Used by run/create/install-skill which all expose the same flag.
 */
export function parseMaxAgeOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`--max-age must be a number (got "${raw}")`);
  }
  return n;
}
