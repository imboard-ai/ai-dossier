import readline from 'node:readline';
import type { Command } from 'commander';
import { isExpired, loadCredentials } from '../credentials';
import { getClient, parseNameVersion } from '../registry-client';

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('Remove a dossier from the registry')
    .argument('<name>', 'Dossier name (use name@version to remove a specific version)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { yes?: boolean; json?: boolean }) => {
      const credentials = loadCredentials();
      if (!credentials) {
        console.error('\n❌ Not logged in. Run `dossier login` first.\n');
        process.exit(1);
      }
      if (isExpired(credentials)) {
        console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
        process.exit(1);
      }

      const [dossierName, version] = parseNameVersion(name);
      const target = version ? `${dossierName}@${version}` : dossierName;

      if (!options.yes) {
        const msg = version
          ? `Are you sure you want to remove version '${version}' of '${dossierName}'?`
          : `Are you sure you want to remove '${dossierName}' and ALL its versions?`;

        console.log(`\n⚠️  ${msg}\n`);

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
        const client = getClient(credentials.token);
        await client.removeDossier(dossierName, version || null);

        const verifyCommand = `dossier info ${target}`;
        const cdnDelaySeconds = 30;

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: true,
                name: dossierName,
                version: version || null,
                target,
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
          console.log(`\n✅ Removed: ${target}`);
          console.log(
            `\n   ⏳ CDN propagation may take up to ${cdnDelaySeconds}s. Verify with:\n   $ ${verifyCommand}\n`
          );
        }
      } catch (err: any) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                success: false,
                error: err.code || 'remove_failed',
                message: err.message,
                name: dossierName,
                version: version || null,
                statusCode: err.statusCode || null,
              },
              null,
              2
            )
          );
        } else if (err.statusCode === 401) {
          console.error('\n❌ Session expired. Run `dossier login` to re-authenticate.\n');
        } else if (err.statusCode === 403) {
          console.error(`\n❌ Permission denied: ${err.message}\n`);
        } else if (err.statusCode === 404) {
          console.error(`\n❌ Not found: ${target}\n`);
        } else {
          console.error(`\n❌ Remove failed: ${err.message}\n`);
        }
        process.exit(1);
      }
    });
}
