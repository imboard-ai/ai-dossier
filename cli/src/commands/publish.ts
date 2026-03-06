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
import { getClientForRegistry } from '../registry-client';
import { handleRegistryWriteError, requireWriteAuth } from '../write-auth';

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish a dossier to the registry')
    .argument('<file>', 'Dossier file to publish')
    .option('--changelog <message>', 'Changelog message for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--namespace <namespace>', 'Override namespace (e.g., imboard-ai/skills)')
    .option('--registry <name>', 'Target registry to publish to')
    .option('--json', 'Output as JSON')
    .action(
      async (
        file: string,
        options: {
          changelog?: string;
          yes?: boolean;
          namespace?: string;
          registry?: string;
          json?: boolean;
        }
      ) => {
        const { targetRegistry, credentials } = requireWriteAuth({
          registryFlag: options.registry,
          json: options.json,
          jsonResultKey: 'published',
        });

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
        const client = getClientForRegistry(targetRegistry.url, credentials.token);
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
          console.log(`   Registry:  ${targetRegistry.name} (${targetRegistry.url})`);
          console.log(`   Path:      ${registryPath}`);
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
                  registry: targetRegistry.name,
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
            console.log(`\n✅ Published ${registryPath} [${targetRegistry.name}]`);
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
          handleRegistryWriteError(err, {
            json: options.json,
            jsonResultKey: 'published',
            actionLabel: 'Publish',
          });
        }
      }
    );
}
