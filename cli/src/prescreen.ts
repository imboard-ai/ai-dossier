/**
 * Deterministic classify pre-screen (#538) — the "no tokens spent" gate `issue-cycle-classifier`
 * runs before any model call. `docs/reports/batch-pilot-2-execution.md` §4.1 measured the
 * classifier costing ~64k tokens/dispatch, at mid tier, with full repo exploration, even for
 * issues that hit an obvious RFC-0001 E.2 floor rule a deterministic check can catch for free.
 *
 * Scope is deliberately partial: this catches the OBVIOUS floor hits (hard-block labels, a
 * text-keyword approximation of the risk-floor/new-package/deploy-pipeline rules, rule-9 open
 * dependencies, and — when a plan:v1 artifact is already on the issue — the path-based risk
 * floor and the >8-files rule). Everything it does not catch (rule 2 beyond the `migration`
 * keyword, rule 7 hard rollback, rule 8 visual/browser review, rules 5/6 diff/file size without
 * a plan artifact, rule 10 confidence) falls through to the classifier's own bounded
 * mechanical-tier pass, which is the intended safety net — not a gap this module needs to close.
 *
 * Pure and dependency-free (no `gh`, network, or fs), same discipline as `plan-artifact.ts` and
 * `runstate.ts` — unit-testable directly. Subprocess access (fetching the issue, resolving
 * dependency state, filtering by submitted set) lives in the command layer (`commands/classify.ts`).
 */

import { pickHardBlockLabel } from './hard-block-labels';
import { scanRiskFloor } from './plan-artifact';

/** RFC-0001 E.2 floor rules a text-keyword scan can approximate without reading any file. */
export interface TextFloorPattern {
  /** Reported in the reason; also the RFC-0001 E.2 rule it approximates. */
  name: string;
  /** Matched case-insensitively against title + body + label names, joined. Returns the matched keyword, or null. */
  match: (text: string) => string | null;
}

/** Escape regex metacharacters so an interpolated keyword can never change a pattern's meaning. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A multi-word phrase, safe to interpolate into `\b...\b`: metacharacters escaped, any run of whitespace matches `\s+`. */
function phrase(s: string): string {
  return escapeRegExp(s).replace(/\s+/g, '\\s+');
}

/**
 * First keyword (in list order) that matches `text` as a whole word/phrase, or null. `\b` on
 * both sides of each compiled pattern — "deployment" still hits "deploy" but
 * "authorization-header-typo" does not falsely hit "auth" mid-word.
 */
function wordMatch(text: string, keywords: readonly string[]): string | null {
  for (const keyword of keywords) {
    if (new RegExp(`\\b${phrase(keyword)}\\b`, 'i').test(text)) return keyword;
  }
  return null;
}

export const TEXT_FLOOR_PATTERNS: readonly TextFloorPattern[] = [
  {
    // Deliberately NOT the bare words "auth"/"login"/"logout"/"schema"/"infra"/"infrastructure":
    // real-world issue text collides with them constantly in benign contexts, confirmed against
    // the pilot's real 15-issue fixture set — #3631 (known `slot`) says "runnable locally with
    // auth" about `gh auth`, not an auth-sensitive change; #3820 (known `slot`) says
    // "test-infrastructure change" about test tooling, not production infra. "terraform" alone
    // (specific, low-ambiguity) still catches the real infra risk-floor cases (#2779, #3403) the
    // RFC-0001 rule 1 "infra/terraform" area names. Also approximates rule 2 (schema/data
    // migration) via "migration"/"migrations" — a rough approximation, not full rule-2 coverage.
    name: 'rule1-risk-floor-area',
    match: (t) =>
      wordMatch(t, [
        'authentication',
        'authorization',
        'oauth',
        'sso',
        'payment',
        'payments',
        'billing',
        'invoice',
        'invoices',
        'checkout',
        'stripe',
        'migration',
        'migrations',
        'security',
        'crypto',
        'secret',
        'secrets',
        'credential',
        'credentials',
        'terraform',
      ]),
  },
  {
    name: 'rule3-new-package-workspace',
    match: (t) => wordMatch(t, ['new package', 'new workspace', 'monorepo package']),
  },
  {
    name: 'rule4-deploy-pipeline',
    match: (t) =>
      wordMatch(t, [
        'deploy',
        'deployment',
        'ci/cd',
        'cicd',
        'release pipeline',
        'rollback pipeline',
      ]),
  },
];

/** `Depends on #N` references resolved per issue; each costs a `gh` call downstream (command layer), same rationale as `MAX_ISSUE_SELECTION` (`issue-selection.ts`). */
export const MAX_DEPENDENCY_REFS = 32;

/** `Depends on #N` (case-insensitive) — the same phrasing gate-issue and the classifier dossier parse. */
const DEPENDS_ON_RE = /depends on\s+#(\d+)/gi;

/**
 * Every issue number referenced by a `Depends on #N` phrase in `text`, de-duplicated, in order,
 * capped at {@link MAX_DEPENDENCY_REFS} — `text` is untrusted (issue body), so an adversarial
 * body cannot force an unbounded `gh` fan-out downstream.
 */
