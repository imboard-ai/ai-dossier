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
  CLASSIFY_MODES,
  CLASSIFY_PHASE,
  NON_NEGATIVE_INT_RE,
  type ParsedMilestone,
  type Phase,
  RISK_LEVELS,
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
const REVIEW_PHASE: Phase = 'review';
const BATCH_REVIEW_PHASE: BatchPhase = 'batch-review';
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

/**
 * The bucket a run lands in when no milestone in the run carries a `model=` key.
 *
 * Angle-bracketed so it cannot be forged: {@link canonicalModel} lowercases and peels routing
 * prefixes, and no input it accepts produces a leading `<`. A bare `unknown` was reachable from
 * remote input (`Unknown`, `llmgateway/unknown`, `~~~unknown` all canonicalise to it), which
 * would let anyone who can comment on an issue steer the "we could not attribute this" row.
 */
export const UNKNOWN_MODEL = '<unknown>';

/**
 * The class bucket for a run whose issue carries no classifier verdict.
 *
 * Bracketed like {@link UNKNOWN_MODEL}, and unforgeable for the same *mechanical* reason
 * rather than by appeal to the write-path contract: {@link classificationOf} accepts only
 * the closed {@link ./runstate!RISK_LEVELS} set, and none of those values starts with `<`.
 * Without that read-side check a comment carrying `risk=<unclassified>` would fold forged
 * runs into this bucket and skew {@link classWarnings}' coverage share — the one number
 * telling a reader how thin the axis is.
 *
 * An issue that was never classified gets its own row rather than being folded into `low`.
 * On this repo that row is the *majority* today — the classifier is newer than most of the
 * corpus — so hiding it would overstate the class axis's coverage.
 */
export const UNCLASSIFIED_CLASS = '<unclassified>';

/**
 * Scale for turning a fraction in [0, 1] into a whole-percent figure.
 *
 * Exported so this module's warning text and the command layer's table cells cannot drift
 * onto two different constants.
 */
export const PERCENT = 100;

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
  // Longest first: `stripRoutingPrefix` takes the first match, so `zai` listed ahead of
  // `zai-coding-plan` would peel `zai-` off the unqualified form and leave `coding-plan-…`.
  'zai-coding-plan',
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

/**
 * Moving version tags folded onto the pinned version they currently point at.
 *
 * Applied after routing prefixes are peeled, so every routed spelling of a tag
 * (`llmgateway/glm-latest`, `openrouter/~z-ai/glm-latest`) folds with the bare one.
 *
 * This table is **owner-maintained and cannot be derived**: whether `glm-latest` and
 * `glm-5.3` are the same weights is a fact about the provider's current state, not
 * about the strings. The entry below is the mapping declared in imboard-ai/ai-dossier#566
 * ("`glm-5.3` = `llmgateway/glm-5.3` = `openrouter/~z-ai/glm-latest` -> one row"). It goes
 * stale the moment z.ai ships a new pin under the same tag — when that happens, update
 * the value here rather than adding a second row downstream. Tags whose pin nobody has
 * declared (`kimi-latest`, with both `kimi-k3` and `kimi-k3-fast` in the fleet) are
 * deliberately absent: a guessed alias misattributes cost and quality data silently,
 * while a missing one only splits a row.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'glm-latest': 'glm-5.3',
};

/** The suffix that marks a model id as a moving pointer rather than a pinned version. */
const MOVING_TAG_SUFFIX = '-latest';

/**
 * Cap on how many routing prefixes are peeled from one id.
 *
 * Stripping terminates on its own — every peel returns a strictly shorter string — so this is
 * not a termination guard. It bounds fold *depth*: an id with a longer prefix chain than this
 * is left partially stripped and gets its own bucket, which is the safe direction to fail.
 */
const MAX_ROUTING_PREFIXES = 4;

/**
 * The bucket key for a recorded `model=` — the model itself, with routing noise removed.
 *
 * Lowercased, opencode's `~` gateway-alias marker dropped at every peel, then known routing
 * prefixes peeled off, then {@link MODEL_ALIASES} applied so a moving version tag folds onto
 * its declared pin. A value that is *only* routing tokens keeps its identity rather than
 * collapsing into every other such id — that is the length guard in {@link stripRoutingPrefix},
 * not the empty-string fallback below, which is reachable only for an id that was empty or
 * whitespace, or nothing but `~` markers to begin with.
 */
