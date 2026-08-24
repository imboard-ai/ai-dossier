/**
 * Timing analysis over `runstate:v1` milestone trails.
 *
 * Every milestone already stamps `at=`, so a run's per-phase durations are latent in the
 * trail the moment it is written — nothing needs to be measured, stored, or timed at run
 * time. This module is the read side of that decision: it turns the milestones
 * {@link ../runstate!parseMilestones} produces into per-phase spans and aggregates.
 *
 * Pure and dependency-free, exactly like `runstate.ts` — no `gh`, no network, no clock, no
 * filesystem — so the arithmetic is unit-testable against fixture trails and the command
 * layer only has to render what it returns.
 */

import { type ParsedMilestone, PHASES } from './runstate';

/**
 * The synthetic phase covering the gap between ship's two milestones — the PR is open and
 * green-pending, and nothing is being worked on. It is reported separately because it is
 * the one span in a run that measures waiting rather than working: folding it into `ship`
 * would make ship's median a function of CI queue depth rather than of the work.
 */
export const MERGE_WAIT_PHASE = 'merge-wait';

/**
 * Row order for aggregate tables: the protocol's phase order, with `merge-wait` sitting
 * where it happens (between ship and report). Alphabetical order would read
 * `gate, implement, merge-wait, plan, …`, which tells a reader nothing about a pipeline.
 */
export const STATS_PHASE_ORDER: readonly string[] = (() => {
  const shipIdx = PHASES.indexOf('ship');
  return [...PHASES.slice(0, shipIdx + 1), MERGE_WAIT_PHASE, ...PHASES.slice(shipIdx + 1)];
})();

/** The bucket a run lands in when its gate milestone carries no `model=` key. */
export const UNKNOWN_MODEL = 'unknown';

/** The group a milestone lands in when it carries no `run=` id. */
export const UNKNOWN_RUN = 'unknown-run';

/**
 * Most issues a single `--issues` selection may expand to.
 *
 * Each issue costs one `gh issue view` round trip, so a mistyped range (`1..10000`, a
 * transposed `1..99` written `1..999`) would sit there firing thousands of requests before
 * anyone noticed. The cap turns that into an immediate, named error.
 */
export const MAX_ISSUE_SELECTION = 200;

/**
 * `at=` values that a shell was supposed to expand and did not.
 *
 * Milestones written before the `runstate post` CLI existed were heredocs, and agents
 * pasted `at=$(date -u +%Y-%m-%dT%H:%M:%SZ)` verbatim often enough that real trails carry
 * it (`imboard-ai/imboard-monorepo#3684`). `post` now rejects `$` in any value, so no new
 * milestone can look like this — but the historical trails are exactly the ones worth
 * analysing, so they are skipped with a warning rather than crashing the run.
 */
