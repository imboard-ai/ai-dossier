/**
 * `ai-dossier sched` — the deterministic scheduler core (RFC-0001 §C.1, issue #460).
 *
 * enqueue / status / pause / resume / abandon manage the queue and state
 * (#460); `sched start` runs the dispatch engine (#464): spawns agent
 * processes for runnable units, verifies completion against ground truth,
 * and mechanizes the stall/escalation ladder.
 */

import fs from 'node:fs';
import type { SchedConfig, StatusReport, TickResult } from '@ai-dossier/sched';
import {
  abandonBatch,
  abandonIssue,
  buildStatusReport,
  CorruptStateError,
  createExecFn,
  createExecGroundTruth,
  createSpawnDeps,
  DEFAULT_RECONCILE_INTERVAL_MS,
  defaultExec,
  type EngineDeps,
  EnqueueError,
  type EnqueueInput,
  enqueueEntries,
  IllegalTransitionError,
  Journal,
  LockTimeoutError,
  OPENCODE_DISPATCH_COMMAND,
  parseManifest,
  resolveProjectSlug,
  runLoop,
  SchedNotFoundError,
  SchedStore,
  schedStateDir,
  setPaused,
  TEARDOWN_TIMEOUT_MS,
  tick,
} from '@ai-dossier/sched';
import type { Command } from 'commander';
import { formatAge } from '../duration';
import { detectLlm, fail } from '../helpers';
import { parseIssueSelection } from '../issue-selection';
import { renderTable } from '../table';

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

interface StartOptions extends SchedOptions {
  interval?: number;
  once?: boolean;
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

/** Parse an issue selection (`4,5` or `4..9`), failing through the CLI's exit path. */
function issueList(raw: string, flag: string): number[] {
  try {
    return parseIssueSelection(raw);
  } catch (err) {
    fail([`--${flag}: ${(err as Error).message}`]);
  }
}

/**
 * Resolve the state store: explicit `--project`, else the repo's slug
 * (gh owner-repo, git toplevel basename fallback — fleet-cycle's convention).
 */
function resolveStore(opts: SchedOptions): { store: SchedStore; project: string } {
  const project = opts.project ?? resolveProjectSlug(defaultExec);
  if (!opts.project && project === 'default') {
    console.error(
      '⚠ Could not resolve a repo from the current directory — operating on the "default" state bucket. Run sched from the repo, or pass --project.'
    );
  }
  return { store: new SchedStore(schedStateDir(project)), project };
}

/** Route package errors through the CLI's exit path instead of a stack trace. */
function handleKnownError(err: unknown): never {
  if (
    err instanceof CorruptStateError ||
    err instanceof LockTimeoutError ||
    err instanceof EnqueueError ||
    err instanceof IllegalTransitionError ||
    err instanceof SchedNotFoundError
  ) {
    fail([err.message]);
  }
  throw err;
}

// --- status rendering (the CLI's shared table renderer, like every other
// table-printing command; the package deliberately has no CLI dependencies) ---

function renderReport(report: StatusReport): string {
  const lines: string[] = [];
  const state = report.paused ? 'PAUSED' : 'running';
  const runnable = report.runnable_units.length > 0 ? report.runnable_units.join(', ') : 'none';
  lines.push(
    `Scheduler [${report.project}]: ${state} · slots ${report.live_slots}/${report.max_slots} live`
  );
  lines.push(`Runnable units: ${runnable}`);
  lines.push('');
  lines.push('== Queue ==');
  lines.push(
    renderTable(
      ['issue', 'mode', 'batch', 'tier', 'deps', 'status', 'pr'],
      report.queue.map((e) => [
        `#${e.issue}`,
        e.mode,
        e.batch ?? '-',
        e.tier,
        e.deps.length > 0 ? e.deps.map((d) => `#${d}`).join(',') : '-',
        e.status,
        e.pr !== null && e.pr !== undefined ? String(e.pr) : '-',
      ])
    )
  );
  lines.push('');
  if (report.parked.length > 0) {
    lines.push('== Parked PRs (watched, zero slots) ==');
    lines.push(
      report.parked
        .map((p) => `#${p.issue} — PR #${p.pr} (parked ${relativeTime(p.since)})`)
        .join('\n')
    );
    lines.push('');
  }
  lines.push('== Slots ==');
  lines.push(
    report.slots.length === 0
      ? '(no slots materialized yet)'
      : renderTable(
          ['slot', 'status', 'unit', 'pid', 'phase', 'last-progress', 'recoveries'],
          report.slots.map((s) => [
            String(s.id),
            s.status,
            s.unit ?? '-',
            s.pid !== null ? String(s.pid) : '-',
            s.phase ?? '-',
            s.last_progress_at !== null ? relativeTime(s.last_progress_at) : '-',
            String(s.recoveries),
          ])
        )
  );
  lines.push('');
  lines.push('== Batches ==');
  lines.push(
    report.batches.length === 0
      ? '(no batches)'
      : renderTable(
          ['batch', 'status', 'members', 'member-in-work'],
          report.batches.map((b) => [
            b.id,
            b.status,
            b.members.length > 0 ? b.members.map((m) => `#${m}`).join(',') : '-',
            b.executing_member > 0 ? `${b.executing_member}/${b.members.length}` : '-',
          ])
        )
  );
  lines.push('');
  lines.push('== Blocked ==');
  lines.push(
    report.blocked.length > 0
      ? report.blocked.map((b) => `#${b.issue} [${b.status}] — ${b.reason}`).join('\n')
      : '(none)'
  );
  lines.push('');
  lines.push('== Failed ==');
  lines.push(
    report.failed.length > 0
      ? report.failed.map((f) => `#${f.issue} — ${f.reason ?? f.status}`).join('\n')
      : '(none)'
  );
  return lines.join('\n');
}

/** `5m ago` / `2h ago` — compact last-progress rendering for the slot table. */
function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  return formatAge(Math.max(0, now - then), ' ago');
}

