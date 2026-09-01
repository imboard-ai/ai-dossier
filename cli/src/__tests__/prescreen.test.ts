import { describe, expect, it } from 'vitest';
import { HARD_BLOCK_LABELS } from '../hard-block-labels';
import {
  extractDependencyRefs,
  MAX_DEPENDENCY_REFS,
  prescreenIssue,
  TEXT_FLOOR_PATTERNS,
} from '../prescreen';
import regressionFixtures from './fixtures/prescreen-regression-issues.json';

const baseInput = { title: 'A small fix', body: 'Nothing special here.', labels: [] as string[] };

/** Character-code check (not a regex, so biome's control-char rule never applies) for `sanitize`'s guarantee. */
function hasControlCharOrBacktick(s: string): boolean {
  return [...s].some((ch) => {
    const code = ch.charCodeAt(0);
    return (
      (code >= 0 && code <= 8) ||
      (code >= 11 && code <= 31) ||
      code === 127 ||
      code === 0x9b ||
      ch === '`'
    );
  });
}

describe('prescreenIssue — hard-block labels', () => {
  for (const label of HARD_BLOCK_LABELS) {
    it(`rejects an issue carrying '${label}'`, () => {
      const result = prescreenIssue({ ...baseInput, labels: [label] });
      expect(result.verdict).toBe('full');
      expect(result.reasons).toEqual([
        expect.objectContaining({
          check: 'hard-block-label',
          message: expect.stringContaining(label),
        }),
      ]);
    });
  }

  it('is case-insensitive', () => {
    const result = prescreenIssue({ ...baseInput, labels: ['Epic'] });
    expect(result.verdict).toBe('full');
  });

  it('does not reject an unrelated label', () => {
    const result = prescreenIssue({ ...baseInput, labels: ['bug', 'frontend'] });
    expect(result.verdict).toBe('candidate');
  });

  it('sanitizes a label carrying control characters / backticks before it reaches the message', () => {
    // pickHardBlockLabel matches case-insensitively on the label's own text, so the label
    // itself has to be one of the real hard-block labels for this path to fire at all —
    // labels can't carry arbitrary attacker text and still trip this check. Still, `message`
    // must never let a control character or backtick escape the sentence it's embedded in.
    const result = prescreenIssue({ ...baseInput, labels: ['epic'] });
    expect(hasControlCharOrBacktick(result.reasons[0]?.message ?? '')).toBe(false);
  });
});

describe('prescreenIssue — text floor keywords', () => {
  it('rejects on a security keyword in the body', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This route has no security check on write access.',
    });
    expect(result.verdict).toBe('full');
    expect(result.reasons[0]).toMatchObject({ check: 'text-floor' });
  });

  it('names the matched keyword in the reason message', () => {
    const result = prescreenIssue({ ...baseInput, body: 'This integrates with Stripe.' });
    expect(result.verdict).toBe('full');
    expect(result.reasons[0]?.message).toContain("keyword: 'stripe'");
  });

  it('rejects on a terraform keyword in the title', () => {
    const result = prescreenIssue({ ...baseInput, title: 'CI gate: fail the terraform plan job' });
    expect(result.verdict).toBe('full');
  });

  it('rejects on a deploy-pipeline keyword', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'The deploy job failed on every push to main.',
    });
    expect(result.verdict).toBe('full');
  });

  it('rejects on a new-package keyword (multi-word phrase, whitespace-insensitive)', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This adds a new   package to the monorepo.',
    });
    expect(result.verdict).toBe('full');
  });

  it('does NOT reject bare "auth" — collides with benign phrasing like `gh auth`', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'Excluded from CI — no `gh` auth there, but runnable locally with auth.',
    });
    expect(result.verdict).toBe('candidate');
  });

  it('does NOT reject bare "infrastructure" — collides with "test infrastructure"', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This would have been an unrelated rider on a test-infrastructure change.',
    });
    expect(result.verdict).toBe('candidate');
  });

  it('treats a regex-metacharacter phrase as a literal keyword, not a pattern', () => {
    // "ci/cd" contains no regex metacharacters itself, but this guards the general mechanism:
    // a keyword's characters must be escaped before reaching `new RegExp`, so a keyword like
    // "c++" (hypothetical future addition) could never be misread as a quantifier.
    const result = prescreenIssue({ ...baseInput, body: 'Our ci/cd pipeline is broken.' });
    expect(result.verdict).toBe('full');
  });

  it('every pattern name is unique (reasons stay attributable)', () => {
    const names = TEXT_FLOOR_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('prescreenIssue — path-based risk floor and file count (plan:v1 artifact present)', () => {
  it('reuses scanRiskFloor on predicted files', () => {
    const result = prescreenIssue({ ...baseInput, predictedFiles: ['packages/auth/login.ts'] });
    expect(result.verdict).toBe('full');
    expect(result.reasons[0]).toMatchObject({ check: 'path-floor' });
  });

  it('sanitizes a predicted-file path (plan:v1 is a comment anyone can post) before it reaches the message', () => {
    const result = prescreenIssue({
      ...baseInput,
      predictedFiles: ['packages/auth/login`.ts'],
    });
    expect(hasControlCharOrBacktick(result.reasons[0]?.message ?? '')).toBe(false);
  });

  it('caps path-floor reasons at 8 even when an adversarial plan:v1 artifact lists more risk-floor paths', () => {
    const files = Array.from({ length: 20 }, (_, i) => `packages/auth/file${i}.ts`);
    const result = prescreenIssue({ ...baseInput, predictedFiles: files });
    const pathFloorReasons = result.reasons.filter((r) => r.check === 'path-floor');
    expect(pathFloorReasons).toHaveLength(8);
  });

  it('rejects when predicted files exceed 8', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
    const result = prescreenIssue({ ...baseInput, predictedFiles: files });
    expect(result.verdict).toBe('full');
    expect(result.reasons[0]).toMatchObject({ check: 'file-count' });
  });

  it('does not reject on exactly 8 predicted files', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    const result = prescreenIssue({ ...baseInput, predictedFiles: files });
    expect(result.verdict).toBe('candidate');
  });

  it('skips the path/file-count checks when no plan artifact exists (undefined predictedFiles)', () => {
    const result = prescreenIssue({ ...baseInput });
    expect(result.verdict).toBe('candidate');
  });
});

