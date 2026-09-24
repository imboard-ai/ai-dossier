import { describe, expect, it } from 'vitest';
import { legacyVerdict, measureBacklog, toInput } from './prescreen-backlog-measure.mjs';

/**
 * A minimal stand-in for the cli/dist exports the script uses — keeps this test free of a
 * build dependency. The keyword list is one word; the v2 `prescreenIssue` stand-in ignores
 * a leading "Found by" line, which is enough to exercise every counter.
 */
const api = {
  TEXT_FLOOR_PATTERNS: [
    { name: 'rule1', match: (t) => (/\bbilling\b/i.test(t) ? 'billing' : null) },
  ],
  stripQuotedSpans: (t) => t.replace(/`[^`\n]*`/g, ' '),
  pickHardBlockLabel: (labels) => labels.find((l) => l === 'epic') ?? null,
  prescreenIssue: ({ title, body, labels }) => {
    const hard = labels.includes('epic');
    const scoped = body
      .split('\n')
      .filter((l) => !/^found by/i.test(l))
      .join('\n');
    const hit = /\bbilling\b/i.test(`${title}\n${scoped}`);
    const reasons = [];
    if (hard)
      reasons.push({ check: 'hard-block-label', message: "Carries hard-block label 'epic'." });
    if (hit)
      reasons.push({
        check: 'text-floor',
        message: "Title/body/labels match 'rule1' (keyword: 'billing').",
      });
    return {
      verdict: hard ? 'full' : 'candidate',
      review: reasons.length > 0 ? 'full' : 'light',
      reasons,
    };
  },
};

describe('prescreen-backlog-measure', () => {
  it('toInput normalises gh label objects and missing fields', () => {
    expect(toInput({ number: 1, labels: [{ name: 'bug' }, 'x', {}] })).toEqual({
      number: 1,
      title: '',
      body: '',
      labels: ['bug', 'x'],
    });
  });

  it('legacyVerdict reproduces v1: any keyword anywhere, or a hard-block label, ⇒ full', () => {
    expect(
      legacyVerdict(toInput({ number: 1, title: 't', body: 'Found by the billing review.' }), api)
    ).toEqual({
      verdict: 'full',
      keyword: 'billing',
    });
    expect(
      legacyVerdict(toInput({ number: 2, title: 't', body: 'x', labels: ['epic'] }), api).verdict
    ).toBe('full');
    expect(legacyVerdict(toInput({ number: 3, title: 't', body: '`billing`' }), api).verdict).toBe(
      'candidate'
    );
  });

  it('measureBacklog counts before/after full, review=full, and dropped provenance-only hits', () => {
    const { summary, rows } = measureBacklog(
      [
        { number: 10, title: 'cleanup', body: 'Found by the billing review.', labels: [] },
        { number: 11, title: 'fix billing sweep', body: '', labels: [] },
        { number: 12, title: 'plan', body: '', labels: [{ name: 'epic' }] },
        { number: 13, title: 'rename helper', body: '', labels: [] },
      ],
      api
    );
    expect(summary).toEqual({
      total: 4,
      beforeFull: 3,
      afterFull: 1,
      afterReviewFull: 2,
      afterCandidateReviewFull: 1,
      droppedTextHits: 1,
    });
    expect(rows.find((r) => r.number === 11)).toEqual({
      number: 11,
      before: 'full',
      beforeKeyword: 'billing',
      after: 'candidate',
      review: 'full',
      afterKeyword: 'billing',
    });
  });
});
