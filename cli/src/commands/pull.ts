import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '@ai-dossier/core';
import type { Command } from 'commander';
import { cachedContentPath, writeCachedContent } from '../cache-resolver';
import { printRegistryErrors, safeDossierPath } from '../helpers';
import { multiRegistryGetContent, multiRegistryGetDossier } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

/** Registers the `pull` command — downloads dossiers from the registry to local cache. */
export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description(
      'Download a dossier from the registry to local cache. Searches all configured registries.'
    )
    .argument('<name...>', 'Dossier name(s) (use name@version for a specific version)')
    .option('--force', 'Re-download even if already cached')
    .action(async (names: string[], options: { force?: boolean }) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');
      let failures = 0;

      for (const nameArg of names) {
        let [dossierName, version] = parseNameVersion(nameArg);

        try {
          if (!version) {
            const { result: meta, errors: metaErrors } = await multiRegistryGetDossier(dossierName);
            if (!meta) {
              console.error(`❌ ${nameArg}: not found in any registry`);
              printRegistryErrors(metaErrors);
              failures++;
              continue;
            }
            version = meta.version || 'latest';
          }

          const dossierDir = safeDossierPath(cacheDir, dossierName);
          const contentFile = cachedContentPath(dossierName, version);
          const metaFile = path.join(dossierDir, `${version}.meta.json`);

          if (!options.force && fs.existsSync(contentFile) && fs.existsSync(metaFile)) {
            console.log(`✅ ${dossierName}@${version} (already cached)`);
            console.log(`   ${contentFile}`);
            continue;
          }

          const { result, errors: contentErrors } = await multiRegistryGetContent(
            dossierName,
            version
          );
          if (!result) {
            console.error(`❌ ${nameArg}: not found in any registry`);
            printRegistryErrors(contentErrors);
            failures++;
            continue;
          }
          const content = result.content;
          const digest = result.digest;

          if (digest) {
            const actual = sha256Hex(content);
            // The registry sends the digest with an algorithm prefix (e.g.
            // `sha256:<hex>`); sha256Hex returns the bare hex. Strip the prefix
            // and compare case-insensitively so a valid download is not rejected
            // purely because of the `sha256:` label.
            const expected = digest.replace(/^sha256:/i, '');
            if (actual.toLowerCase() !== expected.toLowerCase()) {
              console.error(`❌ ${dossierName}@${version}: checksum mismatch after download`);
              failures++;
              continue;
            }
          }

          try {
            writeCachedContent(dossierName, version, content, result._registry, {
              throwOnError: true,
            });
          } catch (writeErr: unknown) {
            console.error(
              `❌ ${dossierName}@${version}: failed to write cache files to '${dossierDir}': ${(writeErr as Error).message}`
            );
            failures++;
            continue;
          }

          const status = options.force ? 'updated' : 'downloaded';
          console.log(`✅ ${dossierName}@${version} (${status}) [${result._registry}]`);
          console.log(`   ${contentFile}`);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          if (e.statusCode === 404) {
            console.error(`❌ ${nameArg}: not found in registry`);
          } else {
            console.error(`❌ ${nameArg}: ${e.message}`);
          }
          failures++;
        }
      }

      if (failures === names.length) {
        process.exit(1);
      }
    });
}
