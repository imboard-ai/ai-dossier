import { describe, expect, it } from 'vitest';
import { HARD_BLOCK_LABELS } from '../hard-block-labels';
import {
  extractDependencyRefs,
  floorScanText,
  MAX_DEPENDENCY_REFS,
  PRESCREEN_SCHEMA,
  prescreenIssue,
  stripQuotedSpans,
  stripReferenceMaterial,
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

/** #772: a text-floor hit is batchable (`candidate`) but reviewed at full depth. */
function expectTextFloorReviewFull(result: ReturnType<typeof prescreenIssue>): void {
  expect(result.verdict).toBe('candidate');
  expect(result.review).toBe('full');
  expect(result.reasons.some((r) => r.check === 'text-floor')).toBe(true);
}

/** No finding at all: `candidate`, `light`, no reasons. */
function expectClean(result: ReturnType<typeof prescreenIssue>): void {
  expect(result.verdict).toBe('candidate');
  expect(result.review).toBe('light');
  expect(result.reasons).toHaveLength(0);
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
  it('flags review=full (not exclusion) on a security keyword in the body', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This route has no security check on write access.',
    });
    expectTextFloorReviewFull(result);
    expect(result.reasons[0]).toMatchObject({ check: 'text-floor' });
  });

  it('names the matched keyword in the reason message', () => {
    const result = prescreenIssue({ ...baseInput, body: 'This integrates with Stripe.' });
    expectTextFloorReviewFull(result);
    expect(result.reasons[0]?.message).toContain("keyword: 'stripe'");
  });

  it('flags review=full (not exclusion) on a terraform keyword in the title', () => {
    const result = prescreenIssue({ ...baseInput, title: 'CI gate: fail the terraform plan job' });
    expectTextFloorReviewFull(result);
  });

  it('flags review=full (not exclusion) on a deploy-pipeline keyword', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'The deploy job failed on every push to main.',
    });
    expectTextFloorReviewFull(result);
  });

  it('flags review=full (not exclusion) on a new-package keyword (multi-word phrase, whitespace-insensitive)', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This adds a new   package to the monorepo.',
    });
    expectTextFloorReviewFull(result);
  });

  it('does NOT flag bare "auth" — collides with benign phrasing like `gh auth`', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'Excluded from CI — no `gh` auth there, but runnable locally with auth.',
    });
    expectClean(result);
  });

  it('does NOT flag bare "infrastructure" — collides with "test infrastructure"', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'This would have been an unrelated rider on a test-infrastructure change.',
    });
    expectClean(result);
  });

  it('treats a regex-metacharacter phrase as a literal keyword, not a pattern', () => {
    // "ci/cd" contains no regex metacharacters itself, but this guards the general mechanism:
    // a keyword's characters must be escaped before reaching `new RegExp`, so a keyword like
    // "c++" (hypothetical future addition) could never be misread as a quantifier.
    const result = prescreenIssue({ ...baseInput, body: 'Our ci/cd pipeline is broken.' });
    expectTextFloorReviewFull(result);
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
 *   label) and MUST be flagged — since #772 as `candidate` + `review: full` (a text-floor hit
 *   is no longer an exclusion; `expectedReview` carries it). The remaining 5 (#3839, #3893, #3632 — rule 8
 *   visual/browser review; #3961 — rules 9/10 dependency/confidence; #3923 — rules 5/6 file/diff
 *   size, unavailable without a plan:v1 artifact) have no deterministic signal available from
 *   issue text alone — asserted `candidate` ON PURPOSE. That's not a miss; it's exactly what
 *   AC2's bounded mechanical-tier classify pass exists to catch instead of a mid-tier
 *   repo-exploring one.
 */
