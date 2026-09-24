/**
 * Aggregate batch-suite command resolution (#562): what actually runs when a
 * batch's `validating` phase needs to know "did the members' combined work
 * still pass the whole suite?"
 *
 * The bug this replaces: unconditionally shelling `npm test -- --reporter=json`
 * assumed the repo's `test` script IS a test runner. In a repo whose `test`
 * script delegates to something else (this repo: `"test": "make test"`), the
 * flag reaches that wrapper instead — `make: unrecognized option
 * '--reporter=json'` — aborts before running anything, and the caller reads
 * the non-zero exit + empty stdout as a genuinely red, unattributable suite.
 * `runValidate` (`batch-dispatch.ts`) then dissolves the batch, discarding
 * work that may have been fully green (docs/agent-traps.md).
 *
 * Resolution order, each tier preferred to the next:
 *   0. `cap run gate.batch` (#777) — the repo's declared BATCH gate, when its
 *      manifest has one `active`: the same gate a normal PR pays (e.g. CI
 *      parity, affected-scoped against `DOSSIER_BATCH_BASE`), run once for
 *      the whole batch. Its outcome maps to a `SuiteResult` exactly as
 *      `test.full`'s does; `capability-unavailable` (or no `ai-dossier` on
 *      PATH) falls through to tier 1.
 *   1. `cap run test.full` — the repo's own declared capability, when its
 *      manifest (`.dossier/automation/manifest.yaml`) has one `active`.
 *   2. `dispatch.suite_command` — an explicit per-project override in sched
 *      config, for a repo with no manifest yet.
 *   3. A repo-detected safe default — direct invocation of a recognized
 *      runner's own JSON reporter when the `test` script names one, else the
 *      plain `npm test` with NO extra flags appended (never forwarded
 *      through a wrapper that might not understand them).
 *
 * A report that comes back unreadable (empty stdout, no parseable JSON, a
 * spawn error) from tier 1 or 2 retries once with tier 3 before
 * giving up — `runValidate` treats a still-unreadable result as
 * `suite-unreadable` and blocks the batch (preserving every member commit)
 * rather than treating "nothing to attribute" as license to dissolve.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  type BatchSuiteContext,
  isReadableVitestReport,
  parseVitestJson,
  type SchedConfig,
  type SuiteResult,
} from '@ai-dossier/sched';
import { readPoolFileConfig, resolveProjectDir } from '@ai-dossier/worktree-pool';
import { type CapabilityManifest, loadCapabilityManifest, timeoutReasonSpent } from './capability';

/** The repo-declared batch gate (#777) — preferred over `test.full` when active. */
export const BATCH_GATE_CAPABILITY = 'gate.batch';

/** The aggregate full-suite capability — the batch gate's fallback. */
export const FULL_SUITE_CAPABILITY = 'test.full';

/**
 * Environment handed to every suite command (#777): which batch is being
 * gated and the ref it branched from, so a `gate.batch` capability can scope
 * itself to the union of the members' diffs (`git diff $DOSSIER_BATCH_BASE...HEAD`).
 * `cap run` runs its command with the inherited environment, so these reach it.
 */
function suiteEnv(ctx: BatchSuiteContext | undefined): NodeJS.ProcessEnv | undefined {
  if (ctx === undefined) return undefined;
  return { ...process.env, DOSSIER_BATCH_ID: ctx.batchId, DOSSIER_BATCH_BASE: ctx.baseRef };
}

/**
 * #777: the refusal reason when a repo's only full gate is one it declares
 * timeout-prone — no active `gate.batch`, and an active `test.full` marked
 * `timeout_prone: true`. A batch there pays a gate that usually ends
 * `suite-unreadable` (imboard #4244/#4253), so the batch should never be
 * formed. `null` = batching is fine (including "no manifest at all", which
 * falls back to `dispatch.suite_command`/detection as before).
 */