const UNEXPANDED_RE = /[$`]/;

/**
 * A timestamp we are willing to do arithmetic on: ISO-8601 to at least seconds, UTC or
 * with an explicit offset. Deliberately stricter than `Date.parse`, which accepts
 * `"phase"` as a date on some engines and would hand back a plausible-looking NaN chain.
 */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const MILLIS_PER_SECOND = 1000;

/** One phase span within a run: what ran, when it ended, and how long it took. */
export interface PhaseTiming {
  /** Phase name, or {@link MERGE_WAIT_PHASE} for the gap between ship's two milestones. */
  phase: string;
  status: string;
  /** The previous usable milestone's `at=`, or null when there is no measurable start. */
  started_at: string | null;
  /** This milestone's `at=`. */
  ended_at: string;
  /** Elapsed seconds, or null when `started_at` is null. May be negative under clock skew. */
  seconds: number | null;
}

/** Every phase span of one run, plus what the whole run cost. */
export interface RunStats {
  issue: number;
  run: string;
  /** The `model=` recorded by the gate milestone (gate-issue ≥1.4.1), or null. */
  model: string | null;
  phases: PhaseTiming[];
  /** First usable milestone's `at=`. */
  started_at: string | null;
  /** Last usable milestone's `at=`. */
  ended_at: string | null;
  /** `started_at` → `ended_at`, or null when the run has fewer than two usable milestones. */
  total_seconds: number | null;
}

/** Median/min/max over every sample of one phase across the selected runs. */
export interface PhaseAggregate {
  phase: string;
  samples: number;
  median_seconds: number;
  min_seconds: number;
  max_seconds: number;
}

/** Per-`model=` view of whole-run totals — the point of recording `model=` at the gate. */
export interface ModelAggregate {
  model: string;
  runs: number;
  /** Runs of this model that had a measurable total. */
  samples: number;
  median_total_seconds: number | null;
  min_total_seconds: number | null;
  max_total_seconds: number | null;
}

export interface StatsAggregates {
  phases: PhaseAggregate[];
  models: ModelAggregate[];
}

/** Everything `runstate stats` needs to render, for one issue or many. */
export interface StatsReport {
  issues: number[];
  runs: RunStats[];
  aggregates: StatsAggregates;
  /** Issues in the selection whose trail had no runstate milestones at all. */
  issues_without_trail: number[];
  /** Degraded reads: skipped milestones, clock skew, missing run ids. */
  warnings: string[];
}

/** True when `value` is a timestamp this module will measure against. */
export function isUsableTimestamp(value: string): boolean {
  if (value === '' || UNEXPANDED_RE.test(value)) return false;
  if (!TIMESTAMP_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Whole seconds from `from` to `to`. Callers guarantee both are usable timestamps. */
function elapsedSeconds(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MILLIS_PER_SECOND);
}

/**
 * Median of a non-empty numeric list. Even counts average the two middle values — stated
 * because the other convention (lower middle) is equally common and the difference shows up
 * in exactly the small sample sizes these trails produce.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Seconds as the largest two units that carry information: `45s`, `5m 3s`, `2h 14m`,
 * `1d 3h`. Two units because one is too coarse to compare runs (`2h` hides 59 minutes) and
 * three is noise at these magnitudes.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return `-${formatDuration(-seconds)}`;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`;
  }
  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days}d ${Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR)}h`;
}

/** A duration for the table: human form plus the raw seconds it was derived from. */
export function formatDurationCell(seconds: number | null): string {
  return seconds === null ? '-' : `${formatDuration(seconds)} (${seconds}s)`;
}

/**
 * Expand a fleet-style issue selection — `1,2,3`, `1..9`, or mixed `1,2,5..8` — into a
 * sorted, de-duplicated list.
 *
 * Same grammar as `imboard-ai/git/fleet-cycle`, so an operator can paste the selection they
 * dispatched a fleet with straight into `stats` and measure exactly that set.
 *
 * @throws Error naming the offending token, so a typo in one of nine terms is not reported
 * as a failure of the whole selection.
 */
export function parseIssueSelection(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(`Empty issue selection — expected a list or range, e.g. 1,2,5..8`);
  }

  const issues = new Set<number>();
  for (const token of trimmed.split(',')) {
    const term = token.trim();
    if (term === '') {
      throw new Error(`Empty term in issue selection '${raw}' — check for a stray comma`);
    }
    for (const issue of expandTerm(term, raw)) issues.add(issue);
    // Checked inside the loop so an enormous FIRST range fails before the rest is expanded.
    if (issues.size > MAX_ISSUE_SELECTION) {
      throw new Error(
        `Issue selection '${raw}' expands past ${MAX_ISSUE_SELECTION} issues — each one costs a gh call. Narrow the range.`
      );
    }
  }

  return [...issues].sort((a, b) => a - b);
}

/** One comma-separated term of a selection: a single issue, or an inclusive `a..b` range. */
function expandTerm(term: string, raw: string): number[] {
  const range = term.split('..');
  if (range.length === 1) return [requireIssue(term, raw)];
  if (range.length !== 2) {
    throw new Error(`Malformed range '${term}' in '${raw}' — expected <from>..<to>, e.g. 5..8`);
  }

  const from = requireIssue(range[0], raw);
  const to = requireIssue(range[1], raw);
  if (to < from) {
    throw new Error(`Descending range '${term}' in '${raw}' — write it as ${to}..${from}`);
  }
  // Bounded before materialising: `1..1000000` must not allocate a million-entry array on
  // its way to the selection cap.
  if (to - from + 1 > MAX_ISSUE_SELECTION) {
    throw new Error(
      `Range '${term}' covers ${to - from + 1} issues, past the ${MAX_ISSUE_SELECTION} cap — each one costs a gh call. Narrow it.`
    );
  }

  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function requireIssue(value: string, raw: string): number {
  const term = value.trim();
  if (!/^[1-9]\d*$/.test(term)) {
    throw new Error(
      `Invalid issue '${term}' in '${raw}' — expected a positive issue number, e.g. 1,2,5..8`
    );
  }
  return Number(term);
}

/** One issue's trail, as the command layer hands it to {@link buildStatsReport}. */
export interface IssueTrail {
  issue: number;
  milestones: ParsedMilestone[];
}

/**
 * Group an issue's milestones by `run=`, preserving first-seen run order and, within each
 * run, the order the milestones were appended in.
 *
 * Grouping is the only reordering done. A resumed run keeps its id, so its milestones can
 * appear in the comment stream interleaved with another run's, and pairing across that
 * boundary would attribute one run's wait to another run's phase.
 *
 * Within a run, comment order is left alone rather than sorted by `at=`. The trail is
 * append-only, so comment order IS the causal order — whereas `at=` is stamped by whichever
 * machine ran the phase. Sorting on it would silently reorder two phases whose clocks
 * disagree, turning skew into a plausible-looking sequence; leaving it alone surfaces the
 * skew as a negative duration and a warning, which is a problem someone can act on.
 */
function groupByRun(milestones: ParsedMilestone[]): Map<string, ParsedMilestone[]> {
  const groups = new Map<string, ParsedMilestone[]>();
  for (const milestone of milestones) {
    const key = milestone.run || UNKNOWN_RUN;
    const group = groups.get(key);
    if (group) group.push(milestone);
    else groups.set(key, [milestone]);
  }
  return groups;
}

/**
 * The phase name a milestone is reported under.
 *
 * A `ship` milestone that follows ship's `awaiting-merge` is the far side of the CI +
 * merge wait, so it is relabelled — the row measures the wait, not a second ship.
 */
function phaseNameFor(milestone: ParsedMilestone, previous: ParsedMilestone | null): string {
  const followsAwaitingMerge =
    previous !== null && previous.phase === 'ship' && previous.status === 'awaiting-merge';
  return milestone.phase === 'ship' && followsAwaitingMerge ? MERGE_WAIT_PHASE : milestone.phase;
}

/**
 * Turn one run's milestones into phase spans.
 *
 * Each milestone is paired with the previous **usable** one. A milestone whose `at=` cannot
 * be read is dropped AND breaks the chain: pairing across the hole would report a single
 * duration silently covering two phases, which reads as a real measurement. The row after a
 * break is `-`, and the warning says which milestone caused it.
 */
function timePhases(
  issue: number,
  run: string,
  milestones: ParsedMilestone[],
  warn: (line: string) => void
): RunStats {
  const phases: PhaseTiming[] = [];
  let previous: ParsedMilestone | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const milestone of milestones) {
    const phase = phaseNameFor(milestone, previous);

    if (!isUsableTimestamp(milestone.at)) {
      warn(
        `issue #${issue} run ${run}: ${milestone.phase || '(no phase)'} milestone has an unusable at= value ('${milestone.at || '(empty)'}') — skipped, and the next phase's duration is reported as unknown`
      );
      previous = null;
      continue;
    }

    const startedAt = previous === null ? null : previous.at;
    const seconds = startedAt === null ? null : elapsedSeconds(startedAt, milestone.at);
    if (seconds !== null && seconds < 0) {
      warn(
        `issue #${issue} run ${run}: ${phase} ended before it started (${startedAt} → ${milestone.at}) — reported as a negative duration; the milestones were stamped by clocks that disagree`
      );
    }

    phases.push({
      phase,
      status: milestone.status,
      started_at: startedAt,
      ended_at: milestone.at,
      seconds,
    });

    if (firstAt === null) firstAt = milestone.at;
    lastAt = milestone.at;
    previous = milestone;
  }

  const model = modelOf(milestones);
  return {
    issue,
    run,
    model,
    phases,
    started_at: firstAt,
    ended_at: lastAt,
    total_seconds: firstAt !== null && lastAt !== null ? elapsedSeconds(firstAt, lastAt) : null,
  };
}

