import type { Command } from 'commander';
import { resolveRegistries, resolveRegistryByName } from '../config';
import { saveCredentials } from '../credentials';
import { runOAuthFlow } from '../oauth';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description(
      'Authenticate with the dossier registry via GitHub. Use --registry to target a specific registry.'
    )
    .option('--registry <name>', 'Registry to authenticate with')
    .addHelpText(
      'after',
      `
For non-interactive environments (CI/CD), use environment variables instead:
  DOSSIER_REGISTRY_TOKEN  Auth token for registry access
  DOSSIER_REGISTRY_URL    Registry URL (creates virtual "env" registry)
`
    )
    .action(async (options: { registry?: string }) => {
      if (!process.stdin.isTTY) {
        console.error('\n❌ Non-interactive session detected. Cannot run OAuth flow.');
        console.error('   Set the DOSSIER_REGISTRY_TOKEN environment variable instead:\n');
        console.error('   export DOSSIER_REGISTRY_TOKEN=<your-token>\n');
        process.exit(1);
      }

      try {
        const allRegistries = resolveRegistries();
        let registryName: string;
        let registryUrl: string;

        if (options.registry) {
          const reg = resolveRegistryByName(options.registry);
          registryName = reg.name;
          registryUrl = reg.url;
        } else {
          registryName = allRegistries[0].name;
          registryUrl = allRegistries[0].url;
        }

        const result = await runOAuthFlow(registryUrl);

        saveCredentials(
          {
            token: result.token,
            username: result.username,
            orgs: result.orgs,
            expiresAt: result.expiresAt,
          },
          registryName
        );

        console.log(`\n✅ Logged in as ${result.username}`);
        if (allRegistries.length > 1) {
          console.log(`   Registry: ${registryName}`);
        }
        if (result.orgs.length > 0) {
          console.log(`   Organizations: ${result.orgs.join(', ')}`);
        }
        console.log('');
      } catch (err: unknown) {
        console.error(`\n❌ Login failed: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
