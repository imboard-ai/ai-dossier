/**
 * Deterministic READINESS screen for `batch compose` (#802, #770 root cause 3).
 *
 * Admissibility (labels, claims, prescreen) is not readiness: a backlog backfill admitted a
 * portfolio-mode feature, a 27-finding mobile punch list and two acquisition initiatives as
 * `review=light` members because none of them trips a hard-block label. batch-issues-preparation
 * documents the screen an operator applies by eye — a bounded stopping point, acceptance criteria
 * present, not a tracker/epic/feature — and this module applies it without a model call, from the
 * issue's labels, title and body only.
 *
 * Two kinds of signal:
 *  - BLOCKERS (hard): tracker/initiative shape (label, title, checklist count, linked sub-issues,
 *    multi-phase headings), a feature with no acceptance criteria, an empty body. Any blocker ⇒ not ready.
 *  - SCORE (soft): acceptance criteria present, a bounded-type label/title (`bug`, `chore`,
 *    `refactor`, `engineering-ready`, `ready:*`, `fix:`…), named code paths. Below
 *    {@link READINESS_FLOOR} ⇒ not ready ("nothing says this is bounded"); above it, the score
 *    ranks backfill so bounded bugs/chores come before under-specified work.
 *
 * Pure and dependency-free, same discipline as `prescreen.ts`.
 */

/** Minimum score for an issue with no blocker to count as ready. */
export const READINESS_FLOOR = 2;

/** A checklist this long is a tracker/punch list, not one change's acceptance criteria. */
export const TRACKER_CHECKLIST_MIN = 10;

/** Task-list items that are themselves issue links: this many ⇒ a tracker with sub-issues. */
export const TRACKER_SUBISSUE_MIN = 3;

/** Initiative-shaped headings (strategy, metrics, kill criteria…): this many distinct ones ⇒ an initiative, not one change. */
export const INITIATIVE_HEADINGS_MIN = 2;

/** `Phase 1` / `Part 2` / `Milestone 3` headings: this many ⇒ a multi-stage initiative. */
export const INITIATIVE_PHASE_HEADINGS_MIN = 3;

/** GitHub caps an issue body at 65,536 characters; scanning stops there whatever the source (untrusted text, bounded work). */
const MAX_BODY_SCAN = 70_000;

/** Bodies shorter than this (trimmed) carry no spec at all. */
export const MIN_BODY_LENGTH = 40;

/** Labels that mark tracker/initiative-shaped work (`tracker`/`epic` are excluded elsewhere, as `not-a-unit`/`hard-block-label`). */
export const TRACKER_LABELS: readonly string[] = [
  'initiative',
  'umbrella',
  'roadmap',
  'punch-list',
  'tracking',
];

/** Labels that mark an issue as a feature request. */
export const FEATURE_LABELS: readonly string[] = [
  'enhancement',
  'feature',
  'feature-request',
  'new-feature',
];

/** Labels that mark bounded, implementable work. `ready:*` is matched by {@link READY_LABEL_RE}. */
export const BOUNDED_LABELS: readonly string[] = [
  'bug',
  'chore',
  'refactor',
  'engineering-ready',
  'tech-debt',
  'cleanup',
  'good first issue',
];
const READY_LABEL_RE = /^ready[:/]/i;

/**
 * Tracker words in a title. `roadmap`/`initiative`/`workstream` are also ordinary product nouns
 * ("Fix roadmap page rendering", "initiative card overflow"), so they count only as the LEAD word
 * (optionally after a `[tag]`) or as the closing word ("… acquisition initiative").
 */
const TRACKER_TITLE_RE =
  /\b(?:punch[\s-]?list|umbrella|tracking issue|master list|meta[\s-]?issue)\b|^\s*(?:\[[^\]]*\]\s*)?(?:roadmap|initiative|workstream)\b|\b(?:initiative|roadmap)\s*$/i;
/** `audit`/`triage` alone are ordinary words ("fix audit log rotation") — a tracker only with a findings list. */
const FINDINGS_TITLE_RE = /\b(?:audit|triage|sweep|findings)\b/i;
const FINDINGS_LIST_MIN = 5;
const FINDINGS_LIST_MIN_BOUNDED = 25;