export function canonicalModel(raw: string): string {
  const { lowered, value } = peelRouting(raw);
  if (value === '') return lowered;
  // `Object.hasOwn`, never a bare index: `value` is a `model=` read off a public issue
  // comment, and `MODEL_ALIASES.constructor` resolves through the prototype to a function,
  // which `??` does not treat as absent. That returned a non-string from a `: string`
  // function and crashed every consumer that called a string method on it.
  return Object.hasOwn(MODEL_ALIASES, value) ? MODEL_ALIASES[value] : value;
}

/**
 * The routing chain a `model=` was served through: the prefixes {@link canonicalModel}
 * peels, in the order they appear, joined by `/` — `null` when the id names no provider.
 *
 * This is the other half of #566's AC2: folding `llmgateway/glm-5.3` and
 * `openrouter/~z-ai/glm-latest` into one `glm-5.3` row is only safe to read if which
 * provider served each run survives the fold as a sub-row.
 */
export function providerOf(raw: string): string | null {
  const { chain } = peelRouting(raw);
  return chain.length > 0 ? chain.join('/') : null;
}

/**
 * The one peel pass both {@link canonicalModel} and {@link providerOf} read from: the
 * lowercased input, the id left after every known routing prefix is removed, and the
 * prefixes removed, in order.
 *
 * One loop rather than two copies, because the two answers must agree: a change to peeling
 * that landed in only one of them would put a run's model key and its provider chain out of
 * step, which is precisely the mis-attribution the fold exists to prevent.
 *
 * The alias marker is re-stripped at every peel, not once up front: opencode writes it on
 * the segment it aliases, not on the whole id, so `openrouter/~z-ai/glm-latest` carries the
 * `~` mid-string. Peeling only at the front left `z-ai/` unmatched on the next pass and
 * stranded the id in its own bucket -- the exact split #566's AC2 names.
 */
function peelRouting(raw: string): { lowered: string; value: string; chain: string[] } {
  const lowered = raw.trim().toLowerCase();
  let value = stripAliasMarker(lowered);
  const chain: string[] = [];

  for (let i = 0; i < MAX_ROUTING_PREFIXES; i++) {
    const stripped = stripRoutingPrefix(value);
    if (stripped === null) break;
    chain.push(stripped.prefix);
    value = stripAliasMarker(stripped.rest);
  }

  return { lowered, value, chain };
}

/** Drop opencode's leading gateway-alias marker. */
function stripAliasMarker(value: string): string {
  return value.replace(/^~+/, '');
}

/**
 * One routing prefix off the front of `value`, or null when it does not start with one.
 *
 * `/` is a routing separator anywhere; `-` is only tried on an id that has no `/` left. A
 * hyphen is also the ordinary within-segment separator of a provider slug, so peeling it out
 * of an org-qualified id mangles rather than folds: `zai-org/glm-4.6` (the HuggingFace repo
 * id) and `zai-coding-plan/glm-4.6` (the OpenRouter slug) would become `org/glm-4.6` and
 * `coding-plan/glm-4.6` — keys that are not models and fold with nothing. Restricting `-` to
 * the unqualified tail still folds the form it was added for, `openrouter-kimi-latest`, and
 * `llmgateway/openrouter-kimi-latest` folds in two passes.
 */
function stripRoutingPrefix(value: string): { prefix: string; rest: string } | null {
  const separators = value.includes('/') ? SLASH_ONLY : ROUTING_SEPARATORS;
  for (const prefix of MODEL_ROUTING_PREFIXES) {
    for (const separator of separators) {
      const head = `${prefix}${separator}`;
      // `length >` and not `>=`: a value that is nothing but a prefix keeps its identity.
      if (value.startsWith(head) && value.length > head.length) {
        return { prefix, rest: value.slice(head.length) };
      }
    }
  }
  return null;
}

/** Separators a routing prefix is joined to the model id with. */
const ROUTING_SEPARATORS: readonly string[] = ['/', '-'];

/** The subset tried on an id that still carries a `/` — see {@link stripRoutingPrefix}. */
const SLASH_ONLY: readonly string[] = ['/'];

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
 * Code points a milestone value must never carry into a rendered table cell.
 *
 * C0 and DEL are the obvious ones. C1 (`0x80`–`0x9f`) matters just as much on an 8-bit-clean
 * terminal, where `U+009B` IS the CSI introducer — `\u009b[2K` erases a row exactly like
 * `\u001b[2K` does. The bidi and zero-width ranges are the other half: they leave `.length`
 * unchanged while visually reordering the drawn line, which defeats the column alignment this
 * function exists to guarantee.
 */
function isUnsafeCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

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
    clean += isUnsafeCodePoint(code) ? CONTROL_REPLACEMENT : char;
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
  /**
   * The classifier's `risk=` verdict for this run's ISSUE (see {@link classificationOf}), or
   * null when the issue was never classified. Issue-level: every run of one issue shares it.
   */
  risk_class: string | null;
  /** The classifier's `mode=` verdict for this run's issue (`slot`/`full`), or null. */
  classified_mode: string | null;
  /**
   * True when this run is the classifier's own dispatch and nothing else.
   *
   * A classify run posts one milestone, records no `model=`, and never ships — so counted as
   * a cycle run it reads as an `<unknown>`-model run that failed to deliver, dragging that
   * bucket's rate down by however many issues the classifier has touched. It is a different
   * kind of work, so the model and class tables exclude it and say so.
   */
  classify_only: boolean;
  /** The run's settled `escalated=` count from its last `review` milestone, or null. */
  escalated: number | null;
  /** The run's `ac_met=` from its last `review` milestone, or null. */
  ac_met: number | null;
  /** The run's `ac_total=` from its last `review` milestone, or null. */
  ac_total: number | null;
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
  delivered: number;
  /** Runs whose last milestone was `blocked`, whatever the phase. */
  blocked: number;
  /** Everything else: still in flight, parked awaiting merge, partial, or fenced. */
  unfinished: number;
  /**
   * `delivered / runs`, in [0, 1] — a **floor**, not a rate.
   *
   * Every run is in the denominator, including ones still in flight, parked at
   * `awaiting-merge`, `partial`, or superseded by a takeover fence. A model whose runs are
   * mid-flight therefore reads low until they land, and a fenced generation counts against
   * the same model whose successor delivered the work. Compare buckets over a closed window,
   * or read `unfinished` alongside this.
   */
  delivery_rate: number;
  /** Runs of this model that reported `escalated=` at all — the rate's denominator. */
  escalation_runs: number;
  /** Total findings this model's runs handed back to a human, summed over those runs. */
  escalations: number;
  /**
   * `escalations / escalation_runs`, or null when no run of this model reached review.
   *
   * A **mean, not a rate** — unbounded above, unlike every `*_rate` on this interface, which
   * is a fraction in [0, 1] rendered as a percentage. Named for what it is so the next reader
   * does not format it with `formatRateCell` and print `10%` for one escalation per ten runs.
   *
   * Null rather than `0` on purpose: a model whose runs all blocked before review has not
   * demonstrated a zero escalation rate, it has demonstrated nothing, and the two must not
   * render identically in the table an operator routes a tier from.
   */
  escalations_per_run: number | null;
  /**
   * Runs of this model whose review reported an `ac_total=` greater than zero **and** a
   * readable `ac_met=` — a run that judged criteria without reporting how many were met
   * contributes nothing, because its not-met count is unknowable.
   */
  conformance_runs: number;
  /** Acceptance criteria those runs were judged against, summed. */
  conformance_criteria: number;
  /** Of those criteria, the ones blind conformance scored NOT met. */
  conformance_not_met: number;
  /**
   * `conformance_not_met / conformance_criteria`, or null when no criteria were judged.
   *
   * Weighted by criteria rather than by run, so a 6-AC issue counts for six times a 1-AC
   * one — the question is how often this model leaves a requirement unmet, not how often it
   * happens to have a bad day.
   */
  conformance_not_met_rate: number | null;
}

/**
 * One `model × class` cell — the axis AC3 of `imboard-ai/ai-dossier#528` asks for.
 *
 * The per-model table answers "which models finish the work"; it cannot answer "which tiers
 * are safe for WHICH CLASSES", because a model's runs over trivial docs issues and over
 * high-risk protocol changes land in one row and average each other out. Splitting the same
 * bucket contract by the classifier's own `risk=` verdict is what makes a tier→class routing
 * recommendation evidence-backed rather than a guess.
 *
 * Mirrors {@link ModelAggregate}'s counters and reuses {@link isCompleted}, so a class row can
 * never disagree with the model row it sums into about what "delivered" means. It deliberately
 * omits `escalations_per_run`: splitting an already-thin corpus by class leaves most cells at
 * n ≤ 2, where a mean reads like a measurement and is not one. The raw count is reported
 * instead, with `escalation_runs` as the "was this measured at all" denominator.
 */
