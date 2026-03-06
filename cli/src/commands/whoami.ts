import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import { isExpired, listCredentialRegistries, loadCredentials } from '../credentials';

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show current registry user')
    .option('--registry <name>', 'Show credentials for a specific registry')
    .option('--json', 'Output as JSON')
    .action((options: { registry?: string; json?: boolean }) => {
      if (options.registry) {
        showSingleRegistry(options.registry, options.json);
      } else {
        const credRegistries = listCredentialRegistries();
        if (credRegistries.length === 0) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { logged_in: false, error: 'Not logged in', code: 'not_logged_in' },
                null,
                2
              )
            );
          } else {
            console.log('\nℹ️  Not logged in');
            console.log('   Run `dossier login` to authenticate\n');
          }
          process.exit(1);
        }

        // Show all registries with credentials
        if (credRegistries.length === 1) {
          showSingleRegistry(credRegistries[0], options.json);
        } else {
          showAllRegistries(credRegistries, options.json);
        }
      }
    });
}

function showSingleRegistry(registryName: string, json?: boolean): void {
  const credentials = loadCredentials(registryName);
  if (!credentials) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            logged_in: false,
            registry: registryName,
            error: 'Not logged in',
            code: 'not_logged_in',
          },
          null,
          2
        )
      );
    } else {
      console.log(`\nℹ️  Not logged in to registry '${registryName}'`);
      console.log(`   Run \`dossier login --registry ${registryName}\` to authenticate\n`);
    }
    process.exit(1);
  }

  if (isExpired(credentials)) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            logged_in: false,
            registry: registryName,
            error: 'Credentials expired',
            code: 'expired',
          },
          null,
          2
        )
      );
    } else {
      console.log(`\n⚠️  Credentials expired for registry '${registryName}'`);
      console.log(`   Run \`dossier login --registry ${registryName}\` to re-authenticate\n`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          logged_in: true,
          registry: registryName,
          username: credentials.username,
          orgs: credentials.orgs,
        },
        null,
        2
      )
    );
  } else {
    const allRegistries = resolveRegistries();
    console.log(`\n👤 ${credentials.username}`);
    if (allRegistries.length > 1) {
      console.log(`   Registry: ${registryName}`);
    }
    if (credentials.orgs.length > 0) {
      console.log(`   Organizations: ${credentials.orgs.join(', ')}`);
    }
    console.log('');
  }
}

function showAllRegistries(registryNames: string[], json?: boolean): void {
  const entries: Array<{
    registry: string;
    logged_in: boolean;
    username?: string;
    orgs?: string[];
    expired?: boolean;
  }> = [];

  for (const name of registryNames) {
    const creds = loadCredentials(name);
    if (!creds) {
      entries.push({ registry: name, logged_in: false });
    } else if (isExpired(creds)) {
      entries.push({ registry: name, logged_in: false, expired: true, username: creds.username });
    } else {
      entries.push({
        registry: name,
        logged_in: true,
        username: creds.username,
        orgs: creds.orgs,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ registries: entries }, null, 2));
  } else {
    console.log('\n👤 Registry Credentials:\n');
    for (const e of entries) {
      if (e.logged_in) {
        console.log(`   ${e.registry}: ${e.username}`);
        if (e.orgs && e.orgs.length > 0) {
          console.log(`     Organizations: ${e.orgs.join(', ')}`);
        }
      } else if (e.expired) {
        console.log(`   ${e.registry}: ${e.username} (expired)`);
      } else {
        console.log(`   ${e.registry}: not logged in`);
      }
    }
    console.log('');
  }
}
