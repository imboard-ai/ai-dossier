/**
 * `ai-dossier cap` — capability manifest operations (RFC-0001, issue #463).
 *
 *   cap init [--print]       scaffold a manifest from the detected project (#645)
 *   cap list [--json]        inspect .dossier/automation/manifest.yaml
 *   cap run <id> [-- args]   execute one capability
 *   cap last-ok <id> --tree <sha> [-- args]   did this exact tree already pass? (#941)
 *
 * `cap run` owns its exit codes (the four-way outcome contract):
 *   0 ok · 1 task-failed · 2 automation-broken · 3 capability-unavailable
 * The JSON envelope (marked `"cap_envelope": 1`) is the LAST stdout line, and —
 * when `--envelope-file <path>` or `DOSSIER_CAP_ENVELOPE_FILE` names a file —
 * is also written there before exit: the dedicated channel machine consumers
 * read (#811), immune to anything else that lands on stdout.
 */

import { findDossierRoot } from '@ai-dossier/sched';
import type { Command } from 'commander';
import { CAP_ENVELOPE_FILE_ENV, CAP_ENVELOPE_MARKER, writeCapEnvelopeFile } from '../cap-envelope';
import { captureGitState, mergeGitStates } from '../cap-git';
import { initManifest, missingGateCapabilities, scaffoldManifest } from '../cap-init';
import { appendCapLog, findLastOk, hashCapArgs } from '../cap-log';
import {
  AUTOMATION_DIR,
  CAPABILITY_EXIT_CODES,
  type CapabilityManifest,
  CapManifestError,
  type CapRunResult,
  DEFAULT_OUTPUT_TAIL_BYTES,
  loadCapabilityManifest,
  MANIFEST_FILE,
  runCapabilityFromCwd,
} from '../capability';
import { getConfig } from '../config';
import { fail } from '../helpers';
import { renderTable } from '../table';

interface ListOptions {
  json?: boolean;
}

interface InitOptions {
  print?: boolean;
}

interface RunOptions {
  tailBytes?: string;
  envelopeFile?: string;
}

/**
 * Resolve once everything written to `stream` so far has been handed to the
 * OS (#811). `process.exit()` right after a large write to a PIPE discards
 * whatever libuv still has queued — a 20 MB re-emitted capability output
 * arrived as 146 KB with no envelope, exit 0. A zero-length write's callback
 * fires only after every earlier queued write completes.
 */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** `cap last-ok` exit codes: distinct so a caller can tell "run it" from "could not ask". */
const LAST_OK_EXIT = { match: 0, noMatch: 1, error: 2, auditDisabled: 3 } as const;

function loadOrFail(): CapabilityManifest {
  try {
    return loadCapabilityManifest(process.cwd());
  } catch (err) {
    if (err instanceof CapManifestError) {
      fail([`Capability manifest is invalid: ${err.message}`]);
    }
    throw err;
  }
}

/**
 * The JSON envelope for `cap run` — nulls, never undefined, for a stable
 * shape. `output_tail` is the one exception: omitted entirely on `ok` (issue
 * #583 AC1) rather than null, so a passing run's envelope stays small; a
 * consumer (e.g. the batch engine) checks for the key's presence.
 */
function envelope(result: CapRunResult): string {
  return JSON.stringify({
    [CAP_ENVELOPE_MARKER]: 1,
    capability: result.capability,
    outcome: result.outcome,
    command: result.command,
    exit_code: result.exit_code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    reason: result.reason,
    ...(result.output_tail !== undefined ? { output_tail: result.output_tail } : {}),
  });
}

