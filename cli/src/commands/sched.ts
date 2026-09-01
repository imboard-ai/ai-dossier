/**
 * `ai-dossier sched` — the deterministic scheduler core (RFC-0001 §C.1, issue #460).
 *
 * enqueue / status / pause / resume / abandon manage the queue and state
 * (#460); `sched start` runs the dispatch engine (#464: spawning agent
 * processes, verifying their completion against ground truth, mechanizing
 * the stall/escalation ladder) and since #468 also the detached-ship tail:
 * watching parked PRs, script-based teardown of merged worktrees, and the
 * cheap-tier report dispatch.
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
  labelBlockReason,
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
  unitEvent,
} from '@ai-dossier/sched';
import type { Command } from 'commander';
import { formatAge } from '../duration';
import { requireRepoSlug, tryFetchLabels } from '../gh';
import { detectLlm, fail } from '../helpers';
import { MAX_ISSUE_SELECTION, parseIssueSelection } from '../issue-selection';
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
  repo?: string;
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
  if (report.dispatch_health.consecutive_suspect > 0) {
    // `report.paused` alone can't prove dispatch-health caused it (a manual
    // `sched pause` looks identical), but a nonzero streak while paused is
    // always at least worth flagging as the likely cause; below that it's
    // purely informational — `sched resume` clears the streak (#505), so a
    // reading here always reflects activity since the last resume.
    const cause = report.paused
      ? '— likely why the scheduler is paused'
      : '— informational, below the auto-pause threshold';
    lines.push(
      `⚠ Dispatch health: ${report.dispatch_health.consecutive_suspect} consecutive suspect-dispatch exit(s) (last: ${report.dispatch_health.last_suspect_unit}) ${cause}`
    );
  }
  lines.push(`Runnable units: ${runnable}`);
  lines.push('');
  lines.push('== Queue ==');
  lines.push(
    renderTable(
      ['issue', 'mode', 'batch', 'tier', 'deps', 'status', 'pr', 'cleanup'],
      report.queue.map((e) => [
        `#${e.issue}`,
        e.mode,
        e.batch ?? '-',
        e.tier,
        e.deps.length > 0 ? e.deps.map((d) => `#${d}`).join(',') : '-',
        e.status,
        e.pr !== null && e.pr !== undefined ? String(e.pr) : '-',
        e.cleanup ?? '-',
      ])
    )
  );
  lines.push('');
  if (report.parked.length > 0) {
    const lastPoll = report.last_pr_poll_at
      ? `; last poll ${relativeTime(report.last_pr_poll_at)}`
      : '; never polled';
    lines.push(`== Parked PRs (watched, zero slots${lastPoll}) ==`);
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
          ['slot', 'status', 'unit', 'pid', 'role', 'phase', 'last-progress', 'recoveries'],
          report.slots.map((s) => [
            String(s.id),
            s.status,
            s.unit ?? '-',
            s.pid !== null ? String(s.pid) : '-',
            s.role,
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

// --- enqueue-time label pre-screen (#507) ---

/**
 * Labels that mean an issue was already determined undispatchable — by a
 * prior full-cycle hand-off (`decision-pending`, applied by the Guiding
 * Principle hand-off) or by triage (`needs-clarification`, `epic`,
 * `decomposed`, the same three gate-issue Step 2 hard-blocks on). This is
 * NOT gate-issue's list verbatim: gate-issue additionally hard-blocks
 * `batch-epic`, a batch-ANCHOR concern with no equivalent for a per-issue
 * enqueue screen, so it is deliberately left out here. Enqueueing one of
 * these anyway just re-burns the same block a dispatched agent (and the
 * escalation ladder behind it) would rediscover on its own; checking here
 * costs one `gh` call instead of a slot-hour.
 *
 * Order is significant: when an issue carries more than one of these
 * labels, the FIRST match in this array is the one recorded in `reason` —
 * reordering the array changes which reason gets recorded.
 *
 * `decision-pending` here is the GitHub LABEL, not the `IssueStatus` value
 * of the same name (`packages/sched/src/types.ts`) — a labelled issue lands
 * as `status: 'blocked'` with a `label:` reason, same as the other three;
 * see the comment on `enqueue.ts`'s status assignment for why.
 */
export const HARD_BLOCK_LABELS = [
  'decision-pending',
  'needs-clarification',
  'epic',
  'decomposed',
] as const;

/** The first hard-block label `labels` carries (case-insensitive), or `null`. */
export function pickHardBlockLabel(labels: readonly string[]): string | null {
  const normalized = labels.map((label) => label.toLowerCase());
  return HARD_BLOCK_LABELS.find((label) => normalized.includes(label)) ?? null;
}

/**
 * Mutate `inputs` in place, setting `blocked_label` on any issue that
 * already carries a hard-block label. Fails open on a `gh` lookup failure
 * (network, auth, rate limit, an issue number too large to be a real gh
 * argument) — enqueue must never hard-fail because a nice-to-have check
 * could not run; the issue is enqueued as `queued`, same as before #507.
 * Returns the issues whose lookup failed, so the caller can journal and
 * report them — an empty `blocked_by_label` must not read the same as "all
 * clean" when it actually means "the screen didn't run".
 *
 * Screened outside the store lock (no network I/O while holding it) but
 * before `enqueueEntries` validates the batch, so a manifest validation
 * will reject still pays the lookup cost — enqueue is not a hot path
 * (human/script-triggered, not per-dispatch), so this is accepted; a
 * repeated issue number is looked up once via the cache below.
 */
