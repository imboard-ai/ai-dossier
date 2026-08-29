import { describe, expect, it } from 'vitest';
import {
  buildPlanComment,
  extractPredictedFiles,
  findLatestPlan,
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
    expect(latest?.head).toBe('bbb2222');
    expect(latest?.sections.Problem).toBe('v2');
  });

  it('ignores plans quoted inside other comments (marker must open the body)', () => {
    const quote = `> ${newer.split('\n').join('\n> ')}`;
    const latest = findLatestPlan([older, quote]);
    expect(latest?.head).toBe('aaa1111');
  });

  it('returns null when no comment carries a plan', () => {
    expect(findLatestPlan(['one', '<!-- runstate:v1 -->\nphase=gate', 'two'])).toBeNull();
  });

  it('returns null for no comments at all', () => {
    expect(findLatestPlan([])).toBeNull();
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
