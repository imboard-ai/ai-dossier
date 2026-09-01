/**
 * Timing analysis over `runstate:v1` milestone trails.
 *
 * Every milestone already stamps `at=`, so a run's per-phase durations are latent in the
 * trail the moment it is written — nothing needs to be measured, stored, or timed at run
 * time. This module is the read side of that decision: it turns the milestones
 * {@link ./runstate!parseMilestones} produces into per-phase spans and aggregates.
 *
 * Pure and dependency-free — no `gh`, no network, no clock, no filesystem — so the
 * arithmetic is unit-testable against fixture trails and the command layer only has to
 * render what it returns.
 */

import { MILLIS_PER_SECOND } from './duration';
import {
  ALL_PHASES,
  type BatchPhase,
  type ParsedMilestone,
  type Phase,
  type Status,
} from './runstate';

/**
 * The synthetic phase covering the gap between ship's two milestones — the PR is open and
 * green-pending, and nothing is being worked on. It is reported separately because it is
 * the one span in a run that measures waiting rather than working: folding it into `ship`
 * would make ship's median a function of CI queue depth rather than of the work.
 */
export const MERGE_WAIT_PHASE = 'merge-wait';

/**
 * batch-ship's equivalent gap, reported under its own label rather than pooled with
 * full-cycle `merge-wait`: in a mixed `--issues` selection (batch anchors alongside
 * member issues) a shared label would silently mix the two populations, and the row
 * would sort into the full-cycle section of the table rather than sitting with the
 * batch line it belongs to.
 */
export const BATCH_MERGE_WAIT_PHASE = 'batch-merge-wait';

/**
 * Phase and status literals this module branches on.
 *
 * Annotated with the protocol's own types so a rename in {@link ./runstate!PHASES} or
 * {@link ./runstate!STATUSES} fails the build here, rather than silently switching off
 * merge-wait detection and the `model=` lookup — the two things this module exists for.
 */
const SHIP_PHASE: Phase = 'ship';
const GATE_PHASE: Phase = 'gate';
const REPORT_PHASE: Phase = 'report';
const BATCH_SHIP_PHASE: BatchPhase = 'batch-ship';
const BATCH_REPORT_PHASE: BatchPhase = 'batch-report';
const AWAITING_MERGE: Status = 'awaiting-merge';
const DONE: Status = 'done';
const BLOCKED: Status = 'blocked';

/**
 * Row order for aggregate tables: `ALL_PHASES` order (classify, the full-cycle line,
 * the batch line), with a merge-wait row inserted after each ship-like phase where the
 * wait happens. Derived from {@link ./runstate!ALL_PHASES} so a phase added there lands
 * here too, rather than silently sorting to the end alphabetically.
 */
export const STATS_PHASE_ORDER: readonly string[] = ALL_PHASES.flatMap((phase) =>
  phase === SHIP_PHASE
    ? [phase, MERGE_WAIT_PHASE]
    : phase === BATCH_SHIP_PHASE
      ? [phase, BATCH_MERGE_WAIT_PHASE]
      : [phase]
);

/** The bucket a run lands in when no milestone in the run carries a `model=` key. */
export const UNKNOWN_MODEL = 'unknown';

/**
 * Gateway and provider tokens stripped from a recorded `model=` to find its bucket.
 *
 * Agents record whatever id their CLI was invoked with, and the same model reaches the trail
 * under several spellings depending on how it was routed: `glm-5.3` direct vs
 * `llmgateway/glm-5.3` through a gateway, `z-ai/glm-latest` vs opencode's `~z-ai/glm-latest`
 * alias form, `openrouter-kimi-latest` vs `moonshotai/kimi-latest`. Unbucketed, a single
 * model's runs split across rows and the per-model view — the whole reason the gate records
 * `model=` — answers a question nobody asked (`imboard-ai/ai-dossier#528`).
 *
 * Deliberately an allowlist of *known routing* tokens, never a generic "drop the first
 * segment" rule: merging two genuinely different models is the one error this table cannot
 * survive, so an unrecognised leading segment is always kept.
 */