describe('prescreenIssue — quoted spans are not the change surface (#627)', () => {
  it('a risk keyword inside a quoted UI string does not flag review=full', () => {
    // imboard#4036, verbatim: a `test(e2e)` spec that CLICKS a button labelled
    // "Set up payment". The change adds a Playwright file; the keyword is the
    // label it asserts on.
    const result = prescreenIssue({
      ...baseInput,
      title: 'test(e2e): @smoke CTA-effect spec — click "Set up payment" and a Guide Me row',
    });
    expect(result.verdict).toBe('candidate');
    expect(result.reasons).toHaveLength(0);
  });

  it('a backticked identifier is treated the same as a quoted string', () => {
    const result = prescreenIssue({
      ...baseInput,
      title: 'refactor: rename `paymentIntentId` in the fixture builder',
    });
    expect(result.verdict).toBe('candidate');
  });

  it('the SAME keyword unquoted still flags review=full', () => {
    // The narrowing must not disarm the rule — this is the case it exists for.
    const result = prescreenIssue({
      ...baseInput,
      title: 'feat: rewrite the payment capture flow',
    });
    expectTextFloorReviewFull(result);
    expect(result.reasons[0]?.check).toBe('text-floor');
  });

  it('an unbalanced quote blanks nothing', () => {
    const result = prescreenIssue({ ...baseInput, title: 'fix: the " in our terraform output' });
    expectTextFloorReviewFull(result);
  });

  it('a quote spanning more than MAX_QUOTED_SPAN is treated as prose, not stripped', () => {
    // Bound: a body full of unbalanced quotes must not let one span swallow the
    // text and blank every keyword.
    const long = 'x'.repeat(200);
    const result = prescreenIssue({ ...baseInput, title: `fix: "${long} terraform ${long}"` });
    expectTextFloorReviewFull(result);
  });

  it('stripQuotedSpans leaves unquoted text byte-identical', () => {
    const t = 'feat: rewrite the payment capture flow';
    expect(stripQuotedSpans(t)).toBe(t);
  });
});