export interface ClassAggregate {
  /** Canonical bucket key — see {@link canonicalModel}. */
  model: string;
  /** The issue's `risk=` verdict, or {@link UNCLASSIFIED_CLASS}. */
  risk_class: string;
  /** Cycle runs in this cell — classify dispatches are excluded, as in {@link ModelAggregate}. */
  runs: number;
  /** Runs whose last milestone was a delivery phase at `done` — see {@link DELIVERED_PHASES}. */
  delivered: number;
  /** Runs whose last milestone was `blocked`, whatever the phase. */
  blocked: number;
  /** Everything else: in flight, parked awaiting merge, partial, or fenced. */
  unfinished: number;
  /** `delivered / runs` — the same floor, with the same caveats, as {@link ModelAggregate}. */
  delivery_rate: number;
  /** Runs in this cell that reported `escalated=` — zero means "never measured", not "zero". */
  escalation_runs: number;
  /** Findings handed back to a human, summed over those runs. A total, never a mean. */
  escalations: number;
  /** Runs whose review reported a usable `ac_total=`/`ac_met=` pair. */
  conformance_runs: number;
  /** Acceptance criteria those runs were judged against, summed. */
  conformance_criteria: number;
  /** Of those criteria, the ones blind conformance scored NOT met. */
  conformance_not_met: number;
}

/**
 * The cross-run rollups: per-phase spread, whole-run totals by model, and those totals
 * split again by the classifier's risk verdict.
 */
