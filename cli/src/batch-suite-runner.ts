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
 * spawn/timeout error) from tier 1 or 2 retries once with tier 3 before
 * giving up — `runValidate` treats a still-unreadable result as
 * `suite-unreadable` and blocks the batch (preserving every member commit)
 * rather than treating "nothing to attribute" as license to dissolve.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  isReadableVitestReport,
  parseVitestJson,
  type SchedConfig,
  type SuiteResult,
} from '@ai-dossier/sched';

/** Aggregate suite runs can be minutes long (full workspace test suite, not a focused subset). */
export const BATCH_SUITE_TIMEOUT_MS = 600_000;

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
}

/** Run one argv command in `worktree`, parsing stdout as a vitest JSON report when possible. */
function runCommand(
  argv: readonly string[],
  worktree: string,
  source: string,
  timeoutMs: number
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
 * Tier 1: `ai-dossier cap run test.full`. Returns `'unavailable'` when the
 * repo has no manifest, no `test.full` entry, or it is `lifecycle: shadow` —
 * the capability layer's own `capability-unavailable` outcome — or when the
 * capability layer could not even be invoked (no `ai-dossier` on `PATH`, a
 * stale shadow copy, a timeout) — either way "no trustworthy tier-1 answer
 * here", so the caller falls through to tier 2 (AC1's resolution order)
 * rather than skipping straight past a configured `dispatch.suite_command`.
 */
function runCapabilityTestFull(worktree: string, timeoutMs: number): RunOutcome | 'unavailable' {
  const source = 'cap run test.full';
  const spawned = spawnSync('ai-dossier', ['cap', 'run', 'test.full'], {
    cwd: worktree,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (spawned.error) return 'unavailable';
  const stdout = spawned.stdout ?? '';
  const lastLine = stdout.trim().split('\n').pop() ?? '';
  let envelope: { outcome?: string; exit_code?: number; reason?: string } | null = null;
  try {
    envelope = JSON.parse(lastLine) as { outcome?: string; exit_code?: number; reason?: string };
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
  return {
    source,
    result: {
      ok,
      failing,
      readable: ok || readable,
      detail:
        envelope !== null
          ? `${source}: outcome=${envelope.outcome} exit_code=${envelope.exit_code ?? 'unknown'}` +
            (envelope.reason ? ` reason=${envelope.reason}` : '') +
            (!ok && readable ? ` (${failing.length} failing)` : '') +
            (!ok && !readable ? stderrTail(spawned.stderr) : '')
          : `${source}: no envelope line — treating as unreadable${stderrTail(spawned.stderr)}`,
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

function runDetected(worktree: string, timeoutMs: number): SuiteResult {
  return runCommand(detectSuiteCommand(worktree), worktree, 'detected', timeoutMs);
}

/**
 * Resolve and run the aggregate batch suite (#562) per the module doc's
 * three-tier order, retrying once with the tier-3 safe default when the
 * resolved primary tier's report is unreadable.
 *
 * `timeoutMs` defaults to `BATCH_SUITE_TIMEOUT_MS` — overridable so a future
 * test can exercise a REAL `spawnSync` timeout (ETIMEDOUT) against a
 * deliberately slow fixture command without waiting ten minutes for it; this
 * module's own tests mock `spawnSync` directly instead and don't need it.
 */
export function createBatchSuiteRunner(
  config: SchedConfig,
  opts: { timeoutMs?: number } = {}
): (worktree: string) => SuiteResult {
  const timeoutMs = opts.timeoutMs ?? BATCH_SUITE_TIMEOUT_MS;
  return (worktree) => {
    let primary: RunOutcome;
    const cap = runCapabilityTestFull(worktree, timeoutMs);
    if (cap !== 'unavailable') {
      primary = cap;
    } else if (config.dispatch?.suite_command) {
      primary = {
        source: 'dispatch.suite_command',
        result: runCommand(
          config.dispatch.suite_command,
          worktree,
          'dispatch.suite_command',
          timeoutMs
        ),
      };
    } else {
      return runDetected(worktree, timeoutMs);
    }
    if (primary.result.ok || primary.result.readable !== false) return primary.result;
    const fallback = runDetected(worktree, timeoutMs);
    return {
      ...fallback,
      detail: `${fallback.detail ?? (fallback.ok ? 'suite green' : 'suite red')} [fallback after ${primary.source} was unreadable: ${primary.result.detail ?? 'no detail'}]`,
    };
  };
}
