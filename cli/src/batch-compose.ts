/**
 * `ai-dossier batch compose` core (#773, #770 P3 "selection = admission").
 *
 * The batch pipeline used to admit members by keyword AFTER humans/models had already selected
 * them — a hand-picked five-issue set collapsed to one member only after ~425k decision-grade
 * classifier tokens (#770). This module previews admission BEFORE any model spend: it runs the
 * deterministic `classify prescreen` (prescreen:v2, #772) plus the readiness screen
 * batch-issues-preparation Step 1/5 applies, and proposes a composition that honours the
 * scheduler's batch invariants — at most `max_full_review_members` (default 2, #771) `review=full`
 * members, one base branch, `min_members` (default 3) to `max_members` (default 6) — preferring
 * members that share a workspace package so the repo's expensive gate stage runs once for all.
 *
 * Pure and dependency-free (no `gh`, network, fs, or model) — same discipline as `prescreen.ts`.
 * All I/O (fetching issues, dependency states, the sched queue) lives in `commands/batch.ts`.
 */

import { pickHardBlockLabel } from './hard-block-labels';
import {
  floorScanText,
  type PrescreenReason,
  prescreenIssue,
  stripQuotedSpans,
  stripReferenceMaterial,
  TEXT_FLOOR_PATTERNS,
} from './prescreen';

/** Version of the `batch compose --json` contract. Bump on any breaking shape change. */
export const COMPOSE_SCHEMA = 'batch-compose:v1';

/** Default floor below which a composition is reported `under-min` and backfill is proposed (#770 P4). */
export const DEFAULT_MIN_MEMBERS = 3;

/** Default (and hard) member ceiling — batch-issues-preparation Step 5 constraint 3 (≤ 6 members). */
export const DEFAULT_MAX_MEMBERS = 6;

/** Fewer admissible members than this and no batch should form — hand the survivor to full-cycle (#770 P4). */
export const MIN_FORMABLE_MEMBERS = 2;

/** Admission rules: `v2` = prescreen:v2 + #771 review level (today); `legacy` = pre-#770 (any keyword ⇒ full ⇒ excluded). */
export type ComposeRules = 'v2' | 'legacy';

/** Why an issue cannot join a batch. Stable codes — consumers branch on `code`, humans read `message`. */
export type ExclusionCode =
  | 'unreadable'
  | 'closed'
  | 'assigned'
  | 'in-progress'
  | 'hard-block-label'
  | 'batch-anchor'
  | 'in-flight'
  | 'sched-active'
  | 'open-dependency'
  | 'data-mutation'
  | 'not-a-unit'
  | 'prescreen-full'
  | 'legacy-full';

export interface ExclusionReason {
  code: ExclusionCode;
  message: string;
}

/** Everything the core needs about one issue — the command layer fills it from `gh`. */
export interface ComposeIssueInput {
  issue: number;
  /** `pick` = named by the operator via `--issues`; `backlog` = drawn from the backlog query. */
  source: 'pick' | 'backlog';
  /** Set when the issue could not be read at all; everything else is then ignored. */
  error?: string;
  title: string;
  body: string;
  labels: readonly string[];
  /** GitHub `state` (`OPEN` / `CLOSED`). */
  state: string;
  assignees: readonly string[];
  /** plan:v1 predicted files when the issue carries an artifact. */
  predictedFiles?: readonly string[];
  /** Phase of the LATEST runstate milestone on the issue, or null when it has none. */
  latestPhase?: string | null;
  /** Status of the issue's non-terminal sched queue entry, or null when it has none. */
  schedStatus?: string | null;
  /** `Depends on #N` refs resolved OPEN and outside the operator's picks. */
  openDependencies?: readonly number[];
  /** `Depends on #N` refs whose state could not be read — an admission gate fails closed on them. */
  unknownDependencies?: readonly number[];
}

export interface AssessedIssue {
  issue: number;
  source: 'pick' | 'backlog';
  title: string;
  admissible: boolean;
  /** Review depth the member needs (prescreen:v2 / #771 vocabulary). */
  review: 'light' | 'full';
  /** Workspace packages the issue is predicted to touch (plan:v1 files first, else paths named in the body). */
  packages: string[];
  /** Every prescreen finding — the reason a member is `review=full`. */
  prescreen: PrescreenReason[];
  /** Empty when admissible. */
  excluded: ExclusionReason[];
}

