import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sha256Hex } from '@ai-dossier/core';
import type { Command } from 'commander';
import {
  DEFAULT_RESOLUTION_TTL_SECONDS,
  highestCachedSemver,
  listResolutions,
  writeCachedContent,
  writeResolution,
} from '../cache-resolver';
import { getConfig } from '../config';
import { printRegistryErrors, safeDossierPath } from '../helpers';
import { multiRegistryGetContent, multiRegistryGetDossier } from '../multi-registry';

function formatAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

interface CachedDossierEntry {
  name: string;
  version: string;
  size: number;
  cached_at: string;
  path: string;
}

/** Walk ~/.dossier/cache and return one entry per cached (name, version). */
function walkCachedDossiers(cacheDir: string): CachedDossierEntry[] {
  const entries: CachedDossierEntry[] = [];
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.meta.json')) {
        try {
          const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
          const version = entry.name.replace('.meta.json', '');
          const contentFile = path.join(dir, `${version}.ds.md`);
          if (!fs.existsSync(contentFile)) return;
          const rel = path.relative(cacheDir, dir);
          const stats = fs.statSync(contentFile);
          entries.push({
            name: rel,
            version,
            size: stats.size,
            cached_at: meta.cached_at,
            path: contentFile,
          });
        } catch {
          // skip invalid entries
        }
      }
    }
  }
  walk(cacheDir);
  return entries;
}

