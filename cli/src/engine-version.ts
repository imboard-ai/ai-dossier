/**
 * Best-effort, cached, non-blocking check of whether the installed
 * `@ai-dossier/sched` is behind npm latest (#537 AC1).
 *
 * `docs/reports/batch-pilot-2-execution.md` §5 B2c: an engine host ran a
 * six-day-stale `@ai-dossier/sched` with a state file that stayed
 * schema-legacy-compatible throughout — schema comparison alone never would
 * have caught it. This is the signal that would have: compare the installed
 * version against npm registry latest, cached with a TTL so `sched
 * start --once` (cron-driven, possibly every minute) never hits the
 * registry on every tick, and never throws — a slow or unreachable registry
 * must not turn a fast cron tick into a hung one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPackageVersion } from './package-info';
import { getConfiguredTtlSeconds, isWithinTtl } from './ttl-cache';
import { compareVersions } from './version';

const SCHED_PACKAGE_NAME = '@ai-dossier/sched';
const CLI_PACKAGE_NAME = '@ai-dossier/cli';
const NPM_LATEST_TIMEOUT_MS = 3000;

export const ENGINE_VERSION_CACHE_DIR = path.join(
  os.homedir(),
  '.dossier',
  'cache',
  '.engine-version'
);
export const DEFAULT_ENGINE_VERSION_TTL_SECONDS = 300;

interface EngineVersionCacheRecord {
  latest_version: string;
  checked_at: string;
}

export interface EngineStalenessCheck {
  /** Installed package version, or null if it could not be resolved. */
  installed: string | null;
  /** npm registry latest for that package, or null when the best-effort check couldn't complete. */
  latest: string | null;
  /** True only when both versions are known and installed < latest. */
  stale: boolean;
}

function cachePath(packageName: string): string {
  return path.join(ENGINE_VERSION_CACHE_DIR, `${path.basename(packageName)}-latest.json`);
}

/**
 * A plausible dotted-numeric version string (npm's own `valid-semver`-ish
 * shape, permissive enough for prereleases/build metadata). Guards every
 * boundary this value crosses — cache file, journal, and stderr/terminal
 * output — against an oversized or control-character-laden value from a
 * compromised registry response or a hand-edited cache file (#537 review).
 */
const VERSION_FORMAT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function readCache(packageName: string): EngineVersionCacheRecord | null {
  try {
    const raw = fs.readFileSync(cachePath(packageName), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.latest_version === 'string' &&
      VERSION_FORMAT.test(parsed.latest_version) &&
      typeof parsed?.checked_at === 'string'
    ) {
      return parsed as EngineVersionCacheRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(packageName: string, record: EngineVersionCacheRecord): void {
  try {
    fs.mkdirSync(ENGINE_VERSION_CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath(packageName), JSON.stringify(record), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Best-effort — a failed cache write never blocks the check.
  }
}

async function fetchNpmLatest(packageName: string): Promise<string | null> {
  try {
    const registryName = packageName.startsWith('@')
      ? packageName.replace('/', '%2f')
      : packageName;
    const response = await fetch(`https://registry.npmjs.org/${registryName}/latest`, {
      signal: AbortSignal.timeout(NPM_LATEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== 'string' || !VERSION_FORMAT.test(body.version)) return null;
    return body.version;
  } catch (err) {
    if (process.env.DOSSIER_DEBUG) {
      process.stderr.write(
        `[engine-version] npm latest check for '${packageName}' failed: ${(err as Error).message}\n`
      );
    }
    return null;
  }
}

/**
 * Compare one installed engine package against npm registry latest.
 * Never throws.
 *
 * `opts.fresh` bypasses the TTL cache and forces a live fetch (used by
 * tests and by an explicit re-check). `opts.noFetch` does the opposite —
 * read the cache if it's warm, but never hit the network: `sched status` is
 * a fast, offline-friendly diagnostic command, so it reads whatever `sched
 * start` last cached instead of risking a multi-second hang on an
 * unreachable registry. `sched start`/`--once` is the process that performs
 * live fetches and refreshes the cache.
 */
async function checkPackageStaleness(
  packageName: string,
  opts: { fresh?: boolean; noFetch?: boolean } = {}
): Promise<EngineStalenessCheck> {
  const installed = getPackageVersion(packageName);
  const ttl = getConfiguredTtlSeconds(
    'cache.engineVersionTtlSeconds',
    DEFAULT_ENGINE_VERSION_TTL_SECONDS
  );

  let latest: string | null = null;
  const cached = opts.fresh ? null : readCache(packageName);
  if (cached && isWithinTtl(cached.checked_at, ttl)) {
    latest = cached.latest_version;
  }

  if (latest === null && !opts.noFetch) {
    latest = await fetchNpmLatest(packageName);
    if (latest !== null) {
      writeCache(packageName, { latest_version: latest, checked_at: new Date().toISOString() });
    }
  }

  const stale = installed !== null && latest !== null && compareVersions(installed, latest) < 0;
  return { installed, latest, stale };
}

/** Check the scheduler library version; `sched status` uses this offline-friendly view. */
export async function checkEngineStaleness(
  opts: { fresh?: boolean; noFetch?: boolean } = {}
): Promise<EngineStalenessCheck> {
  return checkPackageStaleness(SCHED_PACKAGE_NAME, opts);
}

/** Check the executable package too: CLI-only releases must also reach a running service. */
export async function checkCliStaleness(
  opts: { fresh?: boolean; noFetch?: boolean } = {}
): Promise<EngineStalenessCheck> {
  return checkPackageStaleness(CLI_PACKAGE_NAME, opts);
}

/**
 * The engine-stale warning text, shared by `sched status`'s rendered report
 * and `sched start`'s stderr warning (#537) — one wording to keep in sync.
 */
export function formatEngineStaleWarning(installed: string, latest: string): string {
  return `⚠ Engine stale: installed @ai-dossier/sched@${installed}, npm latest ${latest} — upgrade: npm i -g @ai-dossier/cli@latest`;
}

/** The CLI-specific warning, shared by the service loop's upgrade decision. */
export function formatCliStaleWarning(installed: string, latest: string): string {
  return `⚠ CLI stale: installed @ai-dossier/cli@${installed}, npm latest ${latest} — upgrade: npm i -g @ai-dossier/cli@latest`;
}