// --- data mutation ------------------------------------------------------------------------------

/**
 * Phrases that mark an issue as production data mutation / ops — the one class #770 P1 keeps
 * out of shared PRs ("prod data mutation/ops"): a batch reverts per commit, a data change does
 * not revert with it. Deliberately ACTION phrases, not bare words or places: "backfill" alone is batch
 * vocabulary (this very feature proposes "backfill candidates"), "migration" alone is already a
 * `review=full` text-floor hit, "delete" alone is ordinary code prose, and "production data" /
 * "prod db" name a place an issue merely talks about (an IAM or pentest issue) — measured on the
 * imboard backlog, those place phrases excluded five issues that mutate nothing. Matched against the
 * same change-surface text the prescreen text floor scans (`floorScanText` — reference sections,
 * provenance clauses and quoted spans removed), whole-word, case-insensitive.
 */
export const DATA_MUTATION_PHRASES: readonly string[] = [
  'data migration',
  'migration script',
  'migrate data',
  'migrate existing data',
  'migrate existing records',
  'migrate existing documents',
  'data backfill',
  'backfill script',
  'backfill existing',
  'backfill job',
  'backfill production',
  'one-off script',
  'one-time script',
  'bulk delete',
  'bulk update',
  'data cleanup',
  'data repair',
  'data fix',
  'purge script',
  'purge production',
  'modify production data',
  'update production data',
  'delete production data',
  'write to production',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DATA_MUTATION_RES = DATA_MUTATION_PHRASES.map(
  (p) => [p, new RegExp(`\\b${escapeRegExp(p).replace(/[\s-]+/g, '[\\s-]+')}\\b`, 'i')] as const
);

/** First data-mutation phrase the change-surface text matches, or null. */
export function matchDataMutation(text: string): string | null {
  for (const [phrase, re] of DATA_MUTATION_RES) if (re.test(text)) return phrase;
  return null;
}

// --- not an implementable unit -----------------------------------------------------------------

/**
 * Labels marking an issue as something other than one implementable change — a tracker, a
 * decision, parked or research work (#770 P1: "decisions/epics/trackers" never share a PR;
 * batch-issues-preparation Step 5 "Is it a tracker or a decision?"). The hard-block labels
 * (`epic`, `decomposed`, …) are reported separately as `hard-block-label`.
 */
export const NOT_A_UNIT_LABELS: readonly string[] = [
  'tracker',
  'decision',
  'question',
  'discussion',
  'research',
  'parked',
  'on-hold',
  'wontfix',
  'duplicate',
];

/** Title shapes of the same classes: `[PARKED] …`, `[tracker] …`, `research: …`, `Decision: …`, `RFC: …`. */
const NOT_A_UNIT_TITLE_RE =
  /^\s*(?:\[\s*(?:parked|tracker|epic|decision|research|rfc|discussion|question|on[\s-]?hold)\b[^\]]*\]|(?:tracker|epic|decision|research|rfc|discussion|question)\s*(?:\([^)]*\))?\s*:)/i;

/** A body section headed "Decision needed" / "Decision required" — an options table, not a spec. */
const DECISION_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+decision[ \t]+(?:needed|required)\b/im;

/** Why the issue is not one implementable unit, or null. */
export function notAUnitReason(
  title: string,
  body: string,
  labels: readonly string[]
): string | null {
  const lower = labels.map((l) => l.toLowerCase());
  const label = NOT_A_UNIT_LABELS.find((l) => lower.includes(l));
  if (label !== undefined) return `Carries the '${label}' label.`;
  if (NOT_A_UNIT_TITLE_RE.test(title))
    return 'Title marks it as a tracker/decision/research/parked item.';
  if (DECISION_HEADING_RE.test(body))
    return "Body has a 'Decision needed' section — a decision, not a spec.";
  return null;
}

// --- package inference --------------------------------------------------------------------------

/** Directory names whose CHILD is the workspace package (`packages/sched`, `apps/web`, …). */
const WORKSPACE_PARENTS = new Set(['packages', 'apps', 'libs', 'services', 'plugins', 'modules']);

/**
 * Path-like tokens: at least one `/`, only path characters. Filtered further in
 * {@link isPathToken} so prose like "and/or" or "ci/cd" is not a path.
 */
