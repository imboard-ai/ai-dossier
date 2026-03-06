import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { safeDossierPath } from '../helpers';
import { getClient, parseNameVersion } from '../registry-client';

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Download a dossier from the registry to local cache')
    .argument('<name...>', 'Dossier name(s) (use name@version for a specific version)')
    .option('--force', 'Re-download even if already cached')
    .action(async (names: string[], options: { force?: boolean }) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');
      const client = getClient();

      for (const nameArg of names) {
        let [dossierName, version] = parseNameVersion(nameArg);

        try {
          if (!version) {
            const meta = await client.getDossier(dossierName);
            version = meta.version || 'latest';
          }

          const dossierDir = safeDossierPath(cacheDir, dossierName);
          const contentFile = path.join(dossierDir, `${version}.ds.md`);
          const metaFile = path.join(dossierDir, `${version}.meta.json`);

          if (!options.force && fs.existsSync(contentFile) && fs.existsSync(metaFile)) {
            console.log(`✅ ${dossierName}@${version} (already cached)`);
            console.log(`   ${contentFile}`);
            continue;
          }

          const result = await client.getDossierContent(dossierName, version);
          const content = result.content;
          const digest = result.digest;

          if (digest) {
            const actual = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
            if (actual !== digest) {
              console.error(`❌ ${dossierName}@${version}: checksum mismatch after download`);
              continue;
            }
          }

          fs.mkdirSync(dossierDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(contentFile, content, 'utf8');
          fs.writeFileSync(
            metaFile,
            JSON.stringify(
              {
                cached_at: new Date().toISOString(),
                version,
                source_registry_url: client.getRegistryBaseUrl(),
              },
              null,
              2
            ),
            'utf8'
          );

          const status = options.force ? 'updated' : 'downloaded';
          console.log(`✅ ${dossierName}@${version} (${status})`);
          console.log(`   ${contentFile}`);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          if (e.statusCode === 404) {
            console.error(`❌ ${nameArg}: not found in registry`);
          } else {
            console.error(`❌ ${nameArg}: ${e.message}`);
          }
        }
      }
    });
}
