import type { ResolvedRegistry } from './config';
import { resolveWriteRegistry } from './config';
import type { Credentials } from './credentials';
import { isExpired, loadCredentials } from './credentials';

export interface WriteAuthResult {
  targetRegistry: ResolvedRegistry;
  credentials: Credentials;
}

/**
 * Resolve the write registry and validate credentials.
 * Exits with appropriate error messages on failure.
 */
export function requireWriteAuth(options: {
  registryFlag?: string;
  json?: boolean;
  jsonResultKey?: string;
}): WriteAuthResult {
  let targetRegistry: ResolvedRegistry;
  try {
    targetRegistry = resolveWriteRegistry(options.registryFlag);
  } catch (err: unknown) {
    console.error(`\n❌ ${(err as Error).message}\n`);
    process.exit(1);
  }

  const credentials = loadCredentials(targetRegistry.name);
  if (!credentials) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            [options.jsonResultKey || 'success']: false,
            error: 'Not logged in',
            code: 'not_logged_in',
          },
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
          {
            [options.jsonResultKey || 'success']: false,
            error: 'Credentials expired',
            code: 'expired',
          },
          null,
          2
        )
      );
    } else {
      console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
    }
    process.exit(1);
  }

  return { targetRegistry, credentials };
}

/**
 * Handle registry write operation errors with consistent messages.
 */
export function handleRegistryWriteError(
  err: unknown,
  options: {
    json?: boolean;
    jsonResultKey?: string;
    actionLabel: string;
  }
): never {
  const e = err as { statusCode?: number; message: string; code?: string };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          [options.jsonResultKey || 'success']: false,
          error: e.message,
          code: e.code || `${options.actionLabel.toLowerCase()}_failed`,
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
    console.error(`\n❌ Version conflict: ${e.message}\n`);
  } else if (e.statusCode === 404) {
    console.error(`\n❌ Not found: ${e.message}\n`);
  } else {
    console.error(`\n❌ ${options.actionLabel} failed: ${e.message}`);
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
