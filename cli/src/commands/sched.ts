/**
 * `ai-dossier sched` — the deterministic scheduler core (RFC-0001 §C.1, issue #460).
 *
 * enqueue / status / pause / resume / abandon operate on
 * `~/.dossier/sched/<project>/{state.json,config.json}`. Dispatching agents is
 * #464; everything here is queue and state management with zero LLM calls.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  abandonBatch,
  abandonIssue,
  buildStatusReport,
  EnqueueError,
  type EnqueueInput,
  enqueueEntries,
  IllegalTransitionError,
  parseManifest,
  renderStatus,
  resolveProjectSlug,
  SchedStore,
  schedStateDir,
  setPaused,
} from '@ai-dossier/sched';
import type { Command } from 'commander';

interface SchedOptions {
  project?: string;
  json?: boolean;
}

interface EnqueueOptions extends SchedOptions {
  issues?: string;
  mode?: string;
  batch?: string;
  deps?: string;
  tier?: string;
  fromManifest?: string;
}

interface AbandonOptions extends SchedOptions {
  issue?: string;
  batch?: string;
  reason?: string;
}

/**
 * Fail on stderr and exit 1, so a calling dossier can detect it (same shape
 * as `commands/runstate.ts`).
 */
function fail(lines: string[]): never {
  for (const line of lines) {
    console.error(`❌ ${line}`);
  }
  process.exit(1);
}

function parseIssueList(raw: string, flag: string): number[] {
  const values: number[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      fail([`--${flag} must be a comma-separated list of positive issue numbers, got '${raw}'`]);
    }
    values.push(n);
  }
  if (values.length === 0) {
    fail([`--${flag} must contain at least one issue number`]);
  }
  return values;
}

function parseMode(raw: string | undefined): 'full' | 'slot' {
  if (raw === undefined || raw === 'full') return 'full';
  if (raw === 'slot') return 'slot';
  fail([`--mode must be 'full' or 'slot', got '${raw}'`]);
}

function parseTier(raw: string | undefined): 'mechanical' | 'mid' | 'strong' {
  if (raw === undefined || raw === 'mid') return 'mid';
  if (raw === 'mechanical' || raw === 'strong') return raw;
  fail([`--tier must be mechanical | mid | strong, got '${raw}'`]);
}

/** Resolve the state store: explicit `--project`, else the repo's slug. */
function resolveStore(opts: SchedOptions): { store: SchedStore; project: string } {
  const project =
    opts.project ??
    resolveProjectSlug((file, args, cwd) => {
      try {
        return String(
          execFileSync(file, args, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
          })
        ).trim();
      } catch {
        return null;
      }
    });
  return { store: new SchedStore(schedStateDir(project)), project };
}

function registerEnqueueSubcommand(cmd: Command): void {
  cmd
    .command('enqueue')
    .description('Add issues to the scheduler queue (flags, a --from-manifest JSON file, or both)')
    .option('--issues <numbers>', 'Comma-separated issue numbers (unless --from-manifest)')
    .option('--mode <mode>', "Execution mode: 'full' (default) or 'slot'", 'full')
    .option('--batch <id>', 'Batch id (required for slot mode)')
    .option('--deps <numbers>', 'Comma-separated dependency issue numbers (applied to all)')
    .option('--tier <tier>', 'Model tier: mechanical | mid (default) | strong', 'mid')
    .option('--from-manifest <path>', 'JSON file of entries (batch-prep output)')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: EnqueueOptions) => {
      const { store, project } = resolveStore(opts);

      const inputs: EnqueueInput[] = [];
      if (opts.fromManifest) {
        let raw: string;
        try {
          raw = fs.readFileSync(opts.fromManifest, 'utf-8');
        } catch (err) {
          fail([`Cannot read manifest ${opts.fromManifest}: ${(err as Error).message}`]);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          fail([`Manifest is not valid JSON: ${(err as Error).message}`]);
        }
        try {
          inputs.push(...parseManifest(parsed));
        } catch (err) {
          fail([(err as Error).message]);
        }
      }

      if (opts.issues) {
        const mode = parseMode(opts.mode);
        const tier = parseTier(opts.tier);
        const deps = opts.deps ? parseIssueList(opts.deps, 'deps') : [];
        for (const issue of parseIssueList(opts.issues, 'issues')) {
          inputs.push({ issue, mode, batch: opts.batch ?? null, deps, tier });
        }
      }

      if (inputs.length === 0) {
        fail(['Nothing to enqueue — pass --issues or --from-manifest']);
      }

      let enqueued: number;
      try {
        enqueued = store.withLock((state) => {
          const next = enqueueEntries(state, inputs);
          return { state: next, result: next.entries.length };
        });
      } catch (err) {
        if (err instanceof EnqueueError || err instanceof IllegalTransitionError) {
          fail([err.message]);
        }
        throw err;
      }

      if (opts.json) {
        console.log(JSON.stringify({ project, enqueued: inputs.length, queue_depth: enqueued }));
      } else {
        console.log(
          `✓ Enqueued ${inputs.length} issue(s) for ${project} (queue depth: ${enqueued})`
        );
      }
    });
}