// --- subcommands ---

function registerEnqueueSubcommand(cmd: Command): void {
  cmd
    .command('enqueue')
    .description('Add issues to the scheduler queue (flags, a --from-manifest JSON file, or both)')
    .option('--issues <numbers>', 'Comma-separated issue numbers or ranges, e.g. 101,105..109')
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
      let manifestProject: string | null = null;
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
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { project?: unknown }).project === 'string'
        ) {
          manifestProject = (parsed as { project: string }).project;
        }
        try {
          inputs.push(...parseManifest(parsed));
        } catch (err) {
          fail([(err as Error).message]);
        }
      }

      if (manifestProject !== null && manifestProject !== project) {
        console.error(
          `⚠ Manifest was prepared for project '${manifestProject}' but enqueueing into '${project}'`
        );
      }

      if (opts.issues) {
        const mode = parseMode(opts.mode);
        const tier = parseTier(opts.tier);
        const deps = opts.deps ? issueList(opts.deps, 'deps') : [];
        for (const issue of issueList(opts.issues, 'issues')) {
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
        handleKnownError(err);
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
      const { store, project } = resolveStore(opts);
      try {
        const report = buildStatusReport(store.load(), store.loadConfig(), project);
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderReport(report));
        }
      } catch (err) {
        handleKnownError(err);
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
      try {
        const paused = store.withLock((state) => ({
          state: setPaused(state, pause),
          result: pause,
        }));
        if (opts.json) {
          console.log(JSON.stringify({ project, paused }));
        } else {
          console.log(paused ? '⏸ Scheduler paused' : '▶ Scheduler resumed');
        }
      } catch (err) {
        handleKnownError(err);
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
          const issue = issueList(opts.issue, 'issue')[0];
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
        handleKnownError(err);
      }
    });
}

