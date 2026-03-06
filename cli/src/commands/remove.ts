import readline from 'node:readline';
import type { Command } from 'commander';
import { resolveWriteRegistry } from '../config';
import { isExpired, loadCredentials } from '../credentials';
import { getClientForRegistry, parseNameVersion } from '../registry-client';

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('Remove a dossier from the registry')
    .argument('<name>', 'Dossier name (use name@version to remove a specific version)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--registry <name>', 'Target registry to remove from')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { yes?: boolean; registry?: string; json?: boolean }) => {
      let targetRegistry: import('../config').ResolvedRegistry;
      try {
        targetRegistry = resolveWriteRegistry(options.registry);
      } catch (err: unknown) {
        console.error(`\n❌ ${(err as Error).message}\n`);
        process.exit(1);
      }

      const credentials = loadCredentials(targetRegistry.name);
      if (!credentials) {
        if (options.json) {
          console.log(
            JSON.stringify(
              { removed: false, error: 'Not logged in', code: 'not_logged_in' },
              null,
              2
            )
          );
        } else {
          console.error(
            `\n❌ Not logged in to registry '${targetRegistry.name}'. Run \`dossier login --registry ${targetRegistry.name}\` first.\n`
          );
        }
        process.exit(1);
      }
      if (isExpired(credentials)) {
        if (options.json) {
          console.log(
            JSON.stringify(
              { removed: false, error: 'Credentials expired', code: 'expired' },
              null,
              2
            )
          );
        } else {
          console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
        }
        process.exit(1);
      }

      const [dossierName, version] = parseNameVersion(name);
      const target = version ? `${dossierName}@${version}` : dossierName;

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          console.error(
            '\n❌ Non-interactive session detected. Use -y/--yes to skip confirmation.\n'
          );
          process.exit(1);
        }

        const msg = version
          ? `Are you sure you want to remove version '${version}' of '${dossierName}'?`
          : `Are you sure you want to remove '${dossierName}' and ALL its versions?`;

        console.log(`\n⚠️  ${msg}`);
        console.log(`   Registry: ${targetRegistry.name}\n`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await new Promise<string>((resolve) => {
          rl.question('Confirm removal? (y/N) ', resolve);
        });
        rl.close();

        if (answer.toString().toLowerCase() !== 'y') {
          console.log('\nAborted.\n');
          process.exit(0);
        }
      }

      try {
        const client = getClientForRegistry(targetRegistry.url, credentials.token);
        await client.removeDossier(dossierName, version || null);

        const verifyCommand = `dossier info ${target}`;
        const cdnDelaySeconds = 30;

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                removed: true,
                name: target,
                registry: targetRegistry.name,
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
          console.log(`\n✅ Removed: ${target} [${targetRegistry.name}]`);
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
                removed: false,
                error: e.message,
                code: e.code || 'remove_failed',
              },
              null,
              2
            )
          );
        } else if (e.statusCode === 401) {
          console.error('\n❌ Session expired. Run `dossier login` to re-authenticate.\n');
        } else if (e.statusCode === 403) {
          console.error(`\n❌ Permission denied: ${e.message}\n`);
        } else if (e.statusCode === 404) {
          console.error(`\n❌ Not found: ${target}\n`);
        } else {
          console.error(`\n❌ Remove failed: ${e.message}\n`);
        }
        process.exit(1);
      }
    });
}
