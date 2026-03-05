import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseDossierContent, VALID_RISK_LEVELS, VALID_STATUSES } from '@ai-dossier/core';
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
    .action(
      async (file: string, options: { changelog?: string; yes?: boolean; namespace?: string }) => {
        const credentials = loadCredentials();
        if (!credentials) {
          console.error('\n❌ Not logged in. Run `dossier login` first.\n');
          process.exit(1);
        }
        if (isExpired(credentials)) {
          console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
          process.exit(1);
        }

        const dossierFile = path.resolve(file);
        if (!fs.existsSync(dossierFile)) {
          console.error(`\n❌ File not found: ${dossierFile}\n`);
          process.exit(1);
        }

        const content = fs.readFileSync(dossierFile, 'utf8');

        let frontmatter: Record<string, any>;
        let body: string;
        try {
          const parsed = parseDossierContent(content);
          frontmatter = parsed.frontmatter as Record<string, any>;
          body = parsed.body;
        } catch (err: unknown) {
          console.error(`\n❌ ${(err as Error).message}\n`);
          process.exit(1);
        }

        const errors: string[] = [];
        const required = ['title', 'version'];
        for (const field of required) {
          if (!frontmatter[field]) {
            errors.push(`Missing required field: ${field}`);
          }
        }
        if (
          frontmatter.risk_level &&
          !VALID_RISK_LEVELS.includes(frontmatter.risk_level.toLowerCase())
        ) {
          errors.push(`Invalid risk_level: ${frontmatter.risk_level}`);
        }
        if (frontmatter.status && !VALID_STATUSES.includes(frontmatter.status.toLowerCase())) {
          errors.push(`Invalid status: ${frontmatter.status}`);
        }
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

        if (!options.yes) {
          console.log('\n📦 Publishing dossier:\n');
          console.log(`   File:      ${path.basename(dossierFile)}`);
          console.log(`   Name:      ${name}`);
          console.log(`   Version:   ${version}`);
          console.log(`   Namespace: ${namespace}`);
          if (options.changelog) {
            console.log(`   Changelog: ${options.changelog}`);
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
          const client = getClient(credentials.token);
          const result = (await client.publishDossier(
            namespace,
            content,
            options.changelog || null
          )) as any;

          const fullName = result.name || `${namespace}/${name}`;
          console.log(`\n✅ Published ${fullName}@${version}`);
          if (result.content_url) {
            console.log(`   URL: ${result.content_url}`);
          }
          console.log('');
        } catch (err: any) {
          if (err.statusCode === 401) {
            console.error('\n❌ Session expired. Run `dossier login` to re-authenticate.\n');
          } else if (err.statusCode === 403) {
            console.error(`\n❌ Permission denied: ${err.message}\n`);
          } else if (err.statusCode === 409) {
            console.error(`\n❌ Version conflict: ${err.message}\n`);
          } else {
            console.error(`\n❌ Publish failed: ${err.message}`);
            if (err.statusCode) {
              console.error(`   Status: ${err.statusCode}`);
            }
            if (err.code) {
              console.error(`   Code: ${err.code}`);
            }
            console.error('');
          }
          process.exit(1);
        }
      }
    );
}