const FEATURE_TITLE_RE = /^\s*(?:\[[^\]]*\]\s*)?feat(?:ure)?\b\s*(?:\([^)]*\))?\s*[:!]/i;
const BOUNDED_TITLE_RE =
  /^\s*(?:\[[^\]]*\]\s*)?(?:fix|bug|chore|refactor|test|tests|docs|ci|perf|build|style)\b\s*(?:\([^)]*\))?\s*[:!]/i;

/** An acceptance-criteria/requirements heading or lead-in, as a markdown heading, bold line or `Label:` line. */
const AC_MARKER_RE =
  /^[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*(?:acceptance(?:[ \t]+criteria)?|requirements?|definition[ \t]+of[ \t]+done|done[ \t]+when|success[ \t]+criteria|ac)\b[ \t]*(?:\*\*|__)?[ \t]*:?/im;

/** Any list item's text (task-list boxes stripped): plain `- #12` bullets link sub-issues too. */
const ANY_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm;
const TASK_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+(.*)$/gm;
/** A task item that is (or starts with) an issue reference: `#12`, `org/repo#12`, an issue URL, `[title](…/issues/12)`. */
const ISSUE_LINK_ITEM_RE =
  /^(?:\*\*|__)?(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/issues\/\d+|\[[^\]]*\]\([^)]*\/issues\/\d+\))/;
const INITIATIVE_HEADING_RE =
  /^[ \t]{0,3}#{1,6}[ \t]*(?:strategic[ \t]+framing|kill[ \t]+criteria|success[ \t]+metrics|north[ \t-]?star|okrs?|roadmap|implementation[ \t]+phases|rollout[ \t]+plan|workstreams?)\b/gim;