export function registerCacheCommand(program: Command): void {
  const cacheCmd = program.command('cache').description('Manage local dossier cache');

  // cache resolutions
  cacheCmd
    .command('resolutions')
    .description('Show cached versionless → version resolutions (with age and TTL status)')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const entries = listResolutions();

      // Effective TTL from config (same precedence cache-resolver uses)
      const configuredTtl = getConfig('cache.resolutionTtlSeconds');
      const ttlSeconds =
        typeof configuredTtl === 'number' && Number.isFinite(configuredTtl) && configuredTtl >= 0
          ? configuredTtl
          : DEFAULT_RESOLUTION_TTL_SECONDS;

      const now = Date.now();
      const enriched = entries.map((e) => {
        const resolvedAtMs = new Date(e.record.resolved_at).getTime();
        const ageMs = Number.isFinite(resolvedAtMs) ? now - resolvedAtMs : null;
        const expired = ageMs !== null && ttlSeconds > 0 ? ageMs >= ttlSeconds * 1000 : false;
        return { ...e, ageMs, expired };
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ttl_seconds: ttlSeconds,
              entries: enriched.map((e) => ({
                name: e.name,
                resolved_version: e.record.resolved_version,
                resolved_at: e.record.resolved_at,
                source_registry: e.record.source_registry,
                age_seconds: e.ageMs !== null ? Math.round(e.ageMs / 1000) : null,
                expired: e.expired,
              })),
            },
            null,
            2
          )
        );
        process.exit(0);
      }

      if (entries.length === 0) {
        console.log('\nNo version resolutions cached.');
        console.log(`(TTL: ${ttlSeconds}s — set via cache.resolutionTtlSeconds or --max-age)\n`);
        process.exit(0);
      }

      console.log(`\n🔖 Cached resolutions (${entries.length}), TTL: ${ttlSeconds}s:\n`);
      console.log(
        `  ${'NAME'.padEnd(40)} ${'VERSION'.padEnd(10)} ${'REGISTRY'.padEnd(10)} ${'AGE'.padEnd(8)} STATUS`
      );
      console.log(
        `  ${'─'.repeat(40)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)}`
      );
      for (const e of enriched) {
        const registry = e.record.source_registry || '-';
        const age = e.ageMs !== null ? formatAge(e.ageMs) : '?';
        const status = e.ageMs === null ? 'invalid' : e.expired ? 'EXPIRED' : 'fresh';
        console.log(
          `  ${e.name.padEnd(40)} ${e.record.resolved_version.padEnd(10)} ${registry.padEnd(10)} ${age.padEnd(8)} ${status}`
        );
      }
      console.log('');
      console.log(
        '  Tip: EXPIRED entries are re-resolved on next run. Use --max-age 0 or --fresh to force a recheck.\n'
      );
      process.exit(0);
    });

  // cache list
  cacheCmd
    .command('list')
    .description('Show all cached dossiers')
    .option('--json', 'Output as JSON')
    .option('--size', 'Show file sizes')
    .action((options: { json?: boolean; size?: boolean }) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');

      if (!fs.existsSync(cacheDir)) {
        if (options.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log('\nNo cached dossiers.\n');
        }
        process.exit(0);
      }

      const entries = walkCachedDossiers(cacheDir);

      if (entries.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log('\nNo cached dossiers.\n');
        }
        process.exit(0);
      }

      entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        process.exit(0);
      }

      function formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
      }

      console.log(`\n📦 Cached dossiers (${entries.length}):\n`);
      if (options.size) {
        console.log(`  ${'NAME'.padEnd(40)} ${'VERSION'.padEnd(10)} ${'SIZE'.padEnd(8)} CACHED AT`);
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(19)}`);
      } else {
        console.log(`  ${'NAME'.padEnd(40)} ${'VERSION'.padEnd(10)} CACHED AT`);
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(10)} ${'─'.repeat(19)}`);
      }

      for (const e of entries) {
        const date = e.cached_at ? e.cached_at.slice(0, 19).replace('T', ' ') : '';
        if (options.size) {
          console.log(
            `  ${e.name.padEnd(40)} ${e.version.padEnd(10)} ${formatSize(e.size).padEnd(8)} ${date}`
          );
        } else {
          console.log(`  ${e.name.padEnd(40)} ${e.version.padEnd(10)} ${date}`);
        }
      }
      console.log('');
      process.exit(0);
    });

  // cache refresh
  cacheCmd
    .command('refresh')
    .description('Re-fetch the latest published version for cached dossiers')
    .argument('[name...]', 'Specific dossier name(s) to refresh (default: all cached)')
    .option('--json', 'Output a machine-readable summary')
    .action(async (names: string[], options: { json?: boolean }) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');

      if (!fs.existsSync(cacheDir)) {
        if (options.json) {
          console.log(
            JSON.stringify({ total: 0, refreshed: [], up_to_date: [], failed: [] }, null, 2)
          );
        } else {
          console.log('\nNo cached dossiers to refresh.\n');
        }
        return;
      }

      const entries = walkCachedDossiers(cacheDir);

      // Resolve the target set: explicit names if provided, otherwise every cached name.
      let targets: string[];
      if (names.length > 0) {
        targets = names;
      } else {
        targets = [...new Set(entries.map((e) => e.name))].sort();
        if (targets.length === 0) {
          if (options.json) {
            console.log(
              JSON.stringify({ total: 0, refreshed: [], up_to_date: [], failed: [] }, null, 2)
            );
          } else {
            console.log('\nNo cached dossiers to refresh.\n');
          }
          return;
        }
      }

      const refreshed: Array<{ name: string; old_version: string; new_version: string }> = [];
      const upToDate: Array<{ name: string; version: string }> = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const name of targets) {
        // For named refresh, a name that isn't cached is a user error — point at `pull`.
        if (names.length > 0 && !entries.some((e) => e.name === name)) {
          const msg = `not cached (use \`dossier pull ${name}\` to fetch it)`;
          failed.push({ name, error: msg });
          if (!options.json) {
            console.error(`❌ ${name}: ${msg}`);
          }
          continue;
        }

        try {
          const oldVersion = highestCachedSemver(name);

          // Resolve the latest published version directly from the registry.
          // (Not via resolveCachedVersion — its stale-fallback would mask registry
          // failures, and refresh must report those as failures.)
          const { result: meta, errors: metaErrors } = await multiRegistryGetDossier(name);
          if (!meta || !meta.version) {
            const msg =
              metaErrors.length > 0 ? metaErrors.map((e) => e.error).join('; ') : 'not found';
            failed.push({ name, error: msg });
            if (!options.json) {
              console.error(`❌ ${name}: ${msg}`);
              printRegistryErrors(metaErrors);
            }
            continue;
          }

          const newVersion = meta.version;
          const registry = meta._registry;

          // Same version already cached — refresh the resolution timestamp and skip the
          // (byte-identical) content re-download.
          if (oldVersion && oldVersion === newVersion) {
            writeResolution(name, {
              resolved_version: newVersion,
              resolved_at: new Date().toISOString(),
              source_registry: registry,
            });
            upToDate.push({ name, version: newVersion });
            if (!options.json) {
              console.log(`✅ ${name}@${newVersion} (already latest)`);
            }
            continue;
          }

          // Version changed (or content missing) — fetch the new content.
          const { result, errors: contentErrors } = await multiRegistryGetContent(name, newVersion);
          if (!result) {
            const msg =
              contentErrors.length > 0
                ? contentErrors.map((e) => e.error).join('; ')
                : 'content not found';
            failed.push({ name, error: msg });
            if (!options.json) {
              console.error(`❌ ${name}: ${msg}`);
              printRegistryErrors(contentErrors);
            }
            continue;
          }

          if (result.digest) {
            const actual = sha256Hex(result.content);
            // Registry sends the digest with an algorithm prefix (e.g. `sha256:<hex>`);
            // sha256Hex returns the bare hex. Strip the prefix and compare
            // case-insensitively so a valid download isn't rejected over the label.
            const expected = result.digest.replace(/^sha256:/i, '');
            if (actual.toLowerCase() !== expected.toLowerCase()) {
              failed.push({ name, error: 'checksum mismatch after refresh' });
              if (!options.json) {
                console.error(`❌ ${name}@${newVersion}: checksum mismatch after refresh`);
              }
              continue;
            }
          }

          try {
            writeCachedContent(name, newVersion, result.content, registry, {
              throwOnError: true,
            });
          } catch (writeErr: unknown) {
            const msg = `failed to write cache: ${(writeErr as Error).message}`;
            failed.push({ name, error: msg });
            if (!options.json) {
              console.error(`❌ ${name}@${newVersion}: ${msg}`);
            }
            continue;
          }

          // Content is now cached for the new version — refresh the resolution record.
          writeResolution(name, {
            resolved_version: newVersion,
            resolved_at: new Date().toISOString(),
            source_registry: registry,
          });

          refreshed.push({
            name,
            old_version: oldVersion ?? '<none>',
            new_version: newVersion,
          });
          if (!options.json) {
            console.log(`🔄 ${name}: ${oldVersion ?? '<none>'} → ${newVersion}`);
          }
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          const msg = e.statusCode === 404 ? 'not found in registry' : e.message;
          failed.push({ name, error: msg });
          if (!options.json) {
            console.error(`❌ ${name}: ${msg}`);
          }
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              total: targets.length,
              refreshed,
              up_to_date: upToDate,
              failed,
            },
            null,
            2
          )
        );
      } else {
        console.log(
          `\n${refreshed.length} refreshed, ${upToDate.length} up-to-date, ${failed.length} failed.`
        );
      }

      if (failed.length === targets.length && targets.length > 0) {
        process.exit(1);
      }
    });

  // cache clean
  cacheCmd
    .command('clean')
    .description('Remove cached dossiers')
    .argument('[name]', 'Specific dossier to remove')
    .option('-V, --ver <version>', 'Remove specific version only')
    .option('--older-than <days>', 'Remove entries older than N days')
    .option('--all', 'Remove all cached dossiers')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        name: string | undefined,
        options: { ver?: string; olderThan?: string; all?: boolean; yes?: boolean }
      ) => {
        const cacheDir = path.join(os.homedir(), '.dossier', 'cache');

        if (!fs.existsSync(cacheDir)) {
          console.log('\nNo cached dossiers.\n');
          process.exit(0);
        }

        async function confirm(msg: string): Promise<boolean> {
          if (options.yes) return true;
          if (!process.stdin.isTTY) {
            console.error(
              '\n❌ Non-interactive session detected. Use -y/--yes to skip confirmation.\n'
            );
            process.exit(1);
          }
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`${msg} (y/N) `, resolve);
          });
          rl.close();
          return answer.toString().toLowerCase() === 'y';
        }

        function rmDir(dir: string): void {
          fs.rmSync(dir, { recursive: true, force: true });
          let parent = path.dirname(dir);
          while (parent !== cacheDir && parent.startsWith(cacheDir)) {
            try {
              const contents = fs.readdirSync(parent);
              if (contents.length === 0) {
                fs.rmdirSync(parent);
                parent = path.dirname(parent);
              } else {
                break;
              }
            } catch {
              break;
            }
          }
        }

        if (options.all) {
          if (!(await confirm('Remove ALL cached dossiers?'))) {
            console.log('\nAborted.\n');
            process.exit(0);
          }
          fs.rmSync(cacheDir, { recursive: true, force: true });
          console.log('\n✅ Cache cleared.\n');
          process.exit(0);
        }

        if (options.olderThan) {
          const days = parseInt(options.olderThan, 10);
          if (Number.isNaN(days) || days <= 0) {
            console.error('\n❌ --older-than must be a positive number\n');
            process.exit(1);
          }

          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          let count = 0;

          function walkClean(dir: string): void {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkClean(full);
              } else if (entry.name.endsWith('.meta.json')) {
                try {
                  const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
                  if (meta.cached_at && new Date(meta.cached_at).getTime() < cutoff) {
                    const version = entry.name.replace('.meta.json', '');
                    const contentFile = path.join(dir, `${version}.ds.md`);
                    fs.unlinkSync(full);
                    if (fs.existsSync(contentFile)) fs.unlinkSync(contentFile);
                    count++;
                  }
                } catch {
                  // skip
                }
              }
            }
          }

          if (!(await confirm(`Remove dossiers cached more than ${days} days ago?`))) {
            console.log('\nAborted.\n');
            process.exit(0);
          }

          walkClean(cacheDir);
          console.log(`\n✅ Removed ${count} cached dossier(s).\n`);
          process.exit(0);
        }

        if (name) {
          const dossierDir = safeDossierPath(cacheDir, name);
          if (!fs.existsSync(dossierDir)) {
            console.error(`\n❌ Not cached: ${name}\n`);
            process.exit(1);
          }

          if (options.ver) {
            const contentFile = path.join(dossierDir, `${options.ver}.ds.md`);
            const metaFile = path.join(dossierDir, `${options.ver}.meta.json`);
            if (!fs.existsSync(contentFile) && !fs.existsSync(metaFile)) {
              console.error(`\n❌ Version ${options.ver} not cached for ${name}\n`);
              process.exit(1);
            }
            if (fs.existsSync(contentFile)) fs.unlinkSync(contentFile);
            if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
            console.log(`\n✅ Removed: ${name}@${options.ver}\n`);
          } else {
            if (!(await confirm(`Remove all cached versions of '${name}'?`))) {
              console.log('\nAborted.\n');
              process.exit(0);
            }
            rmDir(dossierDir);
            console.log(`\n✅ Removed: ${name} (all versions)\n`);
          }
          process.exit(0);
        }

        console.log('\nUsage:');
        console.log('  dossier cache clean <name>              Remove all versions of a dossier');
        console.log('  dossier cache clean <name> --ver X      Remove specific version');
        console.log('  dossier cache clean --older-than <days>  Remove stale entries');
        console.log('  dossier cache clean --all                Remove everything');
        console.log('');
        process.exit(0);
      }
    );
}