export const MODEL_ROUTING_PREFIXES: readonly string[] = [
  'llmgateway',
  'openrouter',
  'moonshotai',
  'anthropic',
  'alibaba',
  'google',
  'openai',
  'z-ai',
  'zai',
];

/** Separators a routing prefix is joined to the model id with. */
const ROUTING_SEPARATORS: readonly string[] = ['/', '-'];

/** Bound on prefix stripping, so a pathological id (`llmgateway/openrouter/…`) still terminates. */
const MAX_ROUTING_PREFIXES = 4;

/**
 * The bucket key for a recorded `model=` — the model itself, with routing noise removed.
 *
 * Lowercased, any leading `~` (opencode's gateway-alias marker) dropped, then known routing
 * prefixes peeled off. Never returns empty: an id that is *only* routing tokens is its own
 * bucket rather than collapsing into every other such id.
 */
export function canonicalModel(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  let value = lowered.replace(/^~+/, '');

  for (let i = 0; i < MAX_ROUTING_PREFIXES; i++) {
    const stripped = stripRoutingPrefix(value);
    if (stripped === null) break;
    value = stripped;
  }

  return value === '' ? lowered : value;
}

/** One routing prefix off the front of `value`, or null when it does not start with one. */
function stripRoutingPrefix(value: string): string | null {
  for (const prefix of MODEL_ROUTING_PREFIXES) {
    for (const separator of ROUTING_SEPARATORS) {
      const head = `${prefix}${separator}`;
      // `length >` and not `>=`: a value that is nothing but a prefix keeps its identity.
      if (value.startsWith(head) && value.length > head.length) return value.slice(head.length);
    }
  }
  return null;
}

/** The group a milestone lands in when it carries no `run=` id. */
export const UNKNOWN_RUN = 'unknown-run';

/**
 * `at=` values that a shell was supposed to expand and did not.
 *
 * Milestones written before the `runstate post` CLI existed were heredocs, and agents
 * pasted `at=$(date -u +%Y-%m-%dT%H:%M:%SZ)` verbatim often enough that real trails carry
 * it (`imboard-ai/imboard-monorepo#3684`). The class also covers backticks, the other
 * shell-substitution form: `post` rejects `$` outright so no new milestone can carry one,
 * and a backtick is treated the same here defensively.
 */
