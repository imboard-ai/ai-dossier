import readline from 'node:readline';
import type { Command } from 'commander';
import { getClientForRegistry, parseNameVersion } from '../registry-client';
import { handleRegistryWriteError, requireWriteAuth } from '../write-auth';

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('Remove a dossier from the registry')
    .argument('<name>', 'Dossier name (use name@version to remove a specific version)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--registry <name>', 'Target registry to remove from')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { yes?: boolean; registry?: string; json?: boolean }) => {
      const { targetRegistry, credentials } = requireWriteAuth({
        registryFlag: options.registry,
        json: options.json,
        jsonResultKey: 'removed',
      });

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
        handleRegistryWriteError(err, {
          json: options.json,
          jsonResultKey: 'removed',
          actionLabel: 'Remove',
        });
      }
    });
}
