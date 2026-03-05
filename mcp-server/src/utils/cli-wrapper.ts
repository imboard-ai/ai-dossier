/**
 * CLI wrapper utility - executes `ai-dossier` CLI commands and parses JSON output.
 * This is the single integration point between the MCP server and CLI.
 */

import { execFile } from 'node:child_process';
import { logger } from './logger';

const CLI_TIMEOUT_MS = 30_000;

export interface CliResult<T = unknown> {
  data: T;
}

export class CliNotFoundError extends Error {
  constructor() {
    super('ai-dossier CLI not found. Install it with: npm install -g @ai-dossier/cli');
    this.name = 'CliNotFoundError';
  }
}

export class CliExecutionError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(`CLI command failed: ai-dossier ${command} (exit code ${exitCode})`);
    this.name = 'CliExecutionError';
  }
}

/**
 * Find the ai-dossier binary path.
 * Tries the global binary first, then falls back to npx.
 */
function findCliBinary(): { cmd: string; prefixArgs: string[] } {
  return { cmd: 'ai-dossier', prefixArgs: [] };
}

/**
 * Execute a CLI command and return parsed JSON output.
 *
 * @param command - The CLI subcommand (e.g. "verify", "info", "list", "search")
 * @param args - Arguments to pass to the command
 * @returns Parsed JSON output from the CLI
 */
export function execCli<T = unknown>(command: string, args: string[]): Promise<T> {
  const { cmd, prefixArgs } = findCliBinary();
  const fullArgs = [...prefixArgs, command, ...args];

  logger.debug('Executing CLI command', { cmd, args: fullArgs });

  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      fullArgs,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Check if the binary was not found
          if ('code' in error && error.code === 'ENOENT') {
            reject(new CliNotFoundError());
            return;
          }

          // For verify, a non-zero exit code with JSON on stdout is still valid
          // (verification failed but output is structured)
          if (stdout.trim()) {
            try {
              const parsed = JSON.parse(stdout) as T;
              resolve(parsed);
              return;
            } catch {
              // Not valid JSON, fall through to error
            }
          }

          reject(
            new CliExecutionError(
              command,
              error.code !== undefined ? Number(error.code) : null,
              stderr
            )
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as T;
          resolve(parsed);
        } catch {
          reject(
            new Error(
              `Failed to parse CLI JSON output for "ai-dossier ${command}": ${stdout.slice(0, 200)}`
            )
          );
        }
      }
    );
  });
}