export function batchGateRefusal(manifest: CapabilityManifest): string | null {
  const gate = manifest.capabilities[BATCH_GATE_CAPABILITY];
  if (gate?.lifecycle === 'active') return null;
  const full = manifest.capabilities[FULL_SUITE_CAPABILITY];
  if (full?.lifecycle !== 'active' || full.timeoutProne !== true) return null;
  return (
    `this repo's only full gate is '${FULL_SUITE_CAPABILITY}', which its manifest (${manifest.path ?? '.dossier/automation/manifest.yaml'}) marks timeout_prone: true ` +
    `— a batch would pay a gate that usually never produces a verdict (suite-unreadable). ` +
    `Declare an active '${BATCH_GATE_CAPABILITY}' capability (the CI-parity gate a normal PR pays, scoped by DOSSIER_BATCH_BASE), or run these issues as full cycles.`
  );
}

/** Aggregate suite runs can be minutes long (full workspace test suite, not a focused subset). */
export const BATCH_SUITE_TIMEOUT_MS = 600_000;

/** Lets `cap run` finish manifest/probe setup without shortening its command's declared budget. */
export const CAP_RUN_SETUP_GRACE_MS = 10_000;

/**
 * `spawnSync`'s default `maxBuffer` is 1 MB — a full-workspace vitest JSON
 * report routinely exceeds that, and a truncated buffer surfaces as
 * `spawned.error` (ENOBUFS), which every batch would then read as an
 * unreadable report and block on (mirrors `cli/src/commands/run.ts`'s own
 * `maxBuffer` budget for the same reason).
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Tail of stderr appended to a failure `detail` — enough to show the real cause (e.g. `make: unrecognized option '--reporter=json'`, which goes to stderr) without unbounded log growth. */
const STDERR_TAIL_CHARS = 500;