function screenHardBlockLabels(inputs: EnqueueInput[], repo?: string): number[] {
  const cache = new Map<number, string | null>();
  const failed: number[] = [];
  for (const input of inputs) {
    if (!cache.has(input.issue)) {
      if (!Number.isSafeInteger(input.issue)) {
        console.error(
          `⚠ Issue ${input.issue} is not a safe integer — skipping the label pre-screen. Enqueuing #${input.issue} normally.`
        );
        failed.push(input.issue);
        cache.set(input.issue, null);
      } else {
        const result = tryFetchLabels(String(input.issue), repo);
        if (!result.ok) {
          console.error(
            `⚠ ${result.error}\n  Enqueuing #${input.issue} normally (label pre-screen skipped).`
          );
          failed.push(input.issue);
          cache.set(input.issue, null);
        } else {
          cache.set(input.issue, pickHardBlockLabel(result.labels));
        }
      }
    }
    const hit = cache.get(input.issue) ?? null;
    if (hit) input.blocked_label = hit;
  }
  return failed;
}

/** Append one `label-blocked`/`label-check-failed` journal event per outcome (#507 AC3). */
function journalLabelScreen(store: SchedStore, blocked: EnqueueInput[], failed: number[]): void {
  if (blocked.length === 0 && failed.length === 0) return;
  const journal = new Journal(store.dir);
  for (const input of blocked) {
    journal.append(
      unitEvent('label-blocked', `issue:${input.issue}`, {
        reason: labelBlockReason(input.blocked_label as string),
      })
    );
  }
  for (const issue of failed) {
    journal.append(
      unitEvent('label-check-failed', `issue:${issue}`, {
        reason: 'gh lookup failed — enqueued unscreened',
      })
    );
  }
}

/** Print the enqueue result — human summary, or `--json`. */
function reportEnqueue(
  opts: EnqueueOptions,
  project: string,
  inputs: EnqueueInput[],
  blocked: EnqueueInput[],
  failed: number[],
  queueDepth: number
): void {
  if (opts.json) {
    console.log(
      JSON.stringify({
        project,
        enqueued: inputs.length,
        queued: inputs.length - blocked.length,
        blocked_by_label: blocked.map((input) => ({
          issue: input.issue,
          label: input.blocked_label,
        })),
        label_check_failed: failed,
        queue_depth: queueDepth,
      })
    );
    return;
  }
  const summary =
    blocked.length > 0
      ? `${inputs.length - blocked.length} queued, ${blocked.length} blocked-by-label`
      : `${inputs.length} queued`;
  console.log(
    `✓ Enqueued ${inputs.length} issue(s) for ${project} (${summary}; queue depth: ${queueDepth})`
  );
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
    .option(
      '--repo <owner/name>',
      "GitHub repo to screen hard-block labels against (default: current directory's repo — required when --project targets a different repo)"
    )
    .option('--json', 'Output the result as JSON')
    .action((opts: EnqueueOptions) => {
      requireRepoSlug(opts.repo);
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
      if (inputs.length > MAX_ISSUE_SELECTION) {
        fail([
          `Cannot enqueue ${inputs.length} issues — the label pre-screen costs one gh call each, past the ${MAX_ISSUE_SELECTION} cap.\nFix: split the manifest into batches of at most ${MAX_ISSUE_SELECTION}.`,
        ]);
      }

      const failed = screenHardBlockLabels(inputs, opts.repo);

      let queueDepth: number;
      try {
        queueDepth = store.withLock((state) => {
          const next = enqueueEntries(state, inputs);
          return { state: next, result: next.entries.length };
        });
      } catch (err) {
        handleKnownError(err);
      }

      const blocked = inputs.filter((input) => input.blocked_label);
      journalLabelScreen(store, blocked, failed);
      reportEnqueue(opts, project, inputs, blocked, failed, queueDepth);
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
      'Run the dispatch engine: spawn agents, verify completion, escalate stalls, watch parked PRs, tear down merged worktrees, dispatch report agents (Ctrl-C stops the engine; agents keep running)'
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
        if (result.staleReconciled.length > 0)
          parts.push(`stale failure reconciled ${result.staleReconciled.join(', ')}`);
        if (result.dependentsUnblocked.length > 0)
          parts.push(`dependents unblocked ${result.dependentsUnblocked.join(', ')}`);
        if (result.teardownDone.length > 0)
          parts.push(`teardown done ${result.teardownDone.join(', ')}`);
        if (result.teardownFailed.length > 0)
          parts.push(`teardown failed ${result.teardownFailed.join(', ')}`);
        if (result.reportDispatched.length > 0)
          parts.push(`report dispatched ${result.reportDispatched.join(', ')}`);
        if (result.reportWaiting > 0)
          parts.push(`${result.reportWaiting} report(s) waiting for a free slot`);
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