describe('prescreenIssue — regression fixture (imboard-monorepo pilot attempt 2, 15 issues)', () => {
  interface Fixture {
    number: number;
    title: string;
    labels: string[];
    body: string;
    knownCycle: 'slot' | 'full';
    expectedVerdict: 'full' | 'candidate';
    /** #772: what `review` must be. The 7 text-floor issues moved from `verdict: full` to `candidate` + `review: full`. */
    expectedReview: 'light' | 'full';
  }

  const fixtures = regressionFixtures as Fixture[];

  for (const fixture of fixtures) {
    it(`#${fixture.number} → ${fixture.expectedVerdict}, review=${fixture.expectedReview}`, () => {
      const result = prescreenIssue({
        title: fixture.title,
        body: fixture.body,
        labels: fixture.labels,
      });
      expect(result.verdict).toBe(fixture.expectedVerdict);
      expect(result.review).toBe(fixture.expectedReview);
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

  it('the pre-screen deterministically flags exactly 7 of the 15 (the aggregate #538 reports) — as review=full, excluding none (#772)', () => {
    // Pinned so the reported hit rate (docs/reports/issue-538-classifier-cost-methodology.md)
    // cannot silently drift — adding/removing a fixture without updating that report now fails
    // a test instead of just going stale. #772: the same 7 are still caught deterministically
    // (section-aware scanning dropped none of them), but as `review: full` candidates — none of
    // the 15 carries a hard-block label, open dependency, or plan:v1 artifact, so none is excluded.
    const results = fixtures.map((f) =>
      prescreenIssue({ title: f.title, body: f.body, labels: f.labels })
    );
    expect(results.filter((r) => r.review === 'full')).toHaveLength(7);
    expect(results.filter((r) => r.review === 'light')).toHaveLength(8);
    expect(results.filter((r) => r.verdict === 'full')).toHaveLength(0);
  });

  it('never falsely rejects a known-slot issue (the safety property AC4 exists to protect)', () => {
    const slotIssues = fixtures.filter((f) => f.knownCycle === 'slot').map((f) => f.number);
    expect(slotIssues).toHaveLength(3);
    const results = fixtures
      .filter((f) => slotIssues.includes(f.number))
      .map((f) => prescreenIssue({ title: f.title, body: f.body, labels: f.labels }).verdict);
    expect(results).toEqual(['candidate', 'candidate', 'candidate']);
    const reviews = fixtures
      .filter((f) => slotIssues.includes(f.number))
      .map((f) => prescreenIssue({ title: f.title, body: f.body, labels: f.labels }).review);
    expect(reviews).toEqual(['light', 'light', 'light']);
  });
});

/**
 * #772 (parent RCA #770, Option A): the text floor scans the change surface, not provenance, and
 * a keyword hit means `review: full` — not exclusion from a batch.
 */
describe('prescreenIssue — section-aware text floor (#772)', () => {
  // imboard#4114, shape-preserving excerpt: the ONLY risk keyword ("security") sits in the
  // provenance line. The issue is a data-hygiene cascade cleanup.
  const issue4114 = {
    title:
      'chore: guest-board and example-pool cleanup are partial cascades that bypass purgeBoardCompletely',
    body: [
      'Found by the #4103 security review (committee subgroups slice 1/4).',
      '',
      '`services/guestBoardCleanupService.ts` (`deleteAbandonedBoard`) and `services/exampleBoardPoolService.ts` are bespoke, partial board cascades: they delete `Board` + `BoardUser` directly inside their own transactions rather than delegating to `purgeBoardCompletely`.',
      '',
      '## Suggested scope',
      '',
      '- Decide: delegate to `purgeBoardCompletely` or keep the bespoke deletes and add a drift test.',
      '- Either way, cover it with a test: seed a guest/pool board, run the cleanup, assert no orphan survives.',
    ].join('\n'),
    labels: ['in-progress'],
  };

  // imboard#4343, shape-preserving excerpt: genuine billing scope, stated in prose.
  const issue4343 = {
    title:
      'Guardrail: steer duration date-arithmetic to addDaysUtc — sweep-job query windows still use local setDate()',
    body: [
      '## What the user sees',
      '',
      'Nothing today — this is a latent guardrail gap, filed as the deliberate out-of-scope remainder of #4314.',
      '',
      '#4314 fixed the three billing windows that are **persisted as an end-date on a board**.',
      '',
      '## Acceptance',
      '',
      '1. The sweep-job query windows either move to `addDaysUtc`, or carry a one-line comment.',
      '',
      '## Notes',
      '',
      '- Guardrail follow-up to #4314 (PR pending). Not a regression.',
    ].join('\n'),
    labels: ['bug'],
  };

  it('AC1: imboard#4114-shaped body (keyword only in provenance) → no text-floor hit', () => {
    const result = prescreenIssue(issue4114);
    expect(result.reasons.filter((r) => r.check === 'text-floor')).toHaveLength(0);
    expectClean(result);
  });

  it('AC1 guard: the same body WITHOUT provenance handling would have hit (the fixture is live)', () => {
    const naive = stripQuotedSpans(`${issue4114.title}\n${issue4114.body}`);
    expect(TEXT_FLOOR_PATTERNS.some((p) => p.match(naive) !== null)).toBe(true);
  });

  it('AC2: genuine billing scope (imboard#4343-shaped) → verdict candidate, review full', () => {
    const result = prescreenIssue(issue4343);
    expect(result.verdict).toBe('candidate');
    expect(result.review).toBe('full');
    expect(result.reasons).toEqual([
      expect.objectContaining({ check: 'text-floor', message: expect.stringContaining('billing') }),
    ]);
  });

  it('AC3: a hard-block label still → verdict full, even alongside a text-floor hit', () => {
    const result = prescreenIssue({ ...issue4343, labels: ['needs-clarification'] });
    expect(result.verdict).toBe('full');
    expect(result.review).toBe('full');
  });

  it('AC3: an open external dependency still → verdict full', () => {
    const result = prescreenIssue({ ...baseInput, openDependencies: [42] });
    expect(result.verdict).toBe('full');
    expect(result.review).toBe('full');
  });

  it('a plan:v1 path floor or >8 predicted files still → verdict full', () => {
    expect(prescreenIssue({ ...baseInput, predictedFiles: ['packages/auth/x.ts'] }).verdict).toBe(
      'full'
    );
    const nine = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    expect(prescreenIssue({ ...baseInput, predictedFiles: nine }).verdict).toBe('full');
  });

  it('PRESCREEN_SCHEMA names the v2 contract', () => {
    expect(PRESCREEN_SCHEMA).toBe('prescreen:v2');
  });

  it.each([
    'Found by the #4103 security review.',
    'Found during the billing audit.',
    'Discovered during the payment migration.',
    '**Related:** #12 (security)',
    'Related: the billing epic',
    '- Follow-up to #4314 (billing windows)',
    'Followup to the security sweep',
    'Split from #99 (stripe work)',
    'Spun off from the terraform cleanup',
    'Parent: #770 (security RCA)',
    '> Surfaced by the deploy review',
    'See also #10 — billing',
  ])('drops the provenance line %j', (line) => {
    // Only markdown decoration / a terminator may survive — no words.
    expect(stripReferenceMaterial(line)).not.toMatch(/[a-z]{2,}/i);
    expect(prescreenIssue({ ...baseInput, body: line }).reasons).toHaveLength(0);
  });

  it('drops a link-only line (URLs, ref-only markdown links, #refs) but keeps prose around it', () => {
    const body = [
      'https://example.com/security/advisory',
      '- [#12](https://example.com/billing) , #12, org/repo#34',
      'Rename the widget helper.',
    ].join('\n');
    const result = prescreenIssue({ ...baseInput, body });
    expect(result.reasons).toHaveLength(0);
    expect(stripReferenceMaterial(body)).toContain('Rename the widget helper.');
  });

  it('keeps a markdown link whose TEXT is scope (only the target is reference material)', () => {
    expectTextFloorReviewFull(
      prescreenIssue({ ...baseInput, body: '- [Migrate billing tables](https://x.example/y)' })
    );
  });

  it('a # comment inside a fenced code block is not a heading — it neither opens nor closes an ignored section', () => {
    const opens = [
      '## Fix',
      'Run:',
      '```bash',
      '# Context setup',
      'make',
      '```',
      '## Scope',
      'Rotate the Stripe secrets',
    ].join('\n');
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, body: opens }));
    const closes = [
      '## Related',
      '```bash',
      '# Scope',
      '```',
      'The security audit that found this.',
    ].join('\n');
    expect(prescreenIssue({ ...baseInput, body: closes }).reasons).toHaveLength(0);
  });

  it.each([
    '## Background jobs\nThe billing cron fails.',
    '## Origin validation\nCORS allows any origin for the oauth callback.',
    '## Related billing work\nRewrite the invoice job.',
  ])('a heading that merely STARTS with an ignored word is scope: %j', (body) => {
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, body }));
  });

  it('an ignored heading still matches with emoji/emphasis/colon decoration', () => {
    const body = '## 🔗 **Related:**\nThe security audit that found this.';
    expect(prescreenIssue({ ...baseInput, body }).reasons).toHaveLength(0);
  });

  it.each([
    'Reported in production: billing totals are wrong.',
    'Found in the billing export: totals double-counted.',
    'Related billing webhooks also fail and must be fixed.',
    'Context: the Stripe checkout flow double-charges.',
    'Found by the #4103 review. Rotate the Stripe secrets.',
    'The token leak is found during checkout of credentials.',
    'Job was split from the billing migration and must be redone.',
    'This was found by QA, and the fix must touch the payment webhook.',
    'Found by the review! Payment flow broken.',
  ])('scope prose that shares words with provenance still hits: %j', (body) => {
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, body }));
  });

  it('strips a mid-line provenance clause to the end of its sentence, keeping the rest of the line', () => {
    const out = stripReferenceMaterial(
      'Two services bypass the cascade. Found by the security review. Fix the cascade.'
    );
    expect(out).toContain('Two services bypass the cascade.');
    expect(out).toContain('Fix the cascade.');
    expect(out).not.toContain('security');
  });

  it('keeps "related"/"context" mid-sentence — they are ordinary prose there', () => {
    const result = prescreenIssue({
      ...baseInput,
      body: 'Rewrite the related billing job; the context is the payment retry path.',
    });
    expectTextFloorReviewFull(result);
  });

  it.each([
    '## Related',
    '### Related issues',
    '## References',
    '## See also',
    '## Context',
    '## Background:',
  ])('drops the whole %j section (to the next same-or-higher heading)', (heading) => {
    const body = [
      'Rename the widget helper.',
      heading,
      '- The security audit that found this.',
      '#### nested detail',
      'The billing epic tracks the rest.',
      '## Acceptance',
      '- [ ] helper renamed',
    ].join('\n');
    const result = prescreenIssue({ ...baseInput, body });
    expect(result.reasons).toHaveLength(0);
    expect(stripReferenceMaterial(body)).toContain('helper renamed');
  });

  it('a scope section AFTER an ignored section is scanned again', () => {
    const body = ['## Background', 'Old notes.', '## Scope', 'Rewrite the billing sweep.'].join(
      '\n'
    );
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, body }));
  });

  it('unknown headings (Problem, Fix, What the user sees) are scanned — denylist, not allowlist', () => {
    for (const heading of ['## Problem', '## Fix', '## What the user sees']) {
      const result = prescreenIssue({
        ...baseInput,
        body: `${heading}\nThe stripe webhook drops events.`,
      });
      expectTextFloorReviewFull(result);
    }
  });

  it('the title and labels are always scanned (provenance handling is body-only)', () => {
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, title: 'Found by: security' }));
    expectTextFloorReviewFull(prescreenIssue({ ...baseInput, labels: ['security'] }));
  });

  it('floorScanText composes reference stripping with quote stripping (#627)', () => {
    const text = floorScanText('fix "payment" label', 'Found by the security review.', []);
    expect(text).not.toContain('payment');
    expect(text).not.toContain('security');
  });

  it('stripReferenceMaterial preserves line count and leaves plain scope text byte-identical', () => {
    const body = 'Line one.\n\nLine three with a billing change.';
    expect(stripReferenceMaterial(body)).toBe(body);
    const withProv = 'Found by X.\nKeep me.';
    expect(stripReferenceMaterial(withProv).split('\n')).toHaveLength(2);
  });
});

