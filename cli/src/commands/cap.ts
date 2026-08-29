/**
 * `ai-dossier cap` — capability manifest operations (RFC-0001, issue #463).
 *
 *   cap list [--json]        inspect .dossier/automation/manifest.yaml
 *   cap run <id> [-- args]   execute one capability
 *
 * `cap run` owns its exit codes (the four-way outcome contract):
 *   0 ok · 1 task-failed · 2 automation-broken · 3 capability-unavailable
 * The JSON envelope is the LAST stdout line — machine consumers read that line.
 */

import type { Command } from 'commander';
import { appendCapLog } from '../cap-log';
import {
  AUTOMATION_DIR,
  CAPABILITY_EXIT_CODES,
  CapManifestError,
  type CapRunResult,
  loadCapabilityManifest,
  MANIFEST_FILE,
  runCapabilityFromCwd,
} from '../capability';
import { fail } from '../helpers';
import { renderTable } from '../table';

interface ListOptions {
  json?: boolean;
}

function loadOrFail(): ReturnType<typeof loadCapabilityManifest> {
  try {
    return loadCapabilityManifest(process.cwd());
  } catch (err) {
    if (err instanceof CapManifestError) {
      fail([`Capability manifest is invalid: ${err.message}`]);
    }
    throw err;
  }
}

/** The JSON envelope for `cap run` — nulls, never undefined, for a stable shape. */
function envelope(result: CapRunResult): string {
  return JSON.stringify({
    capability: result.capability,
    outcome: result.outcome,
    command: result.command,
    exit_code: result.exit_code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    reason: result.reason,
  });
}

export function registerCapCommand(program: Command): void {
  const cap = program
    .command('cap')
    .description(
      `Capability manifest operations — deterministic execution of recurring repo operations (${AUTOMATION_DIR}/${MANIFEST_FILE})`
    );

  cap
    .command('list')
    .description(
      'List available capabilities and their lifecycle (empty + exit 0 when no manifest)'
    )
    .option('--json', 'Output the capability list as JSON')
    .action((opts: ListOptions) => {
      const manifest = loadOrFail();

      if (opts.json) {
        console.log(
          JSON.stringify({
            manifest: manifest.path,
            capabilities: Object.entries(manifest.capabilities).map(([id, entry]) => ({
              id,
              lifecycle: entry.lifecycle,
              command: entry.command,
              description: entry.description ?? null,
            })),
          })
        );
        return;
      }

      if (manifest.path === null) {
        console.log(
          `No capability manifest (${AUTOMATION_DIR}/${MANIFEST_FILE}) — capabilities: (none)`
        );
        return;
      }
      const rows = Object.entries(manifest.capabilities).map(([id, entry]) => [
        id,
        entry.lifecycle,
        entry.command,
        entry.description ?? '-',
      ]);
      if (rows.length === 0) {
        console.log(`Capability manifest ${manifest.path} declares no capabilities.`);
        return;
      }
      console.log(`Capabilities (${manifest.path}):`);
      console.log(renderTable(['capability', 'lifecycle', 'command', 'description'], rows));
    });

  cap
    .command('run <id> [args...]')
    .description(
      'Execute one capability; extra args after -- are appended to the command. ' +
        'Exit codes: 0 ok, 1 task-failed, 2 automation-broken, 3 capability-unavailable'
    )
    .allowUnknownOption(true)
    .action((id: string, args: string[]) => {
      const cwd = process.cwd();
      const result = runCapabilityFromCwd(id, args ?? [], cwd);

      appendCapLog({
        timestamp: new Date().toISOString(),
        capability: result.capability,
        outcome: result.outcome,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        cwd,
      });

      console.log(envelope(result));
      process.exit(CAPABILITY_EXIT_CODES[result.outcome]);
    });
}