/**
 * The run's `model=`, taken from its gate milestone.
 *
 * Only the gate records it (gate-issue ≥1.4.1) and only that one is authoritative, but a
 * resumed run's later phases may have executed on a different agent — so any milestone
 * carrying the key is accepted as a fallback rather than reporting `unknown` for a trail
 * that plainly names its model.
 */
function modelOf(milestones: ParsedMilestone[]): string | null {
  const gate = milestones.find((m) => m.phase === 'gate' && m.keys.model);
  if (gate) return gate.keys.model;
  return milestones.find((m) => m.keys.model)?.keys.model ?? null;
}

/** Per-phase median/min/max across every run in the report. */
function aggregatePhases(runs: RunStats[]): PhaseAggregate[] {
  const samples = new Map<string, number[]>();
  for (const run of runs) {
    for (const phase of run.phases) {
      if (phase.seconds === null) continue;
      const list = samples.get(phase.phase);
      if (list) list.push(phase.seconds);
      else samples.set(phase.phase, [phase.seconds]);
    }
  }

  return [...samples.entries()]
    .map(([phase, values]) => ({
      phase,
      samples: values.length,
      median_seconds: median(values),
      min_seconds: Math.min(...values),
      max_seconds: Math.max(...values),
    }))
    .sort(byStatsPhaseOrder);
}

