import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  type DossierFrontmatter,
  parseDossierContent,
  validateFrontmatter,
} from '@ai-dossier/core';
import type { Command } from 'commander';
import { isExpired, loadCredentials } from '../credentials';
import { getClient } from '../registry-client';

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish a dossier to the registry')
    .argument('<file>', 'Dossier file to publish')
    .option('--changelog <message>', 'Changelog message for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--namespace <namespace>', 'Override namespace (e.g., imboard-ai/skills)')
    .option('--json', 'Output as JSON')
    .action(
      async (
        file: string,
        options: { changelog?: string; yes?: boolean; namespace?: string; json?: boolean }
      ) => {
        const credentials = loadCredentials();
        if (!credentials) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { published: false, error: 'Not logged in', code: 'not_logged_in' },
                null,
                2
              )
            );
          } else {
            console.error('\n❌ Not logged in. Run `dossier login` first.\n');
          }
          process.exit(1);
        }
        if (isExpired(credentials)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { published: false, error: 'Credentials expired', code: 'expired' },
                null,
                2
              )
            );
          } else {
            console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
          }
          process.exit(1);
        }

        const dossierFile = path.resolve(file);
        if (!fs.existsSync(dossierFile)) {
          console.error(`\n❌ File not found: ${dossierFile}\n`);
          process.exit(1);
        }

        const content = fs.readFileSync(dossierFile, 'utf8');

        let frontmatter: DossierFrontmatter;
        let body: string;
        try {
          const parsed = parseDossierContent(content);
          frontmatter = parsed.frontmatter;
          body = parsed.body;
        } catch (err: unknown) {
          console.error(`\n❌ ${(err as Error).message}\n`);
          process.exit(1);
        }

        const errors = validateFrontmatter(frontmatter as DossierFrontmatter);
        if (errors.length > 0) {
          console.error('\n❌ Validation errors:');
          for (const err of errors) {
            console.error(`   - ${err}`);
          }
          console.error('');
          process.exit(1);
        }

        const existingHash = frontmatter.checksum?.hash;
        if (existingHash) {
          const actualHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
          if (existingHash !== actualHash) {
            console.error(
              '\n❌ Checksum mismatch - content has been modified without updating checksum'
            );
            console.error(`   Expected: ${existingHash}`);
            console.error(`   Actual:   ${actualHash}`);
            console.error(`\n   Run 'dossier checksum ${file} --update' to fix\n`);
            process.exit(1);
          }
        }

        const namespace =
          options.namespace ||
          (credentials.orgs.length > 0 ? credentials.orgs[0] : credentials.username);
        const name = frontmatter.name || frontmatter.title || path.basename(dossierFile, '.ds.md');
        const version = frontmatter.version || 'unknown';
        const fullPath = `${namespace}/${name}`;
        const registryPath = `${fullPath}@${version}`;

        // Pre-publish existence check — version-specific via registry API
        const client = getClient(credentials.token);
        let existingVersion: string | null = null;
        let versionExists = false;
        try {
          const existing = await client.getDossier(fullPath, version);
          if (existing && existing.version === version) {
            versionExists = true;
          }
        } catch {
          // 404 = version doesn't exist (expected), other errors = warn but don't block
        }

        if (versionExists) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  published: false,
                  error: `${registryPath} already exists`,
                  code: 'version_exists',
                  name: fullPath,
                  version,
                },
                null,
                2
              )
            );
          } else {
            console.error(`\n❌ Version collision: ${registryPath} already exists.`);
            console.error('   Bump the version in your dossier and try again.\n');
          }
          process.exit(1);
          return;
        }

        // Check if dossier exists at any version (for overwrite warning)
        try {
          const existing = await client.getDossier(fullPath);
          if (existing) {
            existingVersion = existing.version || null;
          }
        } catch {
          // Ignore — dossier doesn't exist or check failed
        }

        if (!options.yes) {
          if (!process.stdin.isTTY) {
            console.error(
              '\n❌ Non-interactive session detected. Use -y/--yes to skip confirmation.\n'
            );
            process.exit(1);
          }

          console.log('\n📦 Publishing dossier:\n');
          console.log(`   Registry:  ${registryPath}`);
          console.log(`   File:      ${path.basename(dossierFile)}`);
          if (options.changelog) {
            console.log(`   Changelog: ${options.changelog}`);
          }
          if (existingVersion) {
            console.log(
              `\n   ⚠️  ${fullPath} already exists (latest: v${existingVersion}). Publishing will add v${version}.`
            );
          }
          console.log('');

          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await new Promise<string>((resolve) => {
            rl.question('Proceed with publishing? (y/N) ', resolve);
          });
          rl.close();

          if (answer.toString().toLowerCase() !== 'y') {
            console.log('\nAborted.\n');
            process.exit(0);
          }
        }

        try {
          const result = await client.publishDossier(namespace, content, options.changelog || null);

          const verifyCommand = `dossier info ${fullPath}@${version}`;
          const cdnDelaySeconds = 30;

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  published: true,
                  name: result.name || fullPath,
                  version,
                  content_url: result.content_url || null,
                  verification: {
                    verify_command: verifyCommand,
                    cdn_delay_seconds: cdnDelaySeconds,
                  },
                },
                null,
                2
              )
            );
          } else {
            console.log(`\n✅ Published ${registryPath}`);
            if (existingVersion) {
              console.log(`   Updated from v${existingVersion}`);
            }
            if (result.content_url) {
              console.log(`   URL: ${result.content_url}`);
            }
            console.log(
              `\n   ⏳ CDN propagation may take up to ${cdnDelaySeconds}s. Verify with:\n   $ ${verifyCommand}\n`
            );
          }
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string; code?: string };
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  published: false,
                  error: e.message,
                  code: e.code || 'publish_failed',
                },
                null,
                2
              )
            );
          } else if (e.statusCode === 401) {
            console.error('\n❌ Session expired. Run `dossier login` to re-authenticate.\n');
          } else if (e.statusCode === 403) {
            console.error(`\n❌ Permission denied: ${e.message}\n`);
          } else if (e.statusCode === 409) {
            console.error(`\n❌ Version conflict: ${registryPath} — ${e.message}\n`);
          } else {
            console.error(`\n❌ Publish failed: ${e.message}`);
            if (e.statusCode) {
              console.error(`   Status: ${e.statusCode}`);
            }
            if (e.code) {
              console.error(`   Code: ${e.code}`);
            }
            console.error('');
          }
          process.exit(1);
        }
      }
    );
}