const PATH_TOKEN_RE = /(?<![\w/.:#@-])(?:\.\/)?((?:[\w.-]+\/)+[\w.-]*)/g;

/** Most packages reported per issue — the body is untrusted, keep the output bounded. */
const MAX_PACKAGES = 8;

function isPathToken(token: string): boolean {
  const segments = token.split('/').filter((s) => s !== '');
  if (segments.length === 0) return false;
  if (segments.some((s) => s === '..' || /^\d+$/.test(s))) return false;
  const last = segments[segments.length - 1];
  // A file (`x.ts`), an explicit directory (`dir/`), or anything under a workspace parent
  // (`packages/sched`). A bare `a/b/c` is NOT enough — prose like "active/disabled/pending"
  // looks exactly like that and produced phantom packages on a real backlog.
  return (
    /\.[A-Za-z0-9]{1,6}$/.test(last) ||
    token.endsWith('/') ||
    segments.slice(0, -1).some((s) => WORKSPACE_PARENTS.has(s))
  );
}

/** The workspace package a repo-relative path belongs to: `…/packages/<x>/…` → `packages/<x>`, else its first segment. */
export function workspaceOf(path: string): string | null {
  const segments = path
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s !== '');
  for (let i = 0; i < segments.length - 1; i++) {
    if (WORKSPACE_PARENTS.has(segments[i])) return `${segments[i]}/${segments[i + 1]}`;
  }
  // A lone file at the repo root (`package.json`) belongs to no workspace.
  return segments.length >= 2 ? segments[0] : null;
}

/**
 * Workspace packages an issue is predicted to touch. A plan:v1 artifact's predicted files win
 * (they are the plan's own claim); otherwise path tokens named in the change-surface body
 * (reference sections and provenance removed, but quoted spans KEPT — backticked paths are the
 * main signal here). Sorted, de-duplicated, capped at {@link MAX_PACKAGES}.
 */
export function inferPackages(body: string, predictedFiles?: readonly string[]): string[] {
  const paths =
    predictedFiles !== undefined && predictedFiles.length > 0
      ? [...predictedFiles]
      : [...stripReferenceMaterial(body).matchAll(PATH_TOKEN_RE)]
          // A sentence-ending period is punctuation, not part of the path.
          .map((m) => m[1].replace(/\.+$/, ''))
          .filter(isPathToken);
  const out = new Set<string>();
  for (const p of paths) {
    const ws = workspaceOf(p);
    if (ws !== null) out.add(ws);
  }
  return [...out].sort().slice(0, MAX_PACKAGES);
}

// --- assessment ---------------------------------------------------------------------------------

/** Labels that mark an issue as already claimed by a running cycle. */
const IN_PROGRESS_LABEL = 'in-progress';

/** A batch ANCHOR (batch-epic) — the batch's own tracking issue, never a member. */
const BATCH_ANCHOR_LABEL = 'batch-epic';

/** The one runstate phase that does NOT mean a cycle is in flight (classifier record). */
const CLASSIFY_PHASE = 'classify';

/**
 * Deterministic admission for one issue: readiness (batch-issues-preparation Step 1/5) +
 * prescreen:v2 (#772) + data-mutation. Records EVERY exclusion reason, not just the first, so an
 * operator sees the whole picture of why a pick cannot join.
 */
export function assessIssue(input: ComposeIssueInput, rules: ComposeRules = 'v2'): AssessedIssue {
  const base = { issue: input.issue, source: input.source, title: input.title };
  if (input.error !== undefined) {
    return {
      ...base,
      admissible: false,
      review: 'full',
      packages: [],
      prescreen: [],
      excluded: [{ code: 'unreadable', message: input.error }],
    };
  }

  const excluded: ExclusionReason[] = [];
  const labels = input.labels.map((l) => l.toLowerCase());

  if (input.state.toUpperCase() !== 'OPEN') {
    excluded.push({ code: 'closed', message: `Issue is ${input.state || 'not open'}.` });
  }
  if (input.assignees.length > 0) {
    excluded.push({
      code: 'assigned',
      message: `Assigned to ${input.assignees.map((a) => `@${a}`).join(', ')}.`,
    });
  }
  if (labels.includes(IN_PROGRESS_LABEL)) {
    excluded.push({ code: 'in-progress', message: `Carries the '${IN_PROGRESS_LABEL}' label.` });
  }
  if (labels.includes(BATCH_ANCHOR_LABEL)) {
    excluded.push({
      code: 'batch-anchor',
      message: `Carries '${BATCH_ANCHOR_LABEL}' — a batch anchor, not an implementable unit.`,
    });
  }
  if (input.latestPhase && input.latestPhase !== CLASSIFY_PHASE) {
    excluded.push({
      code: 'in-flight',
      message: `Latest runstate milestone is phase '${input.latestPhase}' — a cycle is in flight or parked.`,
    });
  }
  if (input.schedStatus) {
    excluded.push({
      code: 'sched-active',
      message: `Already an active scheduler queue entry (status '${input.schedStatus}').`,
    });
  }

  const verdict = prescreenIssue({
    title: input.title,
    body: input.body,
    labels: input.labels,
    predictedFiles: input.predictedFiles,
    openDependencies: input.openDependencies,
  });

  const hardBlock = pickHardBlockLabel(input.labels);
  if (hardBlock !== null) {
    excluded.push({
      code: 'hard-block-label',
      message: `Carries hard-block label '${hardBlock}'.`,
    });
  }
  for (const dep of input.openDependencies ?? []) {
    excluded.push({
      code: 'open-dependency',
      message: `Depends on #${dep}, which is open and not among the operator's picks.`,
    });
  }
  for (const dep of input.unknownDependencies ?? []) {
    excluded.push({
      code: 'open-dependency',
      message: `Depends on #${dep}, whose state could not be read — treated as open.`,
    });
  }
  // prescreen:v2 keeps path-floor / >8-files as EXCLUDING checks (#772's schema): a plan:v1
  // artifact that predicts risk-floor paths or a large diff is a deliberate full-cycle case, so
  // only a text-floor hit rides a batch as a review=full member (#770 Option A).
  const floorExclusions = verdict.reasons.filter(
    (r) => r.check === 'path-floor' || r.check === 'file-count'
  );
  if (floorExclusions.length > 0) {
    excluded.push({
      code: 'prescreen-full',
      message: `prescreen:v2 verdict full — ${floorExclusions.map((r) => r.message).join(' ')}`,
    });
  }

  const notUnit = notAUnitReason(input.title, input.body, input.labels);
  if (notUnit !== null) excluded.push({ code: 'not-a-unit', message: notUnit });

  const dataMutation = matchDataMutation(floorScanText(input.title, input.body, input.labels));
  if (dataMutation !== null) {
    excluded.push({
      code: 'data-mutation',
      message: `Change surface mentions '${dataMutation}' — production data mutation/ops never shares a PR.`,
    });
  }

  if (rules === 'legacy') {
    // Pre-#772 prescreen:v1: whole title+body+labels (quoted spans blanked, nothing else),
    // and ANY keyword hit forced mode=full — which batch-issues-preparation never batched.
    const v1Text = stripQuotedSpans(`${input.title}\n${input.body}\n${input.labels.join(' ')}`);
    const hit = TEXT_FLOOR_PATTERNS.map((p) => [p.name, p.match(v1Text)] as const).find(
      ([, kw]) => kw !== null
    );
    if (hit) {
      excluded.push({
        code: 'legacy-full',
        message: `Legacy rules: '${hit[0]}' keyword '${hit[1]}' forced mode=full, and full-mode issues were never batched.`,
      });
    }
  }

  return {
    ...base,
    admissible: excluded.length === 0,
    review: verdict.review,
    packages: inferPackages(input.body, input.predictedFiles),
    prescreen: verdict.reasons,
    excluded,
  };
}

// --- composition --------------------------------------------------------------------------------

export interface ComposeOptions {
  rules: ComposeRules;
  baseBranch: string;
  minMembers: number;
  maxMembers: number;
  /** Per-batch `review=full` cap (#771 — `max_full_review_members`, default 2). */
  maxFullReview: number;
  /** Whether operator picks were given (`--issues`). Picks mode fills to `minMembers`; backlog-only mode fills to `maxMembers`. */
  picksMode: boolean;
}

export interface ComposedMember {
  issue: number;
  title: string;
  review: 'light' | 'full';
  source: 'pick' | 'backfill' | 'backlog';
  packages: string[];
  /** Why `review=full` (prescreen findings); empty for `light`. */
  review_reasons: string[];
}

/** An admissible issue left out of the composition, and why. */
export interface HeldIssue {
  issue: number;
  title: string;
  review: 'light' | 'full';
  source: 'pick' | 'backlog';
  packages: string[];
  reason: 'review-full-cap' | 'max-members';
}

export interface BackfillCandidate {
  rank: number;
  issue: number;
  title: string;
  review: 'light' | 'full';
  packages: string[];
  /** Packages it shares with the operator's admitted picks — the ranking's first key. */
  shared_packages: string[];
  /** Whether the proposed composition takes it. */
  selected: boolean;
}

export type ComposeStatus = 'ok' | 'under-min' | 'no-batch';

export interface CompositionResult {
  status: ComposeStatus;
  members: ComposedMember[];
  held: HeldIssue[];
  backfill: BackfillCandidate[];
  /** Packages touched by ≥ 2 members — the expensive gate stage these members amortize. */
  shared_packages: string[];
  /** One line saying what to do with this result. */
  recommendation: string;
}

interface Ranked {
  a: AssessedIssue;
  shared: string[];
}

/**
 * Order candidates against the current member set: sharing a package first, then `light` before
 * `full` (a full slot is scarce — the cap), then more shared packages first, then issue number ascending
 * (older first). With no members yet, "shared" means shared with the other candidates, so the
 * seed comes from the largest package cluster.
 */
function rank(candidates: AssessedIssue[], members: AssessedIssue[]): Ranked[] {
  const memberPkgs = new Set(members.flatMap((m) => m.packages));
  const ranked = candidates.map((a) => {
    let shared: string[];
    if (members.length > 0) {
      shared = a.packages.filter((p) => memberPkgs.has(p));
    } else {
      shared = a.packages.filter((p) =>
        candidates.some((o) => o.issue !== a.issue && o.packages.includes(p))
      );
    }
    return { a, shared };
  });
  ranked.sort((x, y) => {
    const sx = x.shared.length > 0 ? 1 : 0;
    const sy = y.shared.length > 0 ? 1 : 0;
    if (sx !== sy) return sy - sx;
    if (x.a.review !== y.a.review) return x.a.review === 'light' ? -1 : 1;
    if (x.shared.length !== y.shared.length) return y.shared.length - x.shared.length;
    return x.a.issue - y.a.issue;
  });
  return ranked;
}

/**
 * Greedy, deterministic fill: repeatedly take the best-ranked candidate (re-ranked after each
 * pick, so package affinity follows the growing member set) until `target` members, skipping a
 * `review=full` candidate once the cap is reached. Returns what it took and what it skipped.
 */
function fill(
  pool: AssessedIssue[],
  members: AssessedIssue[],
  target: number,
  maxFullReview: number
): { taken: AssessedIssue[]; capped: AssessedIssue[] } {
  const taken: AssessedIssue[] = [];
  const capped: AssessedIssue[] = [];
  let remaining = [...pool];
  let fullCount = members.filter((m) => m.review === 'full').length;
  while (members.length + taken.length < target && remaining.length > 0) {
    const next = rank(remaining, [...members, ...taken]).find(
      (r) => r.a.review === 'light' || fullCount < maxFullReview
    );
    if (next === undefined) break;
    taken.push(next.a);
    if (next.a.review === 'full') fullCount++;
    remaining = remaining.filter((c) => c.issue !== next.a.issue);
  }
  for (const c of remaining) {
    if (c.review === 'full' && fullCount >= maxFullReview) capped.push(c);
  }
  return { taken, capped };
}

function toMember(a: AssessedIssue, source: ComposedMember['source']): ComposedMember {
  return {
    issue: a.issue,
    title: a.title,
    review: a.review,
    source,
    packages: a.packages,
    review_reasons: a.review === 'full' ? a.prescreen.map((r) => r.message) : [],
  };
}

/**
 * Propose a composition from assessed issues. Picks first (they are the operator's intent) —
 * all admissible picks join, bounded by `maxMembers` and the `review=full` cap; then, while the
 * set is below its target (`minMembers` with picks, `maxMembers` from the backlog alone), backfill
 * from admissible backlog issues. Member order: picks, then backfill, each in selection order.
 */
export function composeBatch(assessed: AssessedIssue[], opts: ComposeOptions): CompositionResult {
  const admissible = assessed.filter((a) => a.admissible);
  const picks = admissible.filter((a) => a.source === 'pick');
  const backlog = admissible.filter((a) => a.source === 'backlog');

  const held: HeldIssue[] = [];
  const hold = (a: AssessedIssue, reason: HeldIssue['reason']) =>
    held.push({
      issue: a.issue,
      title: a.title,
      review: a.review,
      source: a.source,
      packages: a.packages,
      reason,
    });

  // 1. Operator picks — every admissible pick, up to the caps.
  const pickFill = fill(picks, [], opts.maxMembers, opts.maxFullReview);
  const members: ComposedMember[] = pickFill.taken.map((a) => toMember(a, 'pick'));
  const takenPicks = new Set(pickFill.taken.map((a) => a.issue));
  for (const a of picks) {
    if (takenPicks.has(a.issue)) continue;
    hold(a, pickFill.capped.includes(a) ? 'review-full-cap' : 'max-members');
  }

  // 2. Backfill / backlog fill.
  const target = opts.picksMode ? Math.min(opts.minMembers, opts.maxMembers) : opts.maxMembers;
  const backFill = fill(backlog, pickFill.taken, target, opts.maxFullReview);
  for (const a of backFill.taken)
    members.push(toMember(a, opts.picksMode ? 'backfill' : 'backlog'));
  const takenBack = new Set(backFill.taken.map((a) => a.issue));

  // The ranked preview is relative to the admitted picks — what the operator chose.
  const backfill: BackfillCandidate[] = opts.picksMode
    ? rank(backlog, pickFill.taken).map((r, i) => ({
        rank: i + 1,
        issue: r.a.issue,
        title: r.a.title,
        review: r.a.review,
        packages: r.a.packages,
        shared_packages: r.shared,
        selected: takenBack.has(r.a.issue),
      }))
    : [];
  if (!opts.picksMode) {
    for (const a of backlog) {
      if (takenBack.has(a.issue)) continue;
      hold(a, backFill.capped.includes(a) ? 'review-full-cap' : 'max-members');
    }
  }

  const counts = new Map<string, number>();
  for (const m of members) for (const p of m.packages) counts.set(p, (counts.get(p) ?? 0) + 1);
  const shared = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([p]) => p)
    .sort();

  let status: ComposeStatus;
  let recommendation: string;
  if (members.length >= opts.minMembers) {
    status = 'ok';
    recommendation = `Form one batch of ${members.length} on '${opts.baseBranch}' (${members.filter((m) => m.review === 'full').length} review=full).`;
  } else if (members.length >= MIN_FORMABLE_MEMBERS) {
    status = 'under-min';
    recommendation = `Only ${members.length} admissible member(s), below min_members=${opts.minMembers} — widen the backlog query or accept a small batch.`;
  } else {
    status = 'no-batch';
    recommendation =
      members.length === 1
        ? `Do not form a batch — run #${members[0].issue} as a full-cycle issue.`
        : 'Do not form a batch — nothing admissible.';
  }

  return { status, members, held, backfill, shared_packages: shared, recommendation };
}

/**
 * A pick that depends on ANOTHER pick is admissible only while that pick is: when the depended-on
 * pick is excluded (and still open), the dependent would ship without it. Applied to a fixpoint,
 * so a chain A → B → C collapses when C is excluded. Mutates and returns `assessed`.
 */
export function applyPickDependencies(
  assessed: AssessedIssue[],
  pickDeps: ReadonlyMap<number, readonly number[]>,
  isOpen: (issue: number) => boolean
): AssessedIssue[] {
  const byIssue = new Map(assessed.map((a) => [a.issue, a]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of assessed) {
      if (!a.admissible) continue;
      for (const dep of pickDeps.get(a.issue) ?? []) {
        const d = byIssue.get(dep);
        if (d === undefined || d.admissible || !isOpen(dep)) continue;
        a.excluded.push({
          code: 'open-dependency',
          message: `Depends on #${dep}, a pick that cannot join this batch (${d.excluded.map((e) => e.code).join(', ')}).`,
        });
        a.admissible = false;
        changed = true;
        break;
      }
    }
  }
  return assessed;
}