describe('extractDependencyRefs', () => {
  it('extracts a single reference', () => {
    expect(extractDependencyRefs('Depends on #123')).toEqual([123]);
  });

  it('is case-insensitive', () => {
    expect(extractDependencyRefs('depends ON #45')).toEqual([45]);
  });

  it('extracts multiple, de-duplicated, in order', () => {
    expect(extractDependencyRefs('Depends on #1 and Depends on #2, also Depends on #1')).toEqual([
      1, 2,
    ]);
  });

  it('returns an empty array when there is no reference', () => {
    expect(extractDependencyRefs('Nothing to see here, just #42 mentioned in passing.')).toEqual(
      []
    );
  });

  it(`caps at MAX_DEPENDENCY_REFS (${MAX_DEPENDENCY_REFS}) so an adversarial body cannot force an unbounded gh fan-out`, () => {
    const body = Array.from(
      { length: MAX_DEPENDENCY_REFS + 50 },
      (_, i) => `Depends on #${i + 1}`
    ).join(' ');
    const refs = extractDependencyRefs(body);
    expect(refs).toHaveLength(MAX_DEPENDENCY_REFS);
    expect(refs).toEqual(Array.from({ length: MAX_DEPENDENCY_REFS }, (_, i) => i + 1));
  });
});

describe('prescreenIssue — open dependencies', () => {
  it('rejects when an open dependency is passed in', () => {
    const result = prescreenIssue({ ...baseInput, openDependencies: [123] });
    expect(result.verdict).toBe('full');
    expect(result.reasons[0]).toMatchObject({
      check: 'open-dependency',
      message: expect.stringContaining('#123'),
    });
  });

  it('caps open-dependency reasons at 8', () => {
    const deps = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = prescreenIssue({ ...baseInput, openDependencies: deps });
    const depReasons = result.reasons.filter((r) => r.check === 'open-dependency');
    expect(depReasons).toHaveLength(8);
  });

  it('records multiple hits together (a verdict may hit several)', () => {
    const result = prescreenIssue({
      title: 'terraform change',
      body: 'the deploy job is failing',
      labels: ['epic'],
      openDependencies: [7],
    });
    expect(result.verdict).toBe('full');
    const checks = result.reasons.map((r) => r.check).sort();
    expect(checks).toEqual(['hard-block-label', 'open-dependency', 'text-floor', 'text-floor']);
  });
});

