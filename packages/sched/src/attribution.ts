/**
 * Batch failure attribution, stage 1 — RFC-0001 §F.2 (#472): map each failing
 * test of a red aggregate suite to a batch member via changed-path and
 * focused-test overlap. Everything here is a pure function of its inputs —
 * no I/O, no LLM (the RFC's "pure script" requirement); ambiguous results
 * are returned AS ambiguous and resolved by the deterministic bisect runner
 * (`bisect.ts`), never guessed here.
 *
 * The commit ↔ member mapping keys on the slot-cycle commit convention:
 * every member lands exactly one commit whose subject ends in `(#N)` — the
 * same derivation the aggregate-review and batch-ship dossiers use.
 */

/** One member's footprint on the batch branch — attribution's raw material. */
export interface MemberFootprint {
  /** Member issue number. */
  issue: number;
  /**
   * Repo-relative POSIX paths the member's boundary commit(s) changed (from
   * `git log --name-only` / `git diff-tree`), source files AND test files.
   */
  changed_paths: string[];
  /**
   * Focused test ids the member recorded (its plan artifact's test scope or
   * slot milestone). Matching is containment-tolerant: reporters print test
   * ids with varying prefixes.
   */
  focused_tests: string[];
}

/** One failing test of the aggregate suite, as reported. */
export interface FailingTest {
  /** Test id as the suite reporter printed it (may include `file > suite > case`). */
  id: string;
  /** Repo-relative test file path parsed from the id/report, when parseable. */
  file: string | null;
}

/** How one failing test was mapped. */
export type AttributionMethod = 'focused-test' | 'changed-path' | 'ambiguous' | 'unattributed';

/** The attribution verdict for one failing test. */
export interface TestAttribution {
  /** The failing test id, verbatim. */
  test: string;
  /** Candidate members: exactly one = attributed, more = ambiguous, none = unattributed. */
  members: number[];
  method: AttributionMethod;
}

/** One commit on the batch branch, with its member mapping (#472). */
export interface BoundaryCommit {
  /** Full commit sha. */
  sha: string;
  /** Commit subject line. */
  subject: string;
  /** Member issue number parsed from a trailing `(#N)`; null for non-boundary commits. */
  issue: number | null;
}

/** Normalize a test id for comparison: trimmed, whitespace collapsed. */
function normalizeTest(id: string): string {
  return id.trim().replace(/\s+/g, ' ');
}

/** Normalize a path for comparison: POSIX separators, no leading `./`. */
function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Whether two test ids name the same test, containment-tolerant: exact after
 * normalization, or either contains the other at word boundaries (reporters
 * vary in how much of the `file > suite > case` chain they print). Word
 * boundaries matter: without them "unknown test" would match "known test".
 */