describe('prescreenIssue — adversarial bodies stay linear (#772 security review)', () => {
  // A 64 KB body (GitHub's limit) must not stall the pre-screen. Each of these took 8–25 s
  // before the heading / markdown-link / owner-repo regexes were made non-backtracking.
  const size = 65536;
  it.each([
    ['long whitespace run after a heading', `# a${' '.repeat(size)}b`],
    ['unclosed markdown link brackets', '['.repeat(size)],
    ['repeated half links', '[a]('.repeat(size / 4)],
    ['owner/repo-like dash runs', `${'a-'.repeat(size / 3)}/${'a-'.repeat(size / 6)}`],
  ])('%s', (_name, body) => {
    const start = performance.now();
    prescreenIssue({ ...baseInput, body });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('heading edge cases keep their meaning after the regex rewrite', () => {
    for (const heading of ['## Context ##', '## Background:\r', '### Related issues ###  ']) {
      const body = `${heading}\nThe security audit that found this.`;
      expect(prescreenIssue({ ...baseInput, body }).reasons).toHaveLength(0);
    }
    expectTextFloorReviewFull(
      prescreenIssue({ ...baseInput, body: '#nope\nRewrite the billing job.' })
    );
    expectTextFloorReviewFull(
      prescreenIssue({ ...baseInput, body: 'see owner/repo#12 and fix the billing job' })
    );
    expect(
      prescreenIssue({ ...baseInput, body: 'org/repo#12, foo-bar/baz.qux#3' }).reasons
    ).toHaveLength(0);
  });
});