function stderrTail(stderr: string | null | undefined): string {
  const trimmed = (stderr ?? '').trim();
  if (trimmed.length === 0) return '';
  return ` — stderr: ${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

interface RunOutcome {
  source: string;
  result: SuiteResult;
  /** A declared capability spent its whole budget, so a guessed retry is unsafe. */
  terminal?: boolean;
}

/** Run one argv command in `worktree`, parsing stdout as a vitest JSON report when possible. */
function runCommand(
  argv: readonly string[],
  worktree: string,
  source: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): SuiteResult {
  if (argv.length === 0) {
    return {
      ok: false,
      failing: [],
      readable: false,
      detail: `${source}: empty command — nothing to run`,
    };
  }
  const [cmd, ...args] = argv;
  const spawned = spawnSync(cmd, args, {
    cwd: worktree,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    ...(env !== undefined ? { env } : {}),
  });
  // `spawned.error` (ENOENT, ETIMEDOUT at the budget above, EACCES, ENOBUFS)
  // means the command never produced a trustworthy report — this must never
  // look like a parseable report naming zero failures.
  if (spawned.error) {
    return {
      ok: false,
      failing: [],
      readable: false,
      detail: `${source} (${argv.join(' ')}) failed to run: ${spawned.error.message} (cwd=${worktree})`,
    };
  }
  const stdout = spawned.stdout ?? '';
  const ok = spawned.status === 0;
  const readable = isReadableVitestReport(stdout);
  const failing = readable ? parseVitestJson(stdout) : [];
  return {
    ok,
    failing,
    readable: ok || readable,
    detail: ok
      ? `${source}: ${argv.join(' ')} — ok`
      : `${source}: ${argv.join(' ')} exited ${spawned.status ?? `signal ${spawned.signal ?? 'unknown'}`}` +
        (readable ? ` (${failing.length} failing)` : ' (report unreadable)') +
        (readable ? '' : stderrTail(spawned.stderr)),
  };
}

/**
 * Tiers 0/1: `ai-dossier cap run <gate.batch|test.full>` — both map their
 * envelope to a `SuiteResult` identically (#777 AC). Returns `'unavailable'`
 * when the repo has no manifest, no such entry, or it is `lifecycle: shadow` —
 * the capability layer's own `capability-unavailable` outcome — or when the
 * capability layer could not even be invoked (no `ai-dossier` on `PATH`, a
 * stale shadow copy) — either way "no trustworthy tier-1 answer
 * here", so the caller falls through to tier 2 (AC1's resolution order)
 * rather than skipping straight past a configured `dispatch.suite_command`.
 */
function runCapabilitySuite(
  capabilityId: string,
  worktree: string,
  capabilityTimeoutMs: number,
  env?: NodeJS.ProcessEnv
): RunOutcome | 'unavailable' {
  const source = `cap run ${capabilityId}`;
  const start = Date.now();
  const spawned = spawnSync('ai-dossier', ['cap', 'run', capabilityId], {
    cwd: worktree,
    encoding: 'utf-8',
    // The inner capability owns this budget; the outer watchdog has bounded setup grace.
    timeout: capabilityTimeoutMs + CAP_RUN_SETUP_GRACE_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    ...(env !== undefined ? { env } : {}),
  });
  if (spawned.error) {
    if ((spawned.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      const elapsedMs = Date.now() - start;
      return {
        source,
        terminal: true,
        result: {
          ok: false,
          failing: [],
          readable: false,
          detail: `${source}: ${timeoutReasonSpent(capabilityTimeoutMs)} (elapsed ${elapsedMs}ms; cwd=${worktree})`,
        },
      };
    }
    return 'unavailable';
  }
  const stdout = spawned.stdout ?? '';
  const lastLine = stdout.trim().split('\n').pop() ?? '';
  let envelope: {
    outcome?: string;
    exit_code?: number;
    reason?: string;
    duration_ms?: number;
  } | null = null;
  try {
    envelope = JSON.parse(lastLine) as {
      outcome?: string;
      exit_code?: number;
      reason?: string;
      duration_ms?: number;
    };
  } catch {
    envelope = null;
  }
  if (envelope?.outcome === 'capability-unavailable') return 'unavailable';
  // The exit code is `cap run`'s own — it cannot be forged by anything the
  // capability's command writes to stdout, unlike the envelope's `outcome`
  // field. Both must agree before this is trusted as green (#562 review).
  const ok = envelope?.outcome === 'ok' && spawned.status === 0;
  const readable = isReadableVitestReport(stdout);
  const failing = readable ? parseVitestJson(stdout) : [];
  const timedOut = envelope?.reason === timeoutReasonSpent(capabilityTimeoutMs);
  return {
    source,
    terminal: timedOut,
    result: {
      ok,
      failing,
      readable: ok || readable,
      detail:
        envelope !== null
          ? `${source}: outcome=${envelope.outcome} exit_code=${envelope.exit_code ?? 'unknown'}` +
            (envelope.reason ? ` reason=${envelope.reason}` : '') +
            (typeof envelope.duration_ms === 'number' ? ` elapsed ${envelope.duration_ms}ms` : '') +
            (!ok && readable ? ` (${failing.length} failing)` : '') +
            (!ok && !readable ? stderrTail(spawned.stderr) : '')
          : `${source}: task-failed (exit ${spawned.status ?? 'unknown'}), harness produced no envelope${stderrTail(spawned.stderr)}`,
    },
  };
}

/**
 * Tier 3: detect this repo's own `test` script and run it directly rather
 * than through `npm test -- <flags>` (the #562 bug) — a recognized runner
 * gets its own JSON reporter appended; anything else (a Makefile delegate, a
 * custom script, or no `test` script at all) runs as the plain `npm test`
 * with nothing appended, so a wrapper that cannot parse extra flags never
 * sees any.
 */
function detectSuiteCommand(worktree: string): string[] {
  let script: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    const raw = pkg.scripts?.test;
    // `scripts.test` is repo-controlled content (a batch member's own
    // package.json) — a non-string value must degrade to "no script found",
    // never throw out of this function and back into `safeSuite`'s
    // less-specific catch.
    script = typeof raw === 'string' ? raw : undefined;
  } catch {
    script = undefined;
  }
  const head = script?.trim().split(/\s+/)[0];
  if (head === 'vitest') return ['npx', '--no', 'vitest', 'run', '--reporter=json'];
  if (head === 'jest') return ['npx', '--no', 'jest', '--json'];
  // pytest's output is never a parseable vitest JSON report — a red pytest
  // suite is always `readable: false` here and blocks the batch rather than
  // attributing (set `dispatch.suite_command` to a JSON-reporting invocation,
  // e.g. `pytest --json-report`, to keep attribution available for a Python repo).
  if (head === 'pytest') return ['pytest', '--tb=short'];
  return ['npm', 'test'];
}

function runDetected(worktree: string, timeoutMs: number, env?: NodeJS.ProcessEnv): SuiteResult {
  const projectDir = resolveProjectDir(worktree, readPoolFileConfig(worktree).project_subdir);
  if (projectDir !== worktree && !projectDir.startsWith(worktree + path.sep)) {
    return {
      ok: false,
      failing: [],
      readable: false,
      detail: `detected: capability unavailable: project directory escapes worktree (cwd=${worktree})`,
    };
  }
  if (!fs.existsSync(path.join(projectDir, 'package.json'))) {
    return {
      ok: false,
      failing: [],
      readable: false,
      detail: `detected: capability unavailable: no package.json (cwd=${projectDir})`,
    };
  }
  return runCommand(detectSuiteCommand(projectDir), projectDir, 'detected', timeoutMs, env);
}

/** The worktree's manifest, or `null` when it is malformed — `cap run` reports that itself. */
function tryLoadManifest(worktree: string): CapabilityManifest | null {
  try {
    return loadCapabilityManifest(worktree);
  } catch {
    return null;
  }
}

function capabilityTimeout(
  manifest: CapabilityManifest | null,
  capabilityId: string,
  defaultTimeoutMs: number
): number {
  const entry = manifest?.capabilities[capabilityId];
  // A malformed manifest (`null`) retains the portable outer default.
  return entry?.lifecycle === 'active' ? (entry.timeoutMs ?? defaultTimeoutMs) : defaultTimeoutMs;
}

/**
 * Resolve and run the aggregate batch suite (#562) per the module doc's
 * tier order, retrying once with the tier-3 safe default when the resolved
 * primary tier's report is unreadable.
 *
 * `opts.timeoutMs` supplies the default `BATCH_SUITE_TIMEOUT_MS` fallback for
 * repos without an active, declared capability budget. A declared capability
 * timeout controls only that capability's `cap run`; tier 2 and 3 retain this
 * runner timeout.
 *
 * `ctx` (#777) becomes `DOSSIER_BATCH_ID`/`DOSSIER_BATCH_BASE` in every suite
 * command's environment.
 */
export function createBatchSuiteRunner(
  config: SchedConfig,
  opts: { timeoutMs?: number } = {}
): (worktree: string, ctx?: BatchSuiteContext) => SuiteResult {
  const defaultTimeoutMs = opts.timeoutMs ?? BATCH_SUITE_TIMEOUT_MS;
  return (worktree, ctx) => {
    const manifest = tryLoadManifest(worktree);
    const env = suiteEnv(ctx);
    let primary: RunOutcome;
    // Tier 0 (#777): only attempted when the manifest DECLARES an active
    // gate.batch — a repo without one pays exactly the pre-#777 spawns.
    let cap: RunOutcome | 'unavailable' = 'unavailable';
    if (manifest?.capabilities[BATCH_GATE_CAPABILITY]?.lifecycle === 'active') {
      cap = runCapabilitySuite(
        BATCH_GATE_CAPABILITY,
        worktree,
        capabilityTimeout(manifest, BATCH_GATE_CAPABILITY, defaultTimeoutMs),
        env
      );
    }
    if (cap === 'unavailable') {
      cap = runCapabilitySuite(
        FULL_SUITE_CAPABILITY,
        worktree,
        capabilityTimeout(manifest, FULL_SUITE_CAPABILITY, defaultTimeoutMs),
        env
      );
    }
    if (cap !== 'unavailable') {
      primary = cap;
    } else if (config.dispatch?.suite_command) {
      primary = {
        source: 'dispatch.suite_command',
        result: runCommand(
          config.dispatch.suite_command,
          worktree,
          'dispatch.suite_command',
          defaultTimeoutMs,
          env
        ),
      };
    } else {
      return runDetected(worktree, defaultTimeoutMs, env);
    }
    // A declared capability's non-zero outcome is the suite's verdict even
    // without a parseable Vitest report. Retrying detection would replace it
    // with an unrelated guess about the worktree layout.
    if (
      primary.source.startsWith('cap run ') ||
      primary.terminal ||
      primary.result.ok ||
      primary.result.readable !== false
    )
      return primary.result;
    const fallback = runDetected(worktree, defaultTimeoutMs, env);
    return {
      ...fallback,
      detail: `${fallback.detail ?? (fallback.ok ? 'suite green' : 'suite red')} [fallback after ${primary.source} was unreadable: ${primary.result.detail ?? 'no detail'}]`,
    };
  };
}