export interface StatsAggregates {
  phases: PhaseAggregate[];
  models: ModelAggregate[];
  classes: ClassAggregate[];
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
  classification: { risk: string | null; mode: string | null },
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
  const review = lastReviewOf(milestones);
  // Dropping a malformed counter silently would break the module's contract exactly where
  // the numbers feed a tier-routing decision: the run vanishes from the denominator with no
  // trace. Warn once per unreadable key, naming the value that could not be read.
  for (const key of REVIEW_COUNTER_KEYS) {
    const raw = review?.keys[key];
    if (raw !== undefined && countKey(review, key) === null) {
      warn(
        `${where}: review milestone has ${key}='${renderValue(raw)}' — expected a non-negative integer of at most ${MAX_COUNT}, so this run is left out of the ${key === 'escalated' ? 'escalation' : 'conformance'} figures`
      );
    }
  }
  const acMet = countKey(review, 'ac_met');
  const acTotal = countKey(review, 'ac_total');
  if (acMet !== null && acTotal !== null && acMet > acTotal) {
    warn(
      `${where}: review milestone reports ac_met=${acMet} above ac_total=${acTotal} — counted as 0 criteria not met, which is the floor, not a measurement`
    );
  }
  return {
    issue,
    run,
    model: modelOf(milestones),
    risk_class: classification.risk,
    classified_mode: classification.mode,
    classify_only: milestones.every((m) => m.phase === CLASSIFY_PHASE),
    escalated: countKey(review, 'escalated'),
    ac_met: acMet,
    ac_total: acTotal,
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

/**
 * The classifier's verdict for an issue — the class axis's key.
 *
 * An issue-level attribute, not a run-level one, and that distinction is the whole reason
 * this function takes the trail rather than a run's milestones. The classifier posts its
 * verdict under its **own** `run=` (`r-540-edcf` classifies what `r-540-…` then implements),
 * so a per-run lookup would find `risk=` on the classify run and nothing on the cycle run
 * that actually did the work — the one run the class axis exists to bucket.
 *
 * Same precedence shape as {@link modelOf}: the `classify` milestone is authoritative, and
 * any other milestone carrying the key is a fallback rather than reporting a trail that
 * plainly states its class as unclassified.
 */
function classificationOf(milestones: ParsedMilestone[]): {
  risk: string | null;
  mode: string | null;
} {
  const hasRisk = (m: ParsedMilestone) => riskOf(m) !== null;
  const classify = milestones.filter((m) => m.phase === CLASSIFY_PHASE && hasRisk(m)).at(-1);
  const source = classify ?? milestones.filter(hasRisk).at(-1);
  return { risk: source === undefined ? null : riskOf(source), mode: modeOf(source) };
}

/**
 * A milestone's `risk=`, accepted only if it is one of the classifier's own levels.
 *
 * `parseMilestone` is tolerant by design and {@link ./runstate!KEY_VALUE_RULES} runs on the
 * WRITE path, so a value reaching this reader is whatever someone typed into a comment.
 * Unvalidated it becomes a bucket key: `risk=CRITICAL` invents a row in the table an
 * operator routes tiers from, and `risk=<unclassified>` forges the sentinel. Values are
 * lowercased first so `LOW` folds onto `low` instead of splitting the row — the same
 * canonicalisation {@link canonicalModel} applies for the same reason.
 */
function riskOf(milestone: ParsedMilestone): string | null {
  const value = milestone.keys.risk?.trim().toLowerCase();
  return value !== undefined && (RISK_LEVELS as readonly string[]).includes(value) ? value : null;
}

/** The same closed-set treatment for `mode=`, which `--json` exposes as `classified_mode`. */
function modeOf(milestone: ParsedMilestone | undefined): string | null {
  const value = milestone?.keys.mode?.trim().toLowerCase();
  return value !== undefined && (CLASSIFY_MODES as readonly string[]).includes(value)
    ? value
    : null;
}

/**
 * A milestone key read as a non-negative count, or null when it is absent or unreadable.
 *
 * Null and zero mean different things here and must not collapse: `escalated=0` is a run
 * that reviewed and escalated nothing, while a missing key is a run that never reported.
 * Averaging the second as a zero would silently reward runs that skipped review.
 */
function countKey(milestone: ParsedMilestone | undefined, key: string): number | null {
  const raw = milestone?.keys[key];
  // `Number()` is not a grammar: it reads '' as 0 (turning "never reported" into a measured
  // zero, the exact collapse this function exists to prevent), and accepts '0x1f', '1e3',
  // '+7' and ' 12 '. The protocol's own count grammar is the gate.
  if (raw === undefined || !NON_NEGATIVE_INT_RE.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_COUNT ? value : null;
}

/**
 * Upper bound on a milestone count, above which the value is treated as unreadable.
 *
 * `NON_NEGATIVE_INT_RE` admits any number of digits, and a 21-digit `ac_total=` would
 * silently make every sum it feeds lossy past 2^53 and render as `0/1e+21`. No real review
 * judges ten thousand criteria; a value that claims to is data corruption, not a measurement.
 */
const MAX_COUNT = 10_000;

/** The review counters this module reads — listed once so the warning loop cannot drift. */
const REVIEW_COUNTER_KEYS = ['escalated', 'ac_met', 'ac_total'] as const;

/**
 * The run's last `review` milestone — the one whose counters are current.
 *
 * Review can post twice on one run (`partial`, then `done` after the pending agents finish),
 * and only the later comment carries the settled `escalated=`/`ac_met=` figures.
 *
 * `batch-review` counts too: it posts the SAME keys on a batch anchor, and {@link isCompleted}
 * already scores a delivered anchor via {@link DELIVERED_PHASES}. Reading only `review` would
 * put every batch anchor in the model table as a delivered run whose conformance was never
 * checked — and make this module disagree with `scripts/model-scorecard.mjs`, which reads both
 * phases, about the same trail.
 */
function lastReviewOf(milestones: ParsedMilestone[]): ParsedMilestone | undefined {
  return milestones
    .filter((m) => m.phase === REVIEW_PHASE || m.phase === BATCH_REVIEW_PHASE)
    .at(-1);
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
export const DELIVERED_PHASES: readonly string[] = [
  SHIP_PHASE,
  REPORT_PHASE,
  BATCH_SHIP_PHASE,
  BATCH_REPORT_PHASE,
];

/** True when the run's last milestone says the work was delivered, not merely stopped. */
function isCompleted(run: RunStats): boolean {
  return run.last_status === DONE && DELIVERED_PHASES.includes(run.last_phase);
}

/**
 * The runs the model and class tables are built from.
 *
 * A classify run is the classifier's own dispatch — one milestone, no `model=`, no ship — so
 * it is not a cycle run and counting it as one would report the classifier's every verdict as
 * an `<unknown>`-model run that failed to deliver.
 */
function cycleRuns(runs: RunStats[]): RunStats[] {
  return runs.filter((run) => !run.classify_only);
}

/** The counters both tables share, accumulated the same way so their rows always agree. */
interface OutcomeCounters {
  runs: number;
  delivered: number;
  blocked: number;
  escalationRuns: number;
  escalations: number;
  conformanceRuns: number;
  conformanceCriteria: number;
  conformanceNotMet: number;
}

function emptyCounters(): OutcomeCounters {
  return {
    runs: 0,
    delivered: 0,
    blocked: 0,
    escalationRuns: 0,
    escalations: 0,
    conformanceRuns: 0,
    conformanceCriteria: 0,
    conformanceNotMet: 0,
  };
}

function countRun(counters: OutcomeCounters, run: RunStats): void {
  counters.runs += 1;
  if (isCompleted(run)) counters.delivered += 1;
  else if (run.last_status === BLOCKED) counters.blocked += 1;

  if (run.escalated !== null) {
    counters.escalationRuns += 1;
    counters.escalations += run.escalated;
  }
  // `ac_total=0` is a review that judged nothing, not a run with a perfect record — it
  // contributes no criteria and must not enter the denominator.
  if (run.ac_total !== null && run.ac_total > 0 && run.ac_met !== null) {
    counters.conformanceRuns += 1;
    counters.conformanceCriteria += run.ac_total;
    // Clamped: a malformed trail claiming more met than total would otherwise subtract
    // from the not-met total and understate every bucket it lands in.
    counters.conformanceNotMet += Math.max(0, run.ac_total - run.ac_met);
  }
}

/** Whole-run totals and outcomes bucketed by `model=`, so runs become comparable across models. */
function aggregateModels(runs: RunStats[]): ModelAggregate[] {
  interface Bucket extends OutcomeCounters {
    totals: number[];
    aliases: Set<string>;
  }
  const buckets = new Map<string, Bucket>();

  for (const run of cycleRuns(runs)) {
    const key = run.model === null ? UNKNOWN_MODEL : canonicalModel(run.model);
    const bucket = buckets.get(key) ?? {
      ...emptyCounters(),
      totals: [],
      aliases: new Set<string>(),
    };
    countRun(bucket, run);
    // Only a spelling someone actually recorded is an alias. The unknown bucket's runs
    // recorded nothing, so inventing `<unknown>` there would put a value in `aliases` that
    // appears in no trail — and make a run that literally recorded `model=unknown`
    // indistinguishable from one with no `model=` at all.
    if (run.model !== null) bucket.aliases.add(run.model);
    if (run.total_seconds !== null) bucket.totals.push(run.total_seconds);
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
        delivered: bucket.delivered,
        blocked: bucket.blocked,
        unfinished: bucket.runs - bucket.delivered - bucket.blocked,
        delivery_rate: bucket.delivered / bucket.runs,
        escalation_runs: bucket.escalationRuns,
        escalations: bucket.escalations,
        escalations_per_run:
          bucket.escalationRuns > 0 ? bucket.escalations / bucket.escalationRuns : null,
        conformance_runs: bucket.conformanceRuns,
        conformance_criteria: bucket.conformanceCriteria,
        conformance_not_met: bucket.conformanceNotMet,
        conformance_not_met_rate:
          bucket.conformanceCriteria > 0
            ? bucket.conformanceNotMet / bucket.conformanceCriteria
            : null,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Order the class rows put the operator's question first: worst class, then worst model.
 *
 * `high` before `med` before `low` before unclassified, because "is this model safe for the
 * risky class" is the routing decision; alphabetical order would bury it under `low`.
 *
 * Derived from {@link ./runstate!RISK_LEVELS} rather than restated, so a fourth level added to
 * the protocol sorts into its severity position here instead of silently into the unclassified
 * tail with no test failing.
 */
const CLASS_ORDER: readonly string[] = [...RISK_LEVELS].reverse();

/**
 * Separator for the `model × class` composite key.
 *
 * NUL cannot survive {@link canonicalModel} or {@link riskOf}, so `glm x/low` and `glm/x` +
 * `low` cannot collide on one key the way a space separator lets them. Written as an escape
 * on purpose: a literal NUL byte in the source is invisible in a diff and makes the whole
 * file binary to `grep`/`rg` — which is how this was found.
 */
const CLASS_KEY_SEP = '\u0000';

function byClassOrder(a: ClassAggregate, b: ClassAggregate): number {
  const ai = CLASS_ORDER.indexOf(a.risk_class);
  const bi = CLASS_ORDER.indexOf(b.risk_class);
  if (ai !== bi) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  if (a.risk_class !== b.risk_class) return a.risk_class.localeCompare(b.risk_class);
  return a.model.localeCompare(b.model);
}

/**
 * The same whole-run outcomes, split again by the issue's classifier verdict (AC3).
 *
 * Keyed on the canonical model so PR #546's alias fold is not undone here — a class table
 * that re-split `glm-5.3` from `llmgateway/glm-5.3` would reintroduce the exact defect the
 * model table was fixed for, one axis over.
 */
function aggregateClasses(runs: RunStats[]): ClassAggregate[] {
  const buckets = new Map<string, OutcomeCounters & { model: string; risk_class: string }>();

  for (const run of cycleRuns(runs)) {
    const model = run.model === null ? UNKNOWN_MODEL : canonicalModel(run.model);
    const risk_class = run.risk_class ?? UNCLASSIFIED_CLASS;
    const key = `${model}${CLASS_KEY_SEP}${risk_class}`;
    const bucket = buckets.get(key) ?? { ...emptyCounters(), model, risk_class };
    countRun(bucket, run);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      model: bucket.model,
      risk_class: bucket.risk_class,
      runs: bucket.runs,
      delivered: bucket.delivered,
      blocked: bucket.blocked,
      unfinished: bucket.runs - bucket.delivered - bucket.blocked,
      delivery_rate: bucket.delivered / bucket.runs,
      escalation_runs: bucket.escalationRuns,
      escalations: bucket.escalations,
      conformance_runs: bucket.conformanceRuns,
      conformance_criteria: bucket.conformanceCriteria,
      conformance_not_met: bucket.conformanceNotMet,
    }))
    .sort(byClassOrder);
}

/**
 * What the model buckets could not measure, in the module's own `warnings` channel.
 *
 * The per-model table is the one an operator reads to decide which tier to route at which
 * model, and two of its rows lie by omission if nothing says otherwise: a bucket of runs that
 * recorded no model at all still prints a rate, and a model split across buckets because its
 * gateway is not in {@link MODEL_ROUTING_PREFIXES} prints as two plausible-looking rows with
 * no hint that they are one model. Reporting what could not be measured rather than guessing
 * is this module's contract; these are the two places the new columns could break it.
 */
function modelWarnings(models: ModelAggregate[]): string[] {
  const warnings: string[] = [];

  // Only worth saying when there is an attributed bucket beside it: a table that is ALL
  // unknown (a trail predating the `model=` key) invites no per-model comparison to misread,
  // and warning there would fire on most historical trails for nothing.
  const unknown = models.find((m) => m.model === UNKNOWN_MODEL);
  if (unknown && models.length > 1) {
    warnings.push(
      `${unknown.runs} run(s) recorded no model= — their row is bucketed as ${UNKNOWN_MODEL}, and its outcome columns are not attributable to any model`
    );
  }

  // A key that is another key with a leading segment still attached is the signature of a
  // gateway the allowlist does not know: `qwen/qwen3-coder` beside `qwen3-coder`.
  for (const outer of models) {
    for (const inner of models) {
      if (outer === inner || inner.model === UNKNOWN_MODEL) continue;
      if (outer.model.endsWith(`/${inner.model}`) || outer.model.endsWith(`-${inner.model}`)) {
        warnings.push(
          `'${renderValue(outer.model)}' and '${renderValue(inner.model)}' may be the same model split across buckets — add its routing prefix to MODEL_ROUTING_PREFIXES to fold them`
        );
      }
    }
  }

  // A `-latest` tag is a pointer, not a version: it shares a row with the pin it resolves to
  // only once someone declares which pin that is ({@link MODEL_ALIASES}). Undeclared, it
  // silently splits one model's cost and delivery numbers across two plausible rows — the
  // same failure as an unknown gateway prefix, arriving by a different route.
  for (const model of models) {
    if (model.model === UNKNOWN_MODEL || !model.model.endsWith(MOVING_TAG_SUFFIX)) continue;
    warnings.push(
      `'${renderValue(model.model)}' is a moving version tag with no declared pin — its ${model.runs} run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them`
    );
  }

  return warnings;
}

/**
 * What the class table could not measure — the same contract as {@link modelWarnings}.
 *
 * The class axis is only as good as the classifier's coverage of the corpus, and coverage is
 * the one thing a reader cannot see from the rows: an `<unclassified>` row looks like just
 * another class rather than "most of this table has no class at all". Stating the share makes
 * a thin axis obvious instead of letting a two-run `low` row read as a verdict on `low`.
 */
/**
 * The runs excluded from both tables, disclosed rather than quietly dropped.
 *
 * Without this the by-model row counts cannot be reconciled against `runs.length`, and in the
 * all-classify case both tables vanish with no explanation at all — the exclusion is only
 * mentioned in the class table's footnote, which is not printed when there is no class table.
 */
function exclusionWarnings(runs: RunStats[]): string[] {
  const excluded = runs.length - cycleRuns(runs).length;
  if (excluded === 0) return [];
  return [
    `${excluded} of ${runs.length} run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship`,
  ];
}

function classWarnings(classes: ClassAggregate[]): string[] {
  const total = classes.reduce((sum, c) => sum + c.runs, 0);
  if (total === 0) return [];

  const unclassified = classes
    .filter((c) => c.risk_class === UNCLASSIFIED_CLASS)
    .reduce((sum, c) => sum + c.runs, 0);

  // Same rule the unknown-model bucket follows, for the same reason: a table that is ALL
  // unclassified offers no class comparison to misread — it visibly has one row per model —
  // and warning there would fire on almost every historical trail, since the classifier is
  // newer than the corpus. The misreadable case is the MIXED one, where a two-run `low` row
  // sits beside a large unclassified row and looks like a verdict on `low`.
  if (unclassified === 0 || unclassified === total) return [];

  const share = Math.round((unclassified / total) * PERCENT);
  return [
    `${unclassified} of ${total} run(s) (${share}%) carry no classifier risk= verdict — they are bucketed as ${UNCLASSIFIED_CLASS}, so the class rows describe only the classified remainder`,
  ];
}

/** One aggregate row's skew note, or null when every sample was forwards. */
export function skewNote(negativeSamples: number): string | null {
  if (negativeSamples === 0) return null;
  return `${negativeSamples} skewed`;
}

/**
 * Most folded spellings named inline on a model row before the rest become a count.
 *
 * An attacker who can comment on the issue can post arbitrarily many distinct `model=`
 * spellings that all canonicalise to one bucket, so an uncapped list is an unbounded cell —
 * the DoS {@link MAX_CELL_LENGTH} exists to stop, reached by another route.
 */
export const MAX_NAMED_ALIASES = 3;

/**
 * The folded-alias note for a model row, or null when nothing folded.
 *
 * Pure and exported (like {@link skewNote}) so the disclosure guarantee — a merge is always
 * visible, never silent — is testable, rather than living only in a private renderer.
 * Values are milestone-derived and therefore remote: each is passed through
 * {@link renderValue} before it can reach a terminal.
 */
export function modelNote(model: ModelAggregate): string | null {
  const folded = model.aliases.filter((alias) => alias !== model.model);
  if (folded.length === 0) return null;
  const named = folded.slice(0, MAX_NAMED_ALIASES).map(renderValue);
  const rest = folded.length - named.length;
  return `folded: ${named.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
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
    // Read once per ISSUE, before the runs are split: the classifier posts its verdict under
    // its own run= id, so the cycle run that did the work never carries it (see
    // classificationOf) and a per-run lookup would find nothing to bucket on.
    const classification = classificationOf(trail.milestones);
    for (const [run, milestones] of groupByRun(trail.milestones)) {
      if (run === UNKNOWN_RUN) {
        warn(
          `issue ${issueRef(repo, trail.issue)}: ${milestones.length} milestone(s) carry no run= id — grouped together as '${UNKNOWN_RUN}', so their durations may span unrelated runs`
        );
      }
      runs.push(timePhases(repo, trail.issue, run, milestones, classification, warn));
    }
  }

  const phases = aggregatePhases(runs);
  const models = aggregateModels(runs);
  const classes = aggregateClasses(runs);
  for (const phase of phases) {
    if (phase.negative_samples > 0) {
      warn(
        `aggregate for phase '${renderValue(phase.phase)}' includes ${phase.negative_samples} negative sample(s) from clock skew — its median and min are not meaningful`
      );
    }
  }
  for (const line of modelWarnings(models)) warn(line);
  for (const line of exclusionWarnings(runs)) warn(line);
  for (const line of classWarnings(classes)) warn(line);

  return {
    repo,
    issues: trails.map((t) => t.issue),
    runs,
    aggregates: { phases, models, classes },
    issues_without_trail: withoutTrail,
    issues_failed: failed,
    warnings: [...counts.entries()].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line)),
  };
}