function registerStatusSubcommand(cmd: Command): void {
  cmd
    .command('status')
    .description('Render the queue, slots, batches, and blocked/failed sets')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the report as JSON')
    .action((opts: SchedOptions) => {
      const { store } = resolveStore(opts);
      const state = store.load();
      const config = store.loadConfig();
      const report = buildStatusReport(state, config);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderStatus(report));
      }
    });
}

function registerPauseResumeSubcommand(cmd: Command, pause: boolean): void {
  cmd
    .command(pause ? 'pause' : 'resume')
    .description(
      pause
        ? 'Stop making new slot assignments (live units keep running)'
        : 'Resume making new slot assignments'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: SchedOptions) => {
      const { store, project } = resolveStore(opts);
      const paused = store.withLock((state) => ({
        state: setPaused(state, pause),
        result: pause,
      }));
      if (opts.json) {
        console.log(JSON.stringify({ project, paused }));
      } else {
        console.log(paused ? '⏸ Scheduler paused' : '▶ Scheduler resumed');
      }
    });
}

function registerAbandonSubcommand(cmd: Command): void {
  cmd
    .command('abandon')
    .description('Fail an issue entry (or dissolve a batch and requeue its members as full-cycle)')
    .option('--issue <number>', 'Issue number to abandon')
    .option('--batch <id>', 'Batch id to dissolve')
    .option('--reason <text>', 'Reason recorded on the entry')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: AbandonOptions) => {
      if ((opts.issue ? 1 : 0) + (opts.batch ? 1 : 0) !== 1) {
        fail(['Pass exactly one of --issue <number> or --batch <id>']);
      }
      const { store } = resolveStore(opts);
      const reason = opts.reason ?? 'abandoned';
      try {
        if (opts.issue) {
          const issue = parseIssueList(opts.issue, 'issue')[0];
          const result = store.withLock((state) => {
            const r = abandonIssue(state, issue, reason);
            return { state: r.state, result: r.releasedSlots };
          });
          if (opts.json) {
            console.log(JSON.stringify({ abandoned: `issue:${issue}`, released_slots: result }));
          } else {
            console.log(`✓ Abandoned issue #${issue} (released ${result.length} slot(s))`);
          }
        } else if (opts.batch) {
          const requeued = store.withLock((state) => {
            const r = abandonBatch(state, opts.batch as string, reason);
            return { state: r.state, result: r.requeued };
          });
          if (opts.json) {
            console.log(JSON.stringify({ abandoned: `batch:${opts.batch}`, requeued }));
          } else {
            console.log(
              `✓ Dissolved batch ${opts.batch}; requeued ${requeued.length} member(s) as full-cycle`
            );
          }
        }
      } catch (err) {
        if (
          err instanceof IllegalTransitionError ||
          (err instanceof Error && err.message.includes('not found'))
        ) {
          fail([err.message]);
        }
        throw err;
      }
    });
}

export function registerSchedCommand(program: Command): void {
  const schedCmd = program
    .command('sched')
    .description(
      'Deterministic scheduler core — queue, slots, persistent state machine (RFC-0001)'
    );

  registerEnqueueSubcommand(schedCmd);
  registerStatusSubcommand(schedCmd);
  registerPauseResumeSubcommand(schedCmd, true);
  registerPauseResumeSubcommand(schedCmd, false);
  registerAbandonSubcommand(schedCmd);
}