/** Protocol phase order, with anything unrecognised sorted alphabetically after it. */
function byStatsPhaseOrder(a: { phase: string }, b: { phase: string }): number {
  const ai = STATS_PHASE_ORDER.indexOf(a.phase);
  const bi = STATS_PHASE_ORDER.indexOf(b.phase);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.phase.localeCompare(b.phase);
}

/** Whole-run totals bucketed by `model=`, so runs become comparable across models. */
function aggregateModels(runs: RunStats[]): ModelAggregate[] {
  const buckets = new Map<string, { runs: number; totals: number[] }>();
  for (const run of runs) {
    const key = run.model ?? UNKNOWN_MODEL;
    const bucket = buckets.get(key) ?? { runs: 0, totals: [] };
    bucket.runs += 1;
    if (run.total_seconds !== null) bucket.totals.push(run.total_seconds);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([model, bucket]) => ({
      model,
      runs: bucket.runs,
      samples: bucket.totals.length,
      median_total_seconds: bucket.totals.length > 0 ? median(bucket.totals) : null,
      min_total_seconds: bucket.totals.length > 0 ? Math.min(...bucket.totals) : null,
      max_total_seconds: bucket.totals.length > 0 ? Math.max(...bucket.totals) : null,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Build the whole report from already-fetched trails.
 *
 * Takes trails rather than issue numbers so every rule here — grouping, pairing, skipping,
 * aggregating — is testable against fixture milestones without a `gh` in sight.
 */
export function buildStatsReport(trails: IssueTrail[]): StatsReport {
  const warnings: string[] = [];
  const warn = (line: string): void => {
    if (!warnings.includes(line)) warnings.push(line);
  };

  const runs: RunStats[] = [];
  const withoutTrail: number[] = [];

  for (const trail of trails) {
    if (trail.milestones.length === 0) {
      withoutTrail.push(trail.issue);
      continue;
    }
    for (const [run, milestones] of groupByRun(trail.milestones)) {
      if (run === UNKNOWN_RUN) {
        warn(
          `issue #${trail.issue}: ${milestones.length} milestone(s) carry no run= id — grouped together as '${UNKNOWN_RUN}', so their durations may span unrelated runs`
        );
      }
      runs.push(timePhases(trail.issue, run, milestones, warn));
    }
  }

  return {
    issues: trails.map((t) => t.issue),
    runs,
    aggregates: { phases: aggregatePhases(runs), models: aggregateModels(runs) },
    issues_without_trail: withoutTrail,
    warnings,
  };
}

/** Column alignment. Numeric columns read right-aligned; everything else left. */
export type ColumnAlign = 'left' | 'right';

/**
 * Render a table with each column padded to its widest cell (AC4's tabular alignment).
 *
 * Generic rather than shaped to one table: `stats` prints four different tables and every
 * other subcommand that grows one should reach for this rather than hand-pad again.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  align: ColumnAlign[] = []
): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length))
  );
  const pad = (cell: string, i: number): string =>
    align[i] === 'right' ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => pad(cell ?? '', i))
      .join('  ')
      .trimEnd();

  return [line(headers), ...rows.map(line)].join('\n');
}