/** Declared only in a HEADING ("Implementation plan — 4 sub-issues"): prose may just mention them ("closing 2 sub-issues does not update the parent"). */
const DECLARED_SUBISSUES_RE = /^[ \t]{0,3}#{1,6}[^\n]*\bsub-?issues\b/im;
/** GitHub's standard bug template / a repro-shaped report is bounded even without a label. */
const BUG_REPORT_RE =
  /^[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*(?:steps[ \t]+to[ \t]+reproduce|expected[ \t]+(?:behaviou?r|result)|actual[ \t]+(?:behaviou?r|result)|repro(?:duction)?[ \t]+steps)\b/im;
/** A plain checklist earns acceptance-criteria credit only while it is short enough to be one change's AC. */
const AC_CHECKLIST_MAX = 6;
const PHASE_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]*(?:phase|part|milestone|stage|wave)[ \t]*\d+/gim;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/gm;
// Tokenised first (whitespace/quotes/brackets), long tokens skipped, then an anchored bounded test:
// linear in the body. An unbounded `(?:[\w.-]+\/)+` over the raw text is quadratic on `a.a.a.…`.
const CODE_PATH_TOKEN_RE = /^(?:[\w.-]{1,60}\/){1,10}[\w.-]{1,60}\.[A-Za-z0-9]{1,6}$/;
const MAX_PATH_TOKEN = 200;
function namesCodePath(body: string): boolean {
  return body
    .split(/[\s`'"()[\]<>,;]+/)
    .some((t) => t.length <= MAX_PATH_TOKEN && CODE_PATH_TOKEN_RE.test(t.replace(/[.:]+$/, '')));
}

export interface ReadinessAssessment {
  /** Soft score: higher = better specified. Ranks backfill; compared to {@link READINESS_FLOOR}. */
  score: number;
  /** No blocker and score ≥ floor. */
  ready: boolean;
  /** Hard reasons this is not one bounded change — each a human-readable clause. */
  blockers: string[];
  /** Positive signals that raised the score. */
  signals: string[];
}

const countMatches = (re: RegExp, text: string): number => [...text.matchAll(re)].length;

/** Readiness of one issue, from its labels, title and body alone. */
export function assessReadiness(
  title: string,
  rawBody: string,
  labels: readonly string[]
): ReadinessAssessment {
  const body = rawBody.slice(0, MAX_BODY_SCAN);
  const lower = labels.map((l) => l.toLowerCase());
  const blockers: string[] = [];
  const signals: string[] = [];
  let score = 0;

  const taskItems = [...body.matchAll(TASK_ITEM_RE)].map((m) => m[1].trim());
  const checklist = taskItems.length;
  const hasAcMarker = AC_MARKER_RE.test(body);
  const hasAc = hasAcMarker || (checklist >= 1 && checklist <= AC_CHECKLIST_MAX);
  const bugReport = BUG_REPORT_RE.test(body);
  const bounded =
    lower.find((l) => BOUNDED_LABELS.includes(l) || READY_LABEL_RE.test(l)) ??
    (BOUNDED_TITLE_RE.test(title) ? 'title prefix' : undefined);

  // --- blockers -------------------------------------------------------------------------------
  const trackerLabel = TRACKER_LABELS.find((l) => lower.includes(l));
  if (trackerLabel) blockers.push(`carries the '${trackerLabel}' label (tracker/initiative shape)`);
  if (TRACKER_TITLE_RE.test(title)) {
    blockers.push('title names a punch list / umbrella / roadmap / initiative');
  } else if (FINDINGS_TITLE_RE.test(title)) {
    // A conventional bounded-type title/label ("chore: audit remaining call sites") tolerates a
    // short list; only a long one makes it a findings tracker.
    const items = countMatches(LIST_ITEM_RE, body);
    const min = bounded === undefined ? FINDINGS_LIST_MIN : FINDINGS_LIST_MIN_BOUNDED;
    if (items >= min) blockers.push(`audit/triage title with a ${items}-item findings list`);
  }
  // A long checklist under an explicit AC heading on a bounded-type issue is a thorough spec, not a tracker.
  if (checklist >= TRACKER_CHECKLIST_MIN && !(hasAcMarker && bounded !== undefined)) {
    blockers.push(
      `checklist of ${checklist} task items (>= ${TRACKER_CHECKLIST_MIN}) — a tracker, not one change`
    );
  }
  const subIssues = [...body.matchAll(ANY_ITEM_RE)].filter((m) =>
    ISSUE_LINK_ITEM_RE.test(m[1].trim())
  ).length;
  if (subIssues >= TRACKER_SUBISSUE_MIN) {
    blockers.push(`${subIssues} list items link sub-issues — a tracker`);
  }
  const phases = countMatches(PHASE_HEADING_RE, body);
  if (phases >= INITIATIVE_PHASE_HEADINGS_MIN) {
    blockers.push(`${phases} Phase/Part headings — a multi-stage initiative`);
  }
  const initiativeHeadings = new Set(
    [...body.matchAll(INITIATIVE_HEADING_RE)].map((m) =>
      m[0]
        .replace(/[#\s]+/g, ' ')
        .trim()
        .toLowerCase()
    )
  ).size;
  if (initiativeHeadings >= INITIATIVE_HEADINGS_MIN) {
    blockers.push(`${initiativeHeadings} strategy/metrics/roadmap headings — an initiative`);
  }
  if (DECLARED_SUBISSUES_RE.test(body)) blockers.push('declares sub-issues — a tracker');
  const looksLikeFeature =
    bounded === undefined &&
    (lower.some((l) => FEATURE_LABELS.includes(l)) || FEATURE_TITLE_RE.test(title));
  if (looksLikeFeature && !hasAcMarker) {
    blockers.push('feature with no acceptance-criteria section — no bounded stopping point');
  }
  if (body.trim().length < MIN_BODY_LENGTH)
    blockers.push('body is empty or too short to be a spec');

  // --- score ----------------------------------------------------------------------------------
  if (hasAcMarker) {
    score += 3;
    signals.push('acceptance criteria / requirements section');
  } else if (hasAc) {
    score += 2;
    signals.push(`${checklist}-item checklist`);
  }
  if (bounded !== undefined) {
    score += 2;
    signals.push(`bounded type (${bounded})`);
  }
  if (bugReport) {
    score += 2;
    signals.push('bug-report structure (steps / expected / actual)');
  }
  if (namesCodePath(body)) {
    score += 1;
    signals.push('names code paths');
  }

  const ready = blockers.length === 0 && score >= READINESS_FLOOR;
  if (blockers.length === 0 && score < READINESS_FLOOR) {
    blockers.push(
      'no acceptance criteria, bounded-type label/title or named code path — nothing says it is bounded'
    );
  }
  return { score, ready, blockers, signals };
}
