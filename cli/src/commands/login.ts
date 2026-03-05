import type { Command } from 'commander';
import { saveCredentials } from '../credentials';
import { runOAuthFlow } from '../oauth';
import { getRegistryUrl } from '../registry-client';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the dossier registry via GitHub')
    .action(async () => {
      if (!process.stdin.isTTY) {
        console.error('\n❌ Non-interactive session detected. Cannot run OAuth flow.');
        console.error('   Set the DOSSIER_REGISTRY_TOKEN environment variable instead:\n');
        console.error('   export DOSSIER_REGISTRY_TOKEN=<your-token>\n');
        process.exit(1);
      }

      try {
        const registryUrl = getRegistryUrl();
        const result = await runOAuthFlow(registryUrl);

        saveCredentials({
          token: result.token,
          username: result.username,
          orgs: result.orgs,
          expiresAt: result.expiresAt,
        });

        console.log(`\n✅ Logged in as ${result.username}`);
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