function registerStartSubcommand(cmd: Command): void {
  cmd
    .command('start')
    .description(
      'Run the dispatch engine: spawn agents for runnable units, verify completion against ground truth, escalate stalls (Ctrl-C stops the engine; agents keep running)'
    )
    .option(
      '--interval <seconds>',
      'Reconcile tick interval in seconds (default 60)',
      Number.parseInt
    )
    .option('--once', 'Run a single reconcile+refill tick and exit (cron-style)')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output tick results as JSON')
    .action(async (opts: StartOptions) => {
      const { store, project } = resolveStore(opts);
      let config: SchedConfig;
      try {
        config = store.loadConfig();
      } catch (err) {
        handleKnownError(err);
      }

      // CLI flag beats config.json beats the engine default (60s).
      if (opts.interval !== undefined) {
        if (!Number.isInteger(opts.interval) || opts.interval <= 0) {
          fail(['--interval must be a positive number of seconds']);
        }
        config = { ...config, reconcile_interval_ms: opts.interval * 1000 };
      }

      // Resolve the agent command: config dispatch.command wins; otherwise
      // auto-detect (claude first, opencode fallback — the run machinery's
      // order, #459) and use the matching headless template.
      const dispatchCommand =
        config.dispatch?.command ??
        (detectLlm('auto', true) === 'opencode' ? [...OPENCODE_DISPATCH_COMMAND] : undefined);
      const engineConfig = dispatchCommand
        ? { ...config, dispatch: { ...config.dispatch, command: dispatchCommand } }
        : config;

      const deps: EngineDeps = {
        store,
        journal: new Journal(store.dir),
        groundTruth: createExecGroundTruth(undefined, { repoDir: process.cwd() }),
        spawnDeps: createSpawnDeps(process.cwd()),
        now: () => new Date(),
        repoDir: process.cwd(),
        teardownExec: createExecFn(TEARDOWN_TIMEOUT_MS, {
          onError: (file, args, err) =>
            process.stderr.write(
              `⚠ sched teardown: '${file} ${args.join(' ')}' failed: ${err.message}\n`
            ),
        }),
      };

      const describe = (result: TickResult): string => {
        const parts: string[] = [];
        if (result.spawned.length > 0) parts.push(`spawned ${result.spawned.join(', ')}`);
        if (result.parked.length > 0) parts.push(`parked ${result.parked.join(', ')}`);
        if (result.mergeAccepted.length > 0)
          parts.push(`merge accepted ${result.mergeAccepted.join(', ')}`);
        if (result.reportDispatched.length > 0)
          parts.push(`report dispatched ${result.reportDispatched.join(', ')}`);
        if (result.externalAdvances.length > 0)
          parts.push(`externally completed ${result.externalAdvances.join(', ')}`);
        if (result.completed.length > 0) parts.push(`completed ${result.completed.join(', ')}`);
        if (result.redispatched.length > 0)
          parts.push(`redispatched ${result.redispatched.join(', ')}`);
        if (result.failed.length > 0) parts.push(`failed ${result.failed.join(', ')}`);
        if (result.blocked.length > 0)
          parts.push(`blocked ${result.blocked.map((i) => `#${i}`).join(', ')}`);
        return parts.length > 0 ? parts.join(' · ') : 'nothing to do';
      };

      if (opts.once) {
        let result: TickResult;
        try {
          result = tick(deps, engineConfig);
        } catch (err) {
          // Route known package errors through the CLI exit path; any other
          // failure must not surface as an unhandled async rejection (this is
          // the cron path).
          handleKnownError(err);
          fail([`sched tick failed: ${(err as Error).name}: ${(err as Error).message}`]);
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`✓ [${project}] tick: ${describe(result)}`);
        }
        return;
      }

      const interval = (engineConfig.reconcile_interval_ms ?? DEFAULT_RECONCILE_INTERVAL_MS) / 1000;
      console.log(
        `▶ Scheduler engine running for ${project} (tick every ${interval}s, Ctrl-C to stop)`
      );
      let stopping = false;
      process.on('SIGINT', () => {
        if (stopping) process.exit(130);
        stopping = true;
        console.log('\n⏹ Stopping engine (spawned agents keep running)…');
      });
      await runLoop(
        deps,
        engineConfig,
        () => stopping,
        (result) => {
          if (!opts.json) console.log(`✓ [${new Date().toISOString()}] ${describe(result)}`);
          else console.log(JSON.stringify({ ts: new Date().toISOString(), ...result }));
        }
      );
      console.log('⏹ Engine stopped');
    });
}

export function registerSchedCommand(program: Command): void {
  const schedCmd = program
    .command('sched')
    .description(
      'Deterministic scheduler core — queue, slots, dispatch, verification, stall ladder (RFC-0001)'
    );

  registerEnqueueSubcommand(schedCmd);
  registerStatusSubcommand(schedCmd);
  registerPauseResumeSubcommand(schedCmd, true);
  registerPauseResumeSubcommand(schedCmd, false);
  registerAbandonSubcommand(schedCmd);
  registerStartSubcommand(schedCmd);
}
