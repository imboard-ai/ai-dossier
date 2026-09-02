import { describe, expect, it } from 'vitest';
import {
  buildPlanComment,
  extractNewPredictedFiles,
  extractPredictedFiles,
  findLatestPlan,
  isHeadSha,
  MAX_ARTIFACT_BODY_LENGTH,
  PLAN_SECTIONS,
  parsePlanArtifact,
  parsePlanMarker,
  scanRiskFloor,
  validateArtifactBody,
} from '../plan-artifact';

/** A minimal valid artifact body, used as the base for mutations. */
function validBody(): string {
  return [
    '<!-- plan:v1 head=abc1234 -->',
    '',
    '# Issue #1: do a thing',
    '',
    '## Problem',
    'It is broken.',
    '',
    '## Acceptance Criteria',
    '- AC1 it works',
    '',
    '## Predicted Files',
    '- `src/foo.ts` — the change',
    '- `docs/foo.md` — the spec',
    '',
    '## Approach',
    '1. Fix it.',
    '',
    '## Test Scope',
    '- unit tests',
    '',
  ].join('\n');
}

describe('parsePlanMarker', () => {
  it('parses a well-formed opening marker line', () => {
    expect(parsePlanMarker('<!-- plan:v1 head=abc1234 -->\n\n## Problem')).toEqual({
      head: 'abc1234',
    });
  });

  it('accepts a full 40-char sha', () => {
    const sha = 'a'.repeat(40);
    expect(parsePlanMarker(`<!-- plan:v1 head=${sha} -->`)).toEqual({ head: sha });
  });

  it('rejects a marker that is not the first line', () => {
    expect(parsePlanMarker('some preamble\n<!-- plan:v1 head=abc1234 -->')).toBeNull();
  });

  it('rejects a missing head', () => {
    expect(parsePlanMarker('<!-- plan:v1 -->')).toBeNull();
  });

  it('rejects a non-hex head', () => {
    expect(parsePlanMarker('<!-- plan:v1 head=zzz9999zz -->')).toBeNull();
  });

  it('rejects other protocols and plain text', () => {
    expect(parsePlanMarker('<!-- runstate:v1 -->')).toBeNull();
    expect(parsePlanMarker('hello')).toBeNull();
    expect(parsePlanMarker('')).toBeNull();
  });
});