export function registerCapCommand(program: Command): void {
  const cap = program
    .command('cap')
    .description(
      `Capability manifest operations — deterministic execution of recurring repo operations (${AUTOMATION_DIR}/${MANIFEST_FILE})`
    );

  cap
    .command('init')
    .description(
      `Scaffold ${AUTOMATION_DIR}/${MANIFEST_FILE} from the detected project (package manager, install/build/test scripts). Idempotent: an existing manifest is never touched`
    )
    .option('--print', 'Print the scaffold to stdout instead of writing it')
    .action((opts: InitOptions) => {
      const cwd = process.cwd();
      if (opts.print) {
        process.stdout.write(scaffoldManifest(cwd));
        return;
      }
      const root = findDossierRoot(cwd) ?? cwd;
      const result = initManifest(root, cwd);
      if (result.status === 'created') {
        console.log(
          `Wrote ${result.path} — review and edit it; commented TODO stubs need a command.`
        );
        console.log('Verify with: ai-dossier cap list');
        return;
      }
      console.log(`${result.path} already exists — left untouched.`);
      const missing = missingGateCapabilities(loadOrFail());
      if (missing.length > 0) {
        console.log(
          `It does not declare the batch member gate capabilities: ${missing.join(', ')}. Add them by hand (see docs/reference/capabilities.md).`
        );
      }
    });

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
    .command('last-ok <id> [args...]')
    .description(
      'Did this exact tree already pass? Prints the latest clean `ok` caps.jsonl row for <id> run with exactly [args] (after --) at --tree. ' +
        `Exit codes: ${LAST_OK_EXIT.match} match, ${LAST_OK_EXIT.noMatch} no match (no output; dirty, failed and different-args runs never match), ` +
        `${LAST_OK_EXIT.error} error (bad --tree, unreadable log), ${LAST_OK_EXIT.auditDisabled} audit log disabled (cannot answer) (#941)`
    )
    .requiredOption('--tree <sha>', 'git tree sha, 40 hex (`git rev-parse HEAD^{tree}`)')
    .allowUnknownOption(true)
    .action((id: string, args: string[], opts: { tree: string }) => {
      if (!/^[0-9a-f]{40}$/.test(opts.tree)) {
        process.stderr.write(
          `cap last-ok: --tree must be a 40-hex git tree sha, got '${opts.tree}'\n`
        );
        process.exit(LAST_OK_EXIT.error);
      }
      if (getConfig('auditLog') === false) {
        process.stderr.write('cap last-ok: auditLog is disabled — no caps.jsonl to consult\n');
        process.exit(LAST_OK_EXIT.auditDisabled);
      }
      let row: ReturnType<typeof findLastOk>;
      try {
        row = findLastOk(id, opts.tree, args);
      } catch (err) {
        process.stderr.write(`cap last-ok: could not read caps.jsonl: ${(err as Error).message}\n`);
        process.exit(LAST_OK_EXIT.error);
      }
      if (!row) process.exit(LAST_OK_EXIT.noMatch);
      console.log(JSON.stringify(row));
    });

  cap
    .command('run <id> [args...]')
    .description(
      'Execute one capability; extra args after -- are shell-quoted and appended to the command. ' +
        'Exit codes: 0 ok, 1 task-failed, 2 automation-broken, 3 capability-unavailable'
    )
    .option(
      '--tail-bytes <n>',
      `Bytes of combined stdout+stderr to capture on a non-ok outcome (default ${DEFAULT_OUTPUT_TAIL_BYTES})`
    )
    .option(
      '--envelope-file <path>',
      `Also write the JSON envelope to <path> before exiting — a channel machine consumers read instead of stdout's last line (default: $${CAP_ENVELOPE_FILE_ENV})`
    )
    .allowUnknownOption(true)
    .action(async (id: string, args: string[], opts: RunOptions) => {
      const cwd = process.cwd();
      const tailBytes = opts.tailBytes ? Number(opts.tailBytes) : DEFAULT_OUTPUT_TAIL_BYTES;
      if (!Number.isFinite(tailBytes) || tailBytes < 0) {
        fail([`--tail-bytes must be a non-negative number, got '${opts.tailBytes}'`]);
      }
      // Probed before AND after: the row names the tree the run started on and
      // is dirty if the run (or anything before it) changed the work tree.
      const gitBefore = captureGitState(cwd);
      const result = runCapabilityFromCwd(id, args, cwd, tailBytes);
      const gitState = mergeGitStates(gitBefore, gitBefore ? captureGitState(cwd) : null);

      // The verdict channel is written FIRST: nothing after this point (the
      // telemetry append, stdout) may prevent a consumer from reading it.
      const json = envelope(result);
      const envelopeFile = opts.envelopeFile ?? process.env[CAP_ENVELOPE_FILE_ENV];
      if (envelopeFile) {
        try {
          writeCapEnvelopeFile(envelopeFile, json);
        } catch (err) {
          // The stdout envelope below is still the fallback channel; never
          // let a bad path change the capability's own outcome.
          process.stderr.write(
            `cap run: could not write envelope file ${envelopeFile}: ${(err as Error).message}\n`
          );
        }
      }

      try {
        appendCapLog({
          timestamp: new Date().toISOString(),
          capability: result.capability,
          outcome: result.outcome,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          reason: result.reason,
          signal: result.signal,
          cwd,
          args,
          args_hash: hashCapArgs(args),
          ...(gitState ?? {}),
          ...(result.output_tail !== undefined ? { output_tail: result.output_tail } : {}),
        });
      } catch (err) {
        // Telemetry must never suppress the verdict (disk full, ~/.dossier unwritable).
        process.stderr.write(`cap run: could not append caps.jsonl: ${(err as Error).message}\n`);
      }

      // Leading newline: a child whose last write had no trailing newline must
      // not end up on the same line as the envelope — the stdout envelope is
      // the last line, the fallback channel for consumers without
      // --envelope-file, so it has to stand alone.
      console.log(`\n${json}`);
      await Promise.all([drain(process.stdout), drain(process.stderr)]);
      process.exit(CAPABILITY_EXIT_CODES[result.outcome]);
    });
}