function testIdMatches(a: string, b: string): boolean {
  const na = normalizeTest(a);
  const nb = normalizeTest(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  const containsAtWordBoundary = (needle: string, haystack: string): boolean => {
    const re = new RegExp(`\\b${escapeRe(needle)}\\b`);
    return re.test(haystack);
  };
  return containsAtWordBoundary(nb, na) || containsAtWordBoundary(na, nb);
}

/** Escape a literal for embedding in a RegExp. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The stem a test file exercises: `src/a.test.ts` → `src/a`. */
function testStem(file: string): string {
  return normalizePath(file).replace(/\.test\.[cm]?[jt]sx?$/, '');
}

/** The stem of a changed path: `src/a.ts` → `src/a`, `src/dir` stays `src/dir`. */
function pathStem(p: string): string {
  return normalizePath(p).replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Whether a changed path plausibly relates to a failing test file: the
 * changed path IS the test file, is a directory containing it, or is the
 * source file the test exercises (same stem — `src/a.ts` ↔ `src/a.test.ts`).
 * Absolute-vs-relative and leading-`./` differences are tolerated.
 */
function pathTouchesTestFile(changed: string, testFile: string): boolean {
  const c = normalizePath(changed);
  const f = normalizePath(testFile);
  if (c === f || f.startsWith(`${c}/`) || c.startsWith(`${f}/`)) return true;
  // Path-suffix tolerance for absolute vs relative spellings.
  if (f.endsWith(c) || c.endsWith(f)) return true;
  return testStem(f) !== '' && pathStem(c) === testStem(f);
}

/**
 * Attribute each failing test to member(s) by overlap (RFC-0001 §F.2):
 * first focused-test match, then changed-path overlap over the test's file.
 * Deterministic: member order follows `footprints` order; a unique match
 * attributes, multiple matches stay ambiguous (bisect's job), none is
 * unattributed.
 */
export function attributeByOverlap(
  failing: readonly FailingTest[],
  footprints: readonly MemberFootprint[]
): TestAttribution[] {
  return failing.map((test) => {
    // Stage 1: focused-test overlap — the member ran this exact test.
    const focused = footprints
      .filter((fp) => fp.focused_tests.some((t) => testIdMatches(t, test.id)))
      .map((fp) => fp.issue);
    if (focused.length > 0) {
      return {
        test: test.id,
        members: dedupe(focused),
        method: focused.length === 1 ? 'focused-test' : 'ambiguous',
      };
    }
    // Stage 2: changed-path overlap — the member changed the test file or
    // the source file the test exercises.
    if (test.file !== null) {
      const touched = footprints
        .filter((fp) => fp.changed_paths.some((p) => pathTouchesTestFile(p, test.file as string)))
        .map((fp) => fp.issue);
      if (touched.length > 0) {
        return {
          test: test.id,
          members: dedupe(touched),
          method: touched.length === 1 ? 'changed-path' : 'ambiguous',
        };
      }
    }
    return { test: test.id, members: [], method: 'unattributed' };
  });
}

function dedupe(issues: number[]): number[] {
  return [...new Set(issues)];
}

/**
 * Parse the stdout of `vitest run --reporter=json` (jest-compatible shape)
 * into failing tests. Malformed input yields an empty list — the caller
 * treats "no parseable failures" as an infra problem, not a green suite.
 */
export function parseVitestJson(stdout: string | null): FailingTest[] {
  if (stdout === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const results = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(results)) return [];
  const out: FailingTest[] = [];
  for (const file of results) {
    if (file === null || typeof file !== 'object') continue;
    const rec = file as { name?: unknown; assertionResults?: unknown };
    if (typeof rec.name !== 'string' || !Array.isArray(rec.assertionResults)) continue;
    for (const assertion of rec.assertionResults) {
      if (assertion === null || typeof assertion !== 'object') continue;
      const a = assertion as { status?: unknown; fullName?: unknown; title?: unknown };
      if (a.status !== 'failed') continue;
      const fullName = typeof a.fullName === 'string' ? a.fullName : String(a.title ?? '');
      if (fullName.length === 0) continue;
      out.push({ id: fullName, file: rec.name });
    }
  }
  return out;
}

/** Regex for the trailing `(#N)` trailer that marks a member's boundary commit. */
const ISSUE_TRAILER_RE = /^.*\s\(#(\d+)\)$/;

/**
 * Parse `git log --format=%H%x09%s` output (oldest first is NOT assumed —
 * `git log` prints newest first; the caller reverses if it needs oldest
 * first) into boundary commits. Lines without a trailing `(#N)` are kept
 * with `issue: null` — a first-bad commit that is not a boundary commit is
 * unattributable by design, never force-mapped.
 */
export function parseBoundaryCommits(logOutput: string | null): BoundaryCommit[] {
  if (logOutput === null) return [];
  const out: BoundaryCommit[] = [];
  for (const line of logOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const tab = trimmed.indexOf('\t');
    if (tab === -1) continue;
    const sha = trimmed.slice(0, tab);
    const subject = trimmed.slice(tab + 1);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const match = ISSUE_TRAILER_RE.exec(subject);
    out.push({ sha, subject, issue: match ? Number.parseInt(match[1], 10) : null });
  }
  return out;
}

/** The commits of `logOutput` that belong to `issue`, oldest first. */
export function commitsOfMember(boundaries: readonly BoundaryCommit[], issue: number): string[] {
  // git log prints newest first; reverse for oldest-first revert ranges.
  const oldestFirst = [...boundaries].reverse();
  return oldestFirst.filter((b) => b.issue === issue).map((b) => b.sha);
}