describe('validateArtifactBody', () => {
  it('accepts a document with all five sections', () => {
    expect(validateArtifactBody(validBody().split('\n').slice(1).join('\n'))).toEqual([]);
  });

  it('names every missing section', () => {
    const errors = validateArtifactBody('## Problem\nonly one section\n');
    expect(errors).toHaveLength(PLAN_SECTIONS.length - 1);
    for (const error of errors) expect(error).toMatch(/^Missing required section '## /);
  });

  it('does not match a section mentioned in prose', () => {
    const errors = validateArtifactBody('The words Acceptance Criteria appear here, but as text.');
    expect(errors.length).toBe(PLAN_SECTIONS.length);
  });
});

describe('extractPredictedFiles', () => {
  it('takes backticked paths from bullets', () => {
    const files = extractPredictedFiles('- `cli/src/foo.ts` — the change');
    expect(files).toEqual(['cli/src/foo.ts']);
  });

  it('falls back to the first bare token when there are no backticks', () => {
    expect(extractPredictedFiles('- cli/src/foo.ts — the change')).toEqual(['cli/src/foo.ts']);
  });

  it('ignores non-bullet lines and empty bullets', () => {
    const section = ['A lead-in line.', '- `a.ts` — x', '-   ', 'plain text', '* `b.ts` — y'].join(
      '\n'
    );
    expect(extractPredictedFiles(section)).toEqual(['a.ts', 'b.ts']);
  });

  it('strips trailing punctuation from a bare path', () => {
    expect(extractPredictedFiles('- docs/foo.md, plus context')).toEqual(['docs/foo.md']);
  });

  it('returns [] for an empty section', () => {
    expect(extractPredictedFiles('')).toEqual([]);
  });

  it('keeps the path when the bullet carries a (new) marker', () => {
    expect(extractPredictedFiles('- `docs/new-runbook.md` (new) — created by this issue')).toEqual([
      'docs/new-runbook.md',
    ]);
  });
});

describe('extractNewPredictedFiles', () => {
  it('returns the path of a bullet marked (new)', () => {
    const section = ['- `docs/new-runbook.md` (new) — created by this issue'].join('\n');
    expect(extractNewPredictedFiles(section)).toEqual(new Set(['docs/new-runbook.md']));
  });

  it('is case-insensitive on the marker', () => {
    expect(extractNewPredictedFiles('- `a.ts` (NEW) — x')).toEqual(new Set(['a.ts']));
  });

  it('recognizes the marker on a bare (unbacktracked) path too', () => {
    expect(extractNewPredictedFiles('- docs/new.md (new) — x')).toEqual(new Set(['docs/new.md']));
  });

  it('does not mark a bullet with no (new) suffix', () => {
    expect(extractNewPredictedFiles('- `a.ts` — x')).toEqual(new Set());
  });

  it('does not match "(new)" appearing only in the reason, after the separator', () => {
    // The marker must immediately follow the path — "(new)" later in the bullet text
    // (e.g. inside the reason) does not count, so a reason cannot accidentally suppress
    // the missing-file check.
    expect(extractNewPredictedFiles('- `a.ts` — see the (new) design doc')).toEqual(new Set());
  });

  it('returns an empty set for an empty section', () => {
    expect(extractNewPredictedFiles('')).toEqual(new Set());
  });
});

describe('buildPlanComment / parsePlanArtifact round-trip', () => {
  it('round-trips a posted comment back into an artifact', () => {
    const markdown = validBody().split('\n').slice(1).join('\n');
    const body = buildPlanComment('abc1234', markdown);
    const artifact = parsePlanArtifact(body);
    expect(artifact).not.toBeNull();
    expect(artifact?.head).toBe('abc1234');
    expect(artifact?.sections.Problem).toBe('It is broken.');
    expect(artifact?.sections['Test Scope']).toBe('- unit tests');
    expect(artifact?.predictedFiles).toEqual(['src/foo.ts', 'docs/foo.md']);
    expect(artifact?.newFiles).toEqual(new Set());
  });

  it('parses an artifact with missing sections so readers can report it', () => {
    const artifact = parsePlanArtifact('<!-- plan:v1 head=abc1234 -->\n\n## Problem\nonly.\n');
    expect(artifact).not.toBeNull();
    expect(artifact?.sections.Problem).toBe('only.');
    expect(artifact?.sections.Approach).toBe('');
    expect(artifact?.predictedFiles).toEqual([]);
  });

  it('returns null for a body without a marker', () => {
    expect(parsePlanArtifact('## Problem\nno marker\n')).toBeNull();
  });
});

describe('findLatestPlan', () => {
  const older = buildPlanComment(
    'aaa1111',
    '## Problem\nv1\n\n## Acceptance Criteria\nx\n\n## Predicted Files\n\n## Approach\n\n## Test Scope\n'
  );
  const newer = buildPlanComment(
    'bbb2222',
    '## Problem\nv2\n\n## Acceptance Criteria\nx\n\n## Predicted Files\n\n## Approach\n\n## Test Scope\n'
  );

  it('takes the LAST plan comment — posting supersedes', () => {
    const latest = findLatestPlan(['noise comment', older, 'another noise', newer]);
    expect(latest?.artifact.head).toBe('bbb2222');
    expect(latest?.artifact.sections.Problem).toBe('v2');
    expect(latest?.index).toBe(3);
  });

  it('ignores plans quoted inside other comments (marker must open the body)', () => {
    const quote = `> ${newer.split('\n').join('\n> ')}`;
    const latest = findLatestPlan([older, quote]);
    expect(latest?.artifact.head).toBe('aaa1111');
    expect(latest?.index).toBe(0);
  });

  it('returns null when no comment carries a plan', () => {
    expect(findLatestPlan(['one', '<!-- runstate:v1 -->\nphase=gate', 'two'])).toBeNull();
  });

  it('returns null for no comments at all', () => {
    expect(findLatestPlan([])).toBeNull();
  });
});

describe('isHeadSha', () => {
  it('accepts 7-40 lowercase hex characters', () => {
    expect(isHeadSha('abc1234')).toBe(true);
    expect(isHeadSha('a'.repeat(40))).toBe(true);
  });

  it('rejects uppercase, too-short, too-long, and non-hex values', () => {
    expect(isHeadSha('ABC1234')).toBe(false);
    expect(isHeadSha('abc123')).toBe(false);
    expect(isHeadSha('a'.repeat(41))).toBe(false);
    expect(isHeadSha('main')).toBe(false);
    expect(isHeadSha('12-31')).toBe(false);
    expect(isHeadSha('')).toBe(false);
  });
});

describe('scanRiskFloor', () => {
  it('flags auth, payments, migrations, and protocol surfaces', () => {
    const hits = scanRiskFloor([
      'src/auth/session.ts',
      'services/payments/stripe.ts',
      'prisma/migrations/0001.sql',
      'packages/core/protocol.ts',
    ]);
    expect(hits.map((h) => h.pattern).sort()).toEqual([
      'auth-secrets',
      'migrations-schema',
      'payments-billing',
      'protocol-contract',
    ]);
  });

  it('flags key files by extension', () => {
    expect(scanRiskFloor(['keys/server.pem'])).toEqual([
      { path: 'keys/server.pem', pattern: 'auth-secrets' },
    ]);
  });

  it('leaves ordinary paths alone', () => {
    expect(scanRiskFloor(['cli/src/cli.ts', 'docs/guide.md', 'README.md'])).toEqual([]);
  });

  it('can report more than one hit for the same path', () => {
    const hits = scanRiskFloor(['auth/schema.sql']);
    expect(hits).toHaveLength(2);
  });
});

describe('buildPlanComment', () => {
  it('opens with the marker line and trims the markdown', () => {
    const body = buildPlanComment('abc1234', '\n## Problem\nx\n\n');
    expect(body.startsWith('<!-- plan:v1 head=abc1234 -->\n')).toBe(true);
    expect(body.endsWith('x\n')).toBe(true);
  });

  it('documents the cap the command enforces', () => {
    expect(MAX_ARTIFACT_BODY_LENGTH).toBeLessThan(65536);
  });
});