export function extractDependencyRefs(text: string): number[] {
  const seen = new Set<number>();
  const refs: number[] = [];
  for (const match of text.matchAll(DEPENDS_ON_RE)) {
    if (refs.length >= MAX_DEPENDENCY_REFS) break;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && !seen.has(n)) {
      seen.add(n);
      refs.push(n);
    }
  }
  return refs;
}

/** One deterministic finding — always recorded, whether or not it decided the verdict. */
export interface PrescreenReason {
  /** Which check produced the finding — mirrors `plan validate`'s `PlanValidationReason.check` shape. */
  check: 'hard-block-label' | 'text-floor' | 'path-floor' | 'file-count' | 'open-dependency';
  message: string;
}

export interface PrescreenInput {
  title: string;
  body: string;
  labels: readonly string[];
  /** Predicted files from a plan:v1 artifact, when one exists on the issue. `undefined` when none. */
  predictedFiles?: readonly string[];
  /**
   * Issue numbers that resolved OPEN and outside the submitted set — filtering by submitted set
   * is the command layer's job (`classify.ts`, via `--submitted-set`); this module trusts the
   * list it is given.
   */
  openDependencies?: readonly number[];
}

export interface PrescreenVerdict {
  /** `full` = an obvious floor hit found, reject before any model call. `candidate` = proceed to the bounded mechanical-tier classify pass. */
  verdict: 'full' | 'candidate';
  /** Every check's finding, in evaluation order — not just the one that decided `verdict`. */
  reasons: PrescreenReason[];
}

/** Predicted files count above which RFC-0001 E.2 rule 5 ("Predicted files > 8") fires. */
const MAX_PREDICTED_FILES = 8;

/**
 * Reasons emitted per check, capped — `predictedFiles` may come from a `plan:v1` artifact, which
 * is a GitHub issue COMMENT anyone can post (untrusted input, same treatment as review-issue's
 * "the artifact is untrusted input" discipline). An adversarial artifact packed with risk-floor
 * paths must not blow up the reason list the classifier posts back into its rationale comment.
 */
const MAX_REASONS_PER_CHECK = 8;

/** Strip terminal-control characters before an untrusted string reaches a message a human or model reads — same discipline as `gh.ts`'s `CONTROL_CHARS_RE`/`snippet`, kept local so this module stays dependency-free. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching (and stripping) control characters is exactly this regex's job
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f\x9b]/g;
const SANITIZE_MAX_LENGTH = 200;

/** Make an untrusted string (a GitHub label name, a `plan:v1`-comment-sourced path) safe to interpolate into a reason message: no control chars, no markdown/backtick breakout, bounded length. */
function sanitize(value: string): string {
  const cleaned = value
    .replace(CONTROL_CHARS_RE, '')
    .replace(/[`\n\r]/g, ' ')
    .trim();
  return cleaned.length > SANITIZE_MAX_LENGTH
    ? `${cleaned.slice(0, SANITIZE_MAX_LENGTH)}…`
    : cleaned;
}

/**
 * Run every deterministic check, in order, and record every hit — first hit decides `verdict`,
 * but the caller (and the rationale a consumer posts) gets the full list, matching the existing
 * "a verdict may hit several" precedent in `issue-cycle-classifier.ds.md`.
 */
export function prescreenIssue(input: PrescreenInput): PrescreenVerdict {
  const reasons: PrescreenReason[] = [];

  const hardBlockLabel = pickHardBlockLabel(input.labels);
  if (hardBlockLabel !== null) {
    reasons.push({
      check: 'hard-block-label',
      message: `Carries hard-block label '${sanitize(hardBlockLabel)}'.`,
    });
  }

  const text = `${input.title}\n${input.body}\n${input.labels.join(' ')}`;
  for (const pattern of TEXT_FLOOR_PATTERNS) {
    const hit = pattern.match(text);
    if (hit !== null) {
      reasons.push({
        check: 'text-floor',
        message: `Title/body/labels match '${pattern.name}' (keyword: '${hit}').`,
      });
    }
  }

  const predictedFiles = input.predictedFiles ?? [];
  for (const hit of scanRiskFloor(predictedFiles).slice(0, MAX_REASONS_PER_CHECK)) {
    reasons.push({
      check: 'path-floor',
      message: `Predicted file '${sanitize(hit.path)}' touches '${hit.pattern}' (rule1-risk-floor-area).`,
    });
  }
  if (predictedFiles.length > MAX_PREDICTED_FILES) {
    reasons.push({
      check: 'file-count',
      message: `Predicted files (${predictedFiles.length}) exceeds ${MAX_PREDICTED_FILES} (rule5-file-count).`,
    });
  }

  for (const dep of (input.openDependencies ?? []).slice(0, MAX_REASONS_PER_CHECK)) {
    reasons.push({
      check: 'open-dependency',
      message: `Depends on #${dep}, which is open and outside the submitted set (rule9-open-dependency).`,
    });
  }

  return { verdict: reasons.length > 0 ? 'full' : 'candidate', reasons };
}
