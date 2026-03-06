import type { Command } from 'commander';
import { deleteCredentials, listCredentialRegistries } from '../credentials';

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Remove stored registry credentials')
    .option('--registry <name>', 'Registry to log out from (omit to log out from all)')
    .action((options: { registry?: string }) => {
      if (options.registry) {
        const deleted = deleteCredentials(options.registry);
        if (deleted) {
          console.log(`\n✅ Logged out from registry '${options.registry}'\n`);
        } else {
          console.log(`\nℹ️  No credentials found for registry '${options.registry}'\n`);
        }
      } else {
        const registries = listCredentialRegistries();
        const deleted = deleteCredentials();
        if (deleted) {
          console.log('\n✅ Logged out successfully');
          if (registries.length > 1) {
            console.log(`   Removed credentials for: ${registries.join(', ')}`);
          }
          console.log('');
        } else {
          console.log('\nℹ️  Not logged in (no credentials found)\n');
        }
      }
    });
}