const UNEXPANDED_RE = /[$`]/;

/**
 * A timestamp we are willing to do arithmetic on: ISO-8601 to at least seconds, UTC or
 * with an explicit offset. Deliberately stricter than `Date.parse`, which accepts
 * `"phase"` as a date on some engines and would hand back a plausible-looking NaN chain.
 */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Longest a milestone-derived value may be once it reaches a table cell or a warning.
 *
 * Every `key=value` in a trail is remote data — anyone who can comment on the issue can
 * post something shaped like a milestone — so an untruncated value is a 65 KB comment
 * pasted into an operator's terminal.
 */
const MAX_CELL_LENGTH = 120;

/** The replacement drawn in place of a control character. */
const CONTROL_REPLACEMENT = '�';

/**
 * Make a milestone-derived value safe to print.
 *
 * Control characters are the real hazard, not merely a cosmetic one: `parseMilestone` is
 * deliberately tolerant and validates nothing but the marker, so `status=` or `model=` can
 * carry ANSI escapes or a carriage return. Printed raw, those repaint or erase rows of the
 * table an operator reads to decide whether a run succeeded. They also make `.length`
 * disagree with the drawn width, which silently destroys column alignment.
 */
export function renderValue(value: string): string {
  let clean = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? CONTROL_REPLACEMENT : char;
  }
  return clean.length > MAX_CELL_LENGTH ? `${clean.slice(0, MAX_CELL_LENGTH)}…` : clean;
}

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
  /** The `model=` recorded by the run (see {@link modelOf}), or null. */
  model: string | null;
  phases: PhaseTiming[];
  /** The last milestone's phase — how far the run actually got. */
  last_phase: string;
  /** The last milestone's status, so an in-flight or blocked run is recognisable. */
  last_status: string;
  /** First usable milestone's `at=`. */
  started_at: string | null;
  /** Last usable milestone's `at=`. */
  ended_at: string | null;
  /**
   * `started_at` → `ended_at`, or null when the run has fewer than TWO usable milestones.
   *
   * One usable milestone is not a zero-length run — it is a run whose length is unknown,
   * which is the normal state of anything still in flight. Reporting it as `0` would drag
   * every median it feeds toward zero with a duration nobody measured.
   */
  total_seconds: number | null;
}

/** Median/min/max over every sample of one phase across the selected runs. */
export interface PhaseAggregate {
  phase: string;
  /** Spans of this phase that had a measurable duration; unmeasurable ones are excluded. */
  samples: number;
  median_seconds: number;
  min_seconds: number;
  max_seconds: number;
  /** Samples below zero, i.e. from clock skew — a median over these is not meaningful. */
  negative_samples: number;
}

/**
 * Per-`model=` view of whole-run totals and outcomes — the point of recording `model=`.
 *
 * Duration alone answers "how long", never "which models finish the work". Both are needed
 * to route a tier at a model with any evidence behind it, so the bucket carries the run's
 * terminal state alongside its span.
 */
export interface ModelAggregate {
  /** Canonical bucket key — see {@link canonicalModel}. */
  model: string;
  /**
   * The distinct raw `model=` spellings that folded into this bucket, sorted.
   *
   * Always populated (a bucket with one spelling lists that one), so a fold is visible in
   * the output rather than silently reshaping someone's cohort.
   */
  aliases: string[];
  runs: number;
  /** Runs of this model whose total was measurable; the rest are excluded below. */
  samples: number;
  median_total_seconds: number | null;
  min_total_seconds: number | null;
  max_total_seconds: number | null;
  negative_samples: number;
  /**
   * Runs whose last milestone was a delivery phase at `done` — see {@link DELIVERED_PHASES}.
   */
  completed: number;
  /** Runs whose last milestone was `blocked`, whatever the phase. */
  blocked: number;
  /** Everything else: still in flight, parked awaiting merge, partial, or fenced. */
  unfinished: number;
  /** `completed / runs`, in [0, 1]. */
  completion_rate: number;
}

/** The two cross-run rollups: per-phase spread, and whole-run totals bucketed by model. */
export interface StatsAggregates {
  phases: PhaseAggregate[];
  models: ModelAggregate[];
}

/** An issue in the selection that could not be read at all, and why. */
export interface FailedIssue {
  issue: number;
  error: string;
}

/** Everything `runstate stats` needs to render, for one issue or many. */
export interface StatsReport {
  /** The repository the trails were read from, when the caller named one. */
  repo: string | null;
  issues: number[];
  runs: RunStats[];
  aggregates: StatsAggregates;
  /** Issues in the selection whose trail had no runstate milestones at all. */
  issues_without_trail: number[];
  /** Issues that could not be read — distinct from an issue that simply has no trail. */
  issues_failed: FailedIssue[];
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
 * Median of a non-empty numeric list, rounded to whole seconds.
 *
 * Even counts average the two middle values — stated because the other convention (lower
 * middle) is equally common and the difference shows up in exactly the small sample sizes
 * these trails produce.
 *
 * @throws when `values` is empty — an empty median is `NaN`, which renders as a
 * plausible-looking `NaN (NaNs)` cell rather than announcing itself.
 */
export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error('median() requires at least one sample');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Smallest value, folded rather than spread — see {@link ./table!renderTable}. */
function minOf(values: number[]): number {
  return values.reduce((a, b) => (b < a ? b : a));
}

/** Largest value, folded rather than spread. */
function maxOf(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a));
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
 * A ship-like milestone (`ship`/`batch-ship`) that follows the SAME phase's
 * `awaiting-merge` is the far side of the CI + merge wait, so it is relabelled — the row
 * measures the wait, not a second ship. The same-phase requirement is part of the
 * contract: a `ship` → `batch-ship` transition (malformed on any real trail) must not
 * be relabelled.
 */
function phaseNameFor(milestone: ParsedMilestone, previous: ParsedMilestone | null): string {
  if (
    previous !== null &&
    previous.phase === milestone.phase &&
    previous.status === AWAITING_MERGE
  ) {
    if (milestone.phase === SHIP_PHASE) return MERGE_WAIT_PHASE;
    if (milestone.phase === BATCH_SHIP_PHASE) return BATCH_MERGE_WAIT_PHASE;
  }
  return milestone.phase;
}

/** How a caller records a degraded read. */
type Warn = (line: string) => void;

/** Where an issue reference in a warning comes from, so `--repo` is not lost. */
function issueRef(repo: string | null, issue: number): string {
  return repo ? `${repo}#${issue}` : `#${issue}`;
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
  repo: string | null,
  issue: number,
  run: string,
  milestones: ParsedMilestone[],
  warn: Warn
): RunStats {
  const phases: PhaseTiming[] = [];
  let previous: ParsedMilestone | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let usable = 0;

  const where = `issue ${issueRef(repo, issue)} run ${renderValue(run)}`;

  for (const milestone of milestones) {
    const phase = phaseNameFor(milestone, previous);

    if (!isUsableTimestamp(milestone.at)) {
      warn(
        `${where}: ${renderValue(milestone.phase) || '(no phase)'} milestone has an unusable at= value ('${renderValue(milestone.at) || '(empty)'}') — skipped, and the next phase's duration is reported as unknown`
      );
      previous = null;
      continue;
    }

    const startedAt = previous === null ? null : previous.at;
    const seconds = startedAt === null ? null : elapsedSeconds(startedAt, milestone.at);
    if (seconds !== null && seconds < 0) {
      warn(
        `${where}: ${renderValue(phase)} ended before it started (${startedAt} → ${milestone.at}) — reported as a negative duration; the milestones were stamped by clocks that disagree`
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
    usable += 1;
    previous = milestone;
  }

  const last = milestones[milestones.length - 1];
  return {
    issue,
    run,
    model: modelOf(milestones),
    phases,
    last_phase: last?.phase ?? '',
    last_status: last?.status ?? '',
    started_at: firstAt,
    ended_at: lastAt,
    // Two usable milestones are the minimum that bounds a span at both ends.
    total_seconds:
      usable >= 2 && firstAt !== null && lastAt !== null ? elapsedSeconds(firstAt, lastAt) : null,
  };
}

/**
 * The run's `model=`, taken from its gate milestone.
 *
 * Only the gate is asked to record it (`imboard-ai/git/gate-issue` from 1.4.1 onward — the
 * `examples/` copy in this repo predates the key), and only that one is authoritative. But
 * a resumed run's later phases may have executed on a different agent, so any milestone
 * carrying the key is accepted as a fallback rather than reporting `unknown` for a trail
 * that plainly names its model.
 */
function modelOf(milestones: ParsedMilestone[]): string | null {
  const gate = milestones.find((m) => m.phase === GATE_PHASE && m.keys.model);
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
      min_seconds: minOf(values),
      max_seconds: maxOf(values),
      negative_samples: values.filter((v) => v < 0).length,
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

/**
 * Phases whose `done` means the work was delivered.
 *
 * `report` is the protocol's terminal phase, but `ship done` is posted only after the merge
 * AND teardown are confirmed — the PR is in the base branch by then. The report tail is
 * routinely a *separately dispatched* run (the scheduler dispatches a report agent against
 * a merged PR), so counting `report` alone would score the delivering run as unfinished and
 * report a completion rate far below what the trail actually shows.
 */
const DELIVERED_PHASES: readonly string[] = [
  SHIP_PHASE,
  REPORT_PHASE,
  BATCH_SHIP_PHASE,
  BATCH_REPORT_PHASE,
];

/** True when the run's last milestone says the work was delivered, not merely stopped. */
function isCompleted(run: RunStats): boolean {
  return run.last_status === DONE && DELIVERED_PHASES.includes(run.last_phase);
}

/** Whole-run totals and outcomes bucketed by `model=`, so runs become comparable across models. */
function aggregateModels(runs: RunStats[]): ModelAggregate[] {
  interface Bucket {
    runs: number;
    totals: number[];
    aliases: Set<string>;
    completed: number;
    blocked: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const run of runs) {
    const raw = run.model ?? UNKNOWN_MODEL;
    const key = run.model === null ? UNKNOWN_MODEL : canonicalModel(run.model);
    const bucket = buckets.get(key) ?? {
      runs: 0,
      totals: [],
      aliases: new Set<string>(),
      completed: 0,
      blocked: 0,
    };
    bucket.runs += 1;
    bucket.aliases.add(raw);
    if (run.total_seconds !== null) bucket.totals.push(run.total_seconds);
    if (isCompleted(run)) bucket.completed += 1;
    else if (run.last_status === BLOCKED) bucket.blocked += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([model, bucket]) => {
      const measured = bucket.totals.length > 0;
      return {
        model,
        aliases: [...bucket.aliases].sort(),
        runs: bucket.runs,
        samples: bucket.totals.length,
        median_total_seconds: measured ? median(bucket.totals) : null,
        min_total_seconds: measured ? minOf(bucket.totals) : null,
        max_total_seconds: measured ? maxOf(bucket.totals) : null,
        negative_samples: bucket.totals.filter((v) => v < 0).length,
        completed: bucket.completed,
        blocked: bucket.blocked,
        unfinished: bucket.runs - bucket.completed - bucket.blocked,
        completion_rate: bucket.completed / bucket.runs,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** One aggregate row's skew note, or null when every sample was forwards. */
export function skewNote(negativeSamples: number): string | null {
  if (negativeSamples === 0) return null;
  return `${negativeSamples} skewed`;
}

export interface StatsInput {
  trails: IssueTrail[];
  /** Issues that could not be read at all. */
  failed?: FailedIssue[];
  /** The repository the trails came from, for unambiguous issue references. */
  repo?: string;
}

/**
 * Build the whole report from already-fetched trails.
 *
 * Takes trails rather than issue numbers so every rule here — grouping, pairing, skipping,
 * aggregating — is testable against fixture milestones without a `gh` in sight.
 */
export function buildStatsReport(input: StatsInput): StatsReport {
  const { trails, failed = [], repo = null } = input;

  // Counted rather than de-duplicated: two milestones skipped for the same reason produce
  // byte-identical warnings, and collapsing them makes an operator under-count what was
  // dropped. The Map also keeps this linear — `Array.includes` per warning is O(n²) over
  // remote data, i.e. over however many comments anyone chose to post.
  const counts = new Map<string, number>();
  const warn: Warn = (line) => counts.set(line, (counts.get(line) ?? 0) + 1);

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
          `issue ${issueRef(repo, trail.issue)}: ${milestones.length} milestone(s) carry no run= id — grouped together as '${UNKNOWN_RUN}', so their durations may span unrelated runs`
        );
      }
      runs.push(timePhases(repo, trail.issue, run, milestones, warn));
    }
  }

  const phases = aggregatePhases(runs);
  const models = aggregateModels(runs);
  for (const phase of phases) {
    if (phase.negative_samples > 0) {
      warn(
        `aggregate for phase '${renderValue(phase.phase)}' includes ${phase.negative_samples} negative sample(s) from clock skew — its median and min are not meaningful`
      );
    }
  }

  return {
    repo,
    issues: trails.map((t) => t.issue),
    runs,
    aggregates: { phases, models },
    issues_without_trail: withoutTrail,
    issues_failed: failed,
    warnings: [...counts.entries()].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line)),
  };
}