/**
 * Regression fixture (#538 AC4) — read-only `gh` data captured 2026-09-01 from
 * imboard-ai/imboard-monorepo's real 15-issue classify set (RFC-0001 pilot attempt 2,
 * `docs/reports/batch-pilot-2-execution.md` §2.2): 3 known `slot`, 12 known `full`.
 * `cycle:full`/`cycle:slot` labels are stripped from the fixture — they are the
 * classifier's OWN output, not input a pre-screen running before classification would see.
 * URLs/names from the private source repo are redacted (a Google Sheets link, a screenshot
 * host, and a QA tester's name) — irrelevant to keyword matching, but this repo is public.
 *
 * Each fixture entry carries two independent labels: `knownCycle` (`slot`/`full`) is the
 * pilot's ACTUAL classifier verdict — ground truth, never computed by this test. `expectedVerdict`
 * (`full`/`candidate`) is what THIS PR's `prescreenIssue` — a pre-screen, not the classifier —
 * should return for that issue; the two are different questions, which is exactly why AC4's
 * "still classifies slot/full" claim needs both a pre-screen safety property (below) AND a
 * documented boundary (docs/reports/issue-538-classifier-cost-methodology.md) about what a
 * pre-screen-only test can and cannot prove about the classifier's full end-to-end verdict.
 *
 * Coverage is asymmetric by design (AC1: pre-screen rejects "obvious" full cases, not all of
 * them):
 * - The 3 known `slot` issues MUST all come back `candidate` — pre-screen must never falsely
 *   reject a real slot-eligible issue (that would silently regress classification quality).
 * - The 12 known `full` issues split: 7 have a genuinely deterministic signal in their
 *   title/body/labels (terraform, security, deploy, migration, authorization, or a `cicd`
 *   label) and MUST come back `full`. The remaining 5 (#3839, #3893, #3632 — rule 8
 *   visual/browser review; #3961 — rules 9/10 dependency/confidence; #3923 — rules 5/6 file/diff
 *   size, unavailable without a plan:v1 artifact) have no deterministic signal available from
 *   issue text alone — asserted `candidate` ON PURPOSE. That's not a miss; it's exactly what
 *   AC2's bounded mechanical-tier classify pass exists to catch instead of a mid-tier
 *   repo-exploring one.
 */
describe('prescreenIssue — regression fixture (imboard-monorepo pilot attempt 2, 15 issues)', () => {
  interface Fixture {
    number: number;
    title: string;
    labels: string[];
    body: string;
    knownCycle: 'slot' | 'full';
    expectedVerdict: 'full' | 'candidate';
  }

  const fixtures = regressionFixtures as Fixture[];

  for (const fixture of fixtures) {
    it(`#${fixture.number} → ${fixture.expectedVerdict}`, () => {
      const result = prescreenIssue({
        title: fixture.title,
        body: fixture.body,
        labels: fixture.labels,
      });
      expect(result.verdict).toBe(fixture.expectedVerdict);
    });
  }

  it('the fixture set matches the pilot report exactly: 15 issues, 3 known slot, 12 known full', () => {
    expect(fixtures).toHaveLength(15);
    expect(
      fixtures
        .filter((f) => f.knownCycle === 'slot')
        .map((f) => f.number)
        .sort()
    ).toEqual([3631, 3820, 3887]);
    expect(fixtures.filter((f) => f.knownCycle === 'full')).toHaveLength(12);
  });

  it('the pre-screen deterministically rejects exactly 7 of the 15 (the aggregate this PR reports)', () => {
    // Pinned so the reported hit rate (docs/reports/issue-538-classifier-cost-methodology.md)
    // cannot silently drift — adding/removing a fixture without updating that report now fails
    // a test instead of just going stale.
    const results = fixtures.map(
      (f) => prescreenIssue({ title: f.title, body: f.body, labels: f.labels }).verdict
    );
    expect(results.filter((v) => v === 'full')).toHaveLength(7);
    expect(results.filter((v) => v === 'candidate')).toHaveLength(8);
  });

  it('never falsely rejects a known-slot issue (the safety property AC4 exists to protect)', () => {
    const slotIssues = fixtures.filter((f) => f.knownCycle === 'slot').map((f) => f.number);
    expect(slotIssues).toHaveLength(3);
    const results = fixtures
      .filter((f) => slotIssues.includes(f.number))
      .map((f) => prescreenIssue({ title: f.title, body: f.body, labels: f.labels }).verdict);
    expect(results).toEqual(['candidate', 'candidate', 'candidate']);
  });
});
