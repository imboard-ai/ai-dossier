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
 * v2 (#772): two outputs. `verdict: full` only for the EXCLUDING checks;
 * any finding — a text-floor keyword hit included — sets `review: full`. A text-floor hit alone
 * is a batchable `candidate` reviewed at full depth (#770 Option A), and the text floor scans the
 * change surface only (`floorScanText`: reference sections/lines and provenance clauses removed).
 * v3 (#805): a plan:v1 risk-floor PATH is review-raising too, exactly like the keyword it makes
 * precise — `verdict: full` was left to hard-block label, open dependency and >8 predicted files.
 * v4 (#818, `PRESCREEN_SCHEMA`): #770 Option A extended to E.2 rule 4 (deploy pipeline — the
 * text floor was already review-raising since v2) and rule 5 (>8 predicted files): both are
 * review-depth questions, not can-share-a-PR questions. `verdict: full` is now left to the
 * hard-block label and a rule-9 open dependency. Rule 8 (visual/browser) stays excluding, but
 * this module never detected it — the classifier's model pass does.
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
  /** Matched case-insensitively against {@link floorScanText} (title + reference-stripped body + label names). Returns the matched keyword, or null. */
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

/**
 * Longest quoted span stripped before keyword matching — a bound so a body full
 * of unbalanced quotes cannot make one span swallow the whole text and blank
 * every keyword. Beyond this the quote is treated as prose and still matched.
 */
const MAX_QUOTED_SPAN = 120;

/**
 * #627: blank out double- and backtick-quoted spans before the text floor runs.
 *
 * A quoted span in an issue is overwhelmingly a UI string, a code identifier, a
 * log line or a filename — something the change REFERS to, not the risk surface
 * it touches. imboard#4036, a `test(e2e)` spec, was forced `full` because it
 * clicks a button labelled "Set up payment": the word lives inside the quotes,
 * the change adds a Playwright file.
 *
 * Deliberately narrow. The obvious broader fix — make every `text-floor` hit
 * advisory and let the model pass decide — was measured against the pilot's
 * 15-issue regression fixture and rejected: SEVEN of the twelve known-`full`
 * issues are rejected by text-floor alone, including genuine risk-floor cases
 * (#3403 `terraform`, #3901 `authorization`). That change would have gutted the
 * deterministic rejection rate the pre-screen exists to provide, and #538's
 * cost saving with it. (#772 later made that move deliberately — but not as
 * "advisory": a text-floor hit still costs no model call and now carries
 * `review: full`, so the genuine risk-floor cases are reviewed at full depth
 * inside a batch instead of being excluded from one. See `PRESCREEN_SCHEMA`.)
 *
 * Stripping quoted spans, by contrast, leaves all 15 fixture verdicts
 * unchanged — the true positives name their risk surface in prose, not in
 * quotes. Same spirit as the vocabulary curation above (dropping bare
 * `auth`/`infra` after they collided with benign text): reduce false positives
 * without touching what the rules genuinely catch.
 *
 * Unbalanced quotes are left alone — the regexes require a closing delimiter on
 * the same line, so a lone `"` blanks nothing.
 */
export function stripQuotedSpans(text: string): string {
  return text
    .replace(new RegExp(`"[^"\\n]{0,${MAX_QUOTED_SPAN}}"`, 'g'), ' ')
    .replace(new RegExp(`\`[^\`\\n]{0,${MAX_QUOTED_SPAN}}\``, 'g'), ' ');
}

/**
 * #772: markdown section headings whose content is reference/provenance material, not the change
 * surface — the whole section (to the next heading of the same or higher level) is dropped before
 * the text floor runs. `Related`/`Context`/`Background` are the sections #772 names explicitly.
 * A denylist on purpose: real issue bodies use arbitrary headings for their scope ("Problem",
 * "What the user sees", "Fix"), so an allowlist of scope/requirements/acceptance headings would
 * silently drop genuine scope. Matched against the WHOLE normalised heading text — "## Background
 * jobs" or "## Origin validation" is scope, not reference material, and stays scanned.
 */
const IGNORED_SECTION_HEADING_RE =
  /^(?:related(?:\s+(?:issues?|prs?|work|links?|tickets?))?|references?|see\s+also|links|context|background|provenance|origin)$/i;

/**
 * ATX markdown heading: 0–3 spaces, 1–6 `#`, then (optionally) whitespace + the heading text and an
 * optional closing `#` run preceded by whitespace (CommonMark).
 */
const HEADING_RE = /^[ \t]{0,3}(#{1,6})(?:[ \t]+([^\n]*))?$/;

/** A fenced code block delimiter — a `#` line inside a fence is a shell comment, not a heading. */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/** Characters trimmed from the end of a heading: whitespace, `:`, emphasis, and a CommonMark closing `#` run. */
const HEADING_TRAILING_CHARS = ' \t\r\n\f\v:*_#';

/** Heading text with leading emoji/emphasis/punctuation and trailing `:`/emphasis/closing `#`s removed. */
function normaliseHeading(text: string): string {
  // Trailing trim by loop, not `/[…]+$/` — that regex is quadratic on a long whitespace run
  // (untrusted issue body; #772 security review).
  const trimmed = text.replace(/^[^\p{L}\p{N}]+/u, '');
  let end = trimmed.length;
  while (end > 0 && HEADING_TRAILING_CHARS.includes(trimmed[end - 1])) end--;
  return trimmed.slice(0, end);
}

/**
 * Line-leading markdown decoration split off before the provenance tests: whitespace, blockquote
 * `>`, list markers (`-`, `*`, `+`, `1.`), task boxes, and emphasis (`**`, `_`). Deliberately
 * conservative — anything it does not strip only makes a provenance line LESS likely to be
 * recognised, which errs toward scanning (the safe direction for a risk floor).
 */
const LINE_DECORATION_RE = /^(?:\s|>|[-*+](?=\s)|\d+[.)](?=\s)|\[[ xX]\]|\*\*|__|\*|_)*/;

/** Compile a phrase list into one alternation (each phrase escaped, whitespace-insensitive). */
function alternation(phrases: readonly string[]): string {
  return phrases.map((p) => phrase(p).replace(/-/g, '[\\s-]?')).join('|');
}

/**
 * #772: a line that STARTS with one of these markers is a pure reference line — "Parent: #770",
 * "Related: #12", "Refs: #1709 …", "See also #10" — and is dropped whole. `related` needs a colon
 * or a ref after it: "Related billing webhooks also fail" is scope prose.
 */
const REFERENCE_LINE_LEADS = [
  'related:',
  'related to #',
  'related #',
  'parent:',
  'refs:',
  'ref:',
  'see also',
  'provenance:',
] as const;
const REFERENCE_LINE_RE = new RegExp(
  `^(?:${REFERENCE_LINE_LEADS.map((l) => phrase(l).replace(/:$/, '\\s*:')).join('|')})`,
  'i'
);

/**
 * #772: provenance phrases — where the issue came from, not what it touches ("Found by the #4103
 * security review", "Follow-up to #4314", "Split from #99"). A clause that OPENS a sentence (line
 * start, or after `.`/`;`/`!`/`?`) with one of these is stripped to the end of its clause (`.`, `;`,
 * `!`, `?`, `,` or a dash followed by whitespace, or end of line) — so "Found by the #4103 review.
 * Rotate the Stripe secrets." keeps the second sentence. Mid-sentence the same words are ordinary
 * prose ("the token leak is found during checkout") and are left alone. "found in"/"reported in"
 * are NOT provenance — they say where the bug is.
 */
const PROVENANCE_LEADS = [
  'found by',
  'found during',
  'discovered by',
  'discovered during',
  'discovered while',
  'surfaced by',
  'surfaced during',
  'spotted by',
  'reported by',
  'filed while',
  'filed from',
  'filed during',
  'follow-up to',
  'follow-up of',
  'split from',
  'split out of',
  'split off from',
  'spun off from',
  'spun out of',
] as const;
const PROVENANCE_CLAUSE_RE = new RegExp(
  `(^|[.;!?]\\s+)(?:${alternation(PROVENANCE_LEADS)})\\b.*?(?=[.;!?,—–](?:\\s|$)|\\s-\\s|$)`,
  'gi'
);

/**
 * A line carrying nothing but references: URLs, bare `#N` / `owner/repo#N` refs, and separators.
 * A markdown link keeps its TEXT ("[Migrate billing tables](…)" is scope) — only the target is
 * erased. Checked by erasing every reference and separator and testing for an empty remainder.
 */
function isLinkOnlyLine(line: string): boolean {
  const remainder = line
    .replace(/\[([^[\]\n]*)\]\([^()\n]*\)/g, ' $1 ')
    .replace(/<?https?:\/\/[^\s>)]+>?/g, ' ')
    .replace(/(?<![\w.-])[\w.-]+\/[\w.-]+#\d+\b/g, ' ')
    .replace(/#\d+\b/g, ' ')
    .replace(/[\s\-*+>•|,;:/()[\]&.–—]|\band\b|\bor\b/gi, '');
  return remainder === '' && /\S/.test(line);
}

/**
 * #772: the issue body with reference material removed — the part a text-floor keyword may
 * legitimately fire on. Removes: sections under an {@link IGNORED_SECTION_HEADING_RE} heading
 * (fence-aware — a `#` comment inside a code block is never a heading), reference lines
 * ({@link REFERENCE_LINE_RE}), link-only lines, and sentence-opening provenance clauses
 * ({@link PROVENANCE_CLAUSE_RE}). Quoted spans are handled separately by {@link stripQuotedSpans}
 * (#627). Pure; line count is preserved (dropped lines become empty) so `stripQuotedSpans`'s
 * same-line bound behaves exactly as before.
 */
export function stripReferenceMaterial(body: string): string {
  const out: string[] = [];
  /** Heading level of the ignored section currently being skipped, or null. */
  let skipLevel: number | null = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(skipLevel === null ? line : '');
      continue;
    }
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel !== null && level > skipLevel) {
        out.push('');
        continue; // a sub-heading inside an ignored section stays ignored
      }
      skipLevel = IGNORED_SECTION_HEADING_RE.test(normaliseHeading(heading[2] ?? ''))
        ? level
        : null;
      out.push(skipLevel === null ? line : '');
      continue;
    }
    if (skipLevel !== null) {
      out.push('');
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const decoration = LINE_DECORATION_RE.exec(line)?.[0] ?? '';
    const content = line.slice(decoration.length);
    if (REFERENCE_LINE_RE.test(content) || isLinkOnlyLine(content)) {
      out.push('');
      continue;
    }
    out.push(decoration + content.replace(PROVENANCE_CLAUSE_RE, '$1 '));
  }
  return out.join('\n');
}

/**
 * The exact text the text floor scans (#772): title + section/provenance-filtered body + label
 * names, with quoted spans blanked (#627). Exported so measurement tooling
 * (`scripts/prescreen-backlog-measure.mjs`) and tests see precisely what the rule sees.
 */
export function floorScanText(title: string, body: string, labels: readonly string[]): string {
  return stripQuotedSpans(`${title}\n${stripReferenceMaterial(body)}\n${labels.join(' ')}`);
}

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

/**
 * Version of the `classify prescreen` JSON contract (#772). v1 (implicit, pre-#772): any finding,
 * text-floor included, meant `verdict: full`. v2: a text-floor hit is `verdict: candidate` +
 * `review: full`; `verdict: full` was reserved for hard-block label, open dependency, plan:v1 path
 * floor and >8 predicted files. v3 (#805): a plan:v1 path-floor hit is also `candidate` +
 * `review: full` — the same risk fact as the keyword, only more precise, so under #770 Option A it
 * raises review instead of excluding. Otherwise batch-prep's own plan:v1 artifact would exclude a
 * member it had just admitted on any compose/prescreen re-run. v4 (#818): >8 predicted files
 * (rule 5) is also `candidate` + `review: full` — a large change is reviewed at full depth inside
 * a batch (still subject to the ≤ 2 `review=full` cap), not excluded from one.
 */
export const PRESCREEN_SCHEMA = 'prescreen:v4';

/**
 * Checks whose hit excludes the issue from batching outright (`verdict: full`). Exported so
 * `batch compose` derives its `prescreen-full` exclusion from this one list instead of a
 * hand-kept copy (#805 had to edit both). Since v4 (#818) only a hard-block label and an open
 * dependency exclude; every floor finding (text, path, file count) raises `review` instead.
 */
export const EXCLUDING_CHECKS: ReadonlySet<PrescreenReason['check']> = new Set([
  'hard-block-label',
  'open-dependency',
]);

/**
 * Checks that excluded under pre-#770 admission and are review-raising today — `batch compose
 * --rules legacy` reproduces the old behaviour from this list (a legacy text-floor keyword is
 * handled separately there, over the unfiltered pre-#772 text).
 */
export const LEGACY_EXCLUDING_CHECKS: ReadonlySet<PrescreenReason['check']> = new Set([
  'path-floor',
  'file-count',
]);

export interface PrescreenVerdict {
  /**
   * `full` = an excluding hit (hard-block label, open dependency) — reject before any model call. `candidate` = proceed to the bounded mechanical-tier classify pass;
   * read `review` for how deeply it must be reviewed.
   */
  verdict: 'full' | 'candidate';
  /**
   * Review depth the issue needs, vocabulary shared with the scheduler's per-member `review`
   * (#771): `full` when ANY floor finding exists — a text-floor keyword (rules 1/3/4), a plan:v1
   * path-floor hit or >8 predicted files on a `candidate` means "batchable, but reviewed at full
   * depth" (#770 Option A, #805, #818), not exclusion. `light` when no check found anything.
   */
  review: 'light' | 'full';
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
 * Run every deterministic check, in order, and record every hit — an excluding hit decides
 * `verdict`, any hit decides `review`, and the caller (and the rationale a consumer posts) gets the full list, matching the existing
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

  const text = floorScanText(input.title, input.body, input.labels);
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

  return {
    verdict: reasons.some((r) => EXCLUDING_CHECKS.has(r.check)) ? 'full' : 'candidate',
    review: reasons.length > 0 ? 'full' : 'light',
    reasons,
  };
}
