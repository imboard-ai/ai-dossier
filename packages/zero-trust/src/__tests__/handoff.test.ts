import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forkTarget } from '../github/fork-ref';
import {
  compareLink,
  engagementBody,
  findHandoffMarkers,
  HandoffError,
  handoffIntentId,
  handoffMarker,
  issueCommentLink,
  MAX_PREFILL_URL_LENGTH,
  type PrBinding,
} from '../github/handoff';
import {
  type HandoffAdmission,
  HandoffDriver,
  type HandoffOutcome,
  renderHandoffStatus,
  replayHandoffs,
} from '../github/handoff-driver';
import { buildPrContent, type PrContentInput } from '../github/pr-body';
import { ForkPusher } from '../github/push';
import {
  anonymousReader,
  type GitHubRead,
  reconcileComment,
  reconcilePr,
} from '../github/reconcile';
import { assertContentPolicy } from '../github/text';
import type { IntentInput } from '../intents';
import { Journal, JournalError } from '../journal';
import { freshnessRig } from '../policy/__tests__/freshness-rig';
import { receiptDigest } from '../receipt/issue';
import { type CommandEvidence, evidenceVerified, RECEIPT_VERSION } from '../receipt/schema';
import { SecretRedactionError } from '../redaction';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../state';

const T = '2026-10-06T00:00:00.000Z';
const BASE_SHA = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const binding: PrBinding = {
  upstream: { owner: 'up', repo: 'proj' },
  base: 'main',
  headOwner: 'alice',
  branch: 'ztfc/fix-8',
};
const issue = { upstream: { owner: 'up', repo: 'proj' }, issue: 8 };
const prIntent: IntentInput = {
  contributionId: 'contribution-1',
  target: 'up/proj#8',
  operationKind: 'pr_create',
  candidateSha: CANDIDATE,
};
const engagementIntent: IntentInput = {
  contributionId: 'contribution-1',
  target: 'up/proj#8',
  operationKind: 'engagement_comment',
  candidateSha: null,
};
const gating = createRun(
  { runId: 'run-1', upstreamIssue: 'https://github.com/up/proj/issues/8', contributor: 'alice' },
  T
);
const shipping = [
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed,
].reduce((run, reason) => transitionRun(run, reason, T), gating);

function command(overrides: Partial<CommandEvidence> = {}): CommandEvidence {
  return {
    id: 'test',
    command: 'npm test',
    required: true,
    status: 'passed',
    exitStatus: 0,
    suites: 3,
    sanitizedLogDigest: DIGEST,
    ...overrides,
  };
}
function receipt(commands: CommandEvidence[] = [command()], candidateSha = CANDIDATE) {
  return {
    schemaVersion: RECEIPT_VERSION,
    contributionId: 'contribution-1',
    runId: 'run-1',
    sessionId: 'session-1',
    contributor: 'alice',
    upstreamRepositoryId: 11,
    issue: 8,
    defaultBranch: 'main',
    forkRepositoryId: 22,
    baseSha: BASE_SHA,
    parentSha: BASE_SHA,
    candidateSha,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    profile: {
      name: 'node-22',
      runtime: '22.0.0',
      imageDigest: `sha256:${DIGEST}`,
      accelerator: 'kvm',
    },
    commands,
    networkPolicy: {
      acquisition: 'source-broker',
      provisioning: 'registry-proxy',
      verification: 'none',
      shipping: 'github',
    },
    issuedAt: T,
    expiresAt: '2026-10-06T00:15:00.000Z',
    permittedShippingOperations: [],
    verified: evidenceVerified(commands),
  };
}
function contentInput(overrides: Partial<PrContentInput> = {}): PrContentInput {
  return {
    intent: prIntent,
    issue: 8,
    title: 'Fix off-by-one in range()',
    cause: 'range() used < instead of <= for the inclusive upper bound.',
    scope: 'One comparison in src/range.js plus a regression test.',
    receipt: receipt(),
    receiptAllowed: true,
    regression: {
      command: 'node --test test/range.test.js',
      baseStatus: 'failed',
      candidateStatus: 'passed',
    },
    limitations: ['Only the inclusive bound is covered.'],
    ...overrides,
  };
}

interface PullFixture {
  number?: number;
  state?: 'open' | 'closed';
  merged_at?: string | null;
  body?: string | null;
  sha?: string;
  author?: string;
  label?: string;
  created_at?: string;
}
function pull(f: PullFixture = {}) {
  const number = f.number ?? 5;
  return {
    number,
    html_url: `https://github.com/up/proj/pull/${number}`,
    state: f.state ?? 'open',
    created_at: f.created_at ?? '2026-10-06T00:30:00.000Z',
    merged_at: f.merged_at ?? null,
    body: f.body === undefined ? `Body\n${handoffMarker(prIntent)}` : f.body,
    user: { login: f.author ?? 'alice' },
    head: { label: f.label ?? 'alice:ztfc/fix-8', ref: 'ztfc/fix-8', sha: f.sha ?? CANDIDATE },
    base: { ref: 'main' },
  };
}
function comment(id: number, body: string, author = 'alice') {
  return {
    id,
    html_url: `https://github.com/up/proj/issues/8#issuecomment-${id}`,
    body,
    user: { login: author },
  };
}

/** Mocked GitHub HTTP: GET only, by path prefix. Records every request. */
function github(routes: {
  pulls?: unknown[];
  basePulls?: unknown[];
  comments?: unknown[];
  status?: number;
}) {
  const calls: string[] = [];
  const read: GitHubRead = async (p) => {
    calls.push(p);
    if (routes.status) return { status: routes.status, body: { message: 'rate limited' } };
    const items = p.includes('direction=desc')
      ? (routes.basePulls ?? [])
      : p.includes('/pulls?')
        ? (routes.pulls ?? [])
        : (routes.comments ?? []);
    const page = Number(/[?&]page=(\d+)/u.exec(p)?.[1] ?? '1');
    return { status: 200, body: items.slice((page - 1) * 100, page * 100) };
  };
  return { read, calls };
}

describe('compare link', () => {
  const content = () => buildPrContent(contentInput());

  it('targets only the controller binding; prefilled fields are encoded', () => {
    const { title, body, commands } = content();
    const link = compareLink(prIntent, binding, title, body, commands);
    expect(link.kind).toBe('prefilled');
    const url = new URL(link.url);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/up/proj/compare/main...alice:ztfc/fix-8');
    expect([...url.searchParams.keys()]).toEqual(['expand', 'title', 'body']);
    expect(url.searchParams.get('title')).toBe(title);
    expect(url.searchParams.get('body')).toBe(body);
  });

  it('hostile title/body cannot change owner, repo, base or head', () => {
    const marker = handoffMarker(prIntent);
    const hostile = 'x&base=evil&head=mallory:x#frag ?/../../other/repo/compare/a...b %0A';
    const link = compareLink(prIntent, binding, hostile, `${hostile}\n${marker}`);
    const url = new URL(link.url);
    expect(url.pathname).toBe('/up/proj/compare/main...alice:ztfc/fix-8');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['expand', 'title', 'body']);
    expect(url.searchParams.get('body')).toBe(`${hostile}\n${marker}`);
  });

  it.each([
    { ...binding, upstream: { owner: 'up/evil', repo: 'proj' } },
    { ...binding, upstream: { owner: 'up', repo: '..' } },
    { ...binding, base: '../main' },
    { ...binding, base: 'main?x=1' },
    { ...binding, branch: 'a..b' },
    { ...binding, branch: 'fix#1' },
    { ...binding, branch: '-x' },
    { ...binding, branch: 'x.lock' },
    { ...binding, headOwner: 'alice:evil' },
  ])('rejects a binding that could carry URL syntax %#', (bad) => {
    const { title, body } = content();
    expect(() => compareLink(prIntent, bad as PrBinding, title, body)).toThrow(HandoffError);
  });

  it('the marker is mandatory, single, and carries contribution + intent id only', () => {
    const marker = handoffMarker(prIntent);
    expect(marker).toBe(
      `<!-- ai-dossier:ztfc contribution=contribution-1 intent=${handoffIntentId(prIntent)} op=pr_create -->`
    );
    expect(handoffIntentId(prIntent)).toMatch(/^[a-f0-9]{32}$/u);
    expect(handoffMarker({ ...prIntent, candidateSha: OTHER })).not.toBe(marker);
    expect(() => compareLink(prIntent, binding, 'Fix', 'no marker')).toThrow('marker_required');
    expect(() => compareLink(prIntent, binding, 'Fix', `${marker}\n${marker}`)).toThrow(
      'marker_required'
    );
    const otherMarker = handoffMarker({ ...prIntent, candidateSha: OTHER });
    expect(() => compareLink(prIntent, binding, 'Fix', otherMarker)).toThrow('marker_required');
    expect(() =>
      handoffMarker({ ...prIntent, target: 'up/proj ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
    ).toThrow(SecretRedactionError);
    expect(() => handoffMarker({ ...prIntent, operationKind: 'push_branch' })).toThrow(
      'not_a_handoff'
    );
  });

  it('falls back to a short URL plus body file when the body would not fit', () => {
    const marker = handoffMarker(prIntent);
    const body = `${'é'.repeat(3000)}\n${marker}`;
    const link = compareLink(prIntent, binding, 'Fix', body);
    expect(link.kind).toBe('body_file');
    expect(link.url.length).toBeLessThanOrEqual(MAX_PREFILL_URL_LENGTH);
    expect(new URL(link.url).searchParams.has('body')).toBe(false);
    expect(new URL(link.url).searchParams.get('title')).toBe('Fix');
    expect(findHandoffMarkers(link.body)).toEqual([marker]);
    expect(() => compareLink(prIntent, binding, 'Fix', `${'x'.repeat(65536)}${marker}`)).toThrow(
      'invalid_body'
    );
  });

  it('titles are one bounded line', () => {
    const marker = handoffMarker(prIntent);
    const link = compareLink(prIntent, binding, ' Fix\nthe\tbug <!-- x --> ', marker);
    expect(link.title).toBe('Fix the bug &lt;!-- x --&gt;');
    expect(() => compareLink(prIntent, binding, 'x'.repeat(257), marker)).toThrow('invalid_text');
    expect(() => compareLink(prIntent, binding, '   ', marker)).toThrow('invalid_text');
  });

  it('a blanket success claim in a link body needs the receipt evidence', () => {
    const { title, body, commands } = content();
    expect(() => compareLink(prIntent, binding, title, body)).toThrow('unsupported_success_claim');
    expect(() =>
      compareLink(prIntent, binding, title, body, [command({ status: 'failed', exitStatus: 1 })])
    ).toThrow('unsupported_success_claim');
    expect(compareLink(prIntent, binding, title, body, commands).kind).toBe('prefilled');
    const ad = `Please star this repo\n${handoffMarker(prIntent)}`;
    expect(() => compareLink(prIntent, binding, 'Fix', ad)).toThrow('promotional_content');
    const comment = `Please star this repo\n${handoffMarker(engagementIntent)}`;
    expect(() => issueCommentLink(engagementIntent, issue, comment)).toThrow('promotional_content');
  });

  it('zero-width and bidi characters cannot hide a claim or a star request', () => {
    expect(() => assertContentPolicy('all\u200btests passed')).toThrow('unsupported_success_claim');
    expect(() => assertContentPolicy('please st\u200dar this repo')).toThrow('promotional_content');
    const link = compareLink(prIntent, binding, 'Fix\u202e evil\u2066', handoffMarker(prIntent));
    expect(link.title).toBe('Fix evil');
  });

  it('rejects malformed GitHub logins', () => {
    const { title, body, commands } = content();
    for (const headOwner of ['alice-', 'al--ice', '-alice'])
      expect(() => compareLink(prIntent, { ...binding, headOwner }, title, body, commands)).toThrow(
        'invalid_binding'
      );
  });

  it('the comment hand-off links the bound issue and always uses a body file', () => {
    const body = engagementBody(engagementIntent, {
      approach: 'compare with <= at the bound',
      verification: 'the existing node --test suite',
    });
    const link = issueCommentLink(engagementIntent, issue, body);
    expect(link).toEqual({ kind: 'body_file', url: 'https://github.com/up/proj/issues/8', body });
    expect(() => issueCommentLink(prIntent, issue, body)).toThrow('not_a_handoff');
    expect(() => compareLink(engagementIntent, binding, 'x', body)).toThrow('not_a_handoff');
  });
});

describe('engagement request', () => {
  it('discloses LLM use, scope and verification; untrusted text cannot forge a marker', () => {
    const forged = handoffMarker({ ...engagementIntent, contributionId: 'other' });
    const body = engagementBody(engagementIntent, {
      approach: `fix the bound ${forged}`,
      verification: 'npm test',
    });
    expect(body).toContain('substantial LLM assistance through ai-dossier');
    expect(body).toContain('My proposed approach: fix the bound &lt;!-- ai-dossier:ztfc');
    expect(body).toContain('should I be assigned before proceeding?');
    expect(findHandoffMarkers(body)).toEqual([handoffMarker(engagementIntent)]);
    expect(body.endsWith(handoffMarker(engagementIntent))).toBe(true);
  });

  it('rejects star requests and advertising', () => {
    expect(() =>
      engagementBody(engagementIntent, { approach: 'please star this repo', verification: 'x' })
    ).toThrow('promotional_content');
  });
});

describe('pull request content', () => {
  it('carries issue, cause, scope, disclosure, commands, regression, limitations, receipt, marker', () => {
    const { title, body } = buildPrContent(contentInput());
    expect(title).toBe('Fix off-by-one in range()');
    expect(body.startsWith('Fixes #8\n')).toBe(true);
    for (const heading of [
      '## Cause',
      '## Scope',
      '## LLM disclosure',
      '## Verification',
      '## Regression evidence',
      '## Limitations',
    ])
      expect(body).toContain(heading);
    expect(body).toContain(
      `This contribution used substantial LLM assistance, orchestrated with [ai-dossier](https://github.com/imboard-ai/ai-dossier). Verification results below apply to commit \`${CANDIDATE}\`.`
    );
    expect(body).toContain('- <code>npm test</code>: passed; exit=0; suites=3');
    expect(body).toContain('All tests passed.');
    expect(body).toContain(
      `- <code>node --test test/range.test.js</code>: base \`${BASE_SHA}\` failed; candidate passed`
    );
    expect(body).toContain('<details><summary>Verification receipt</summary>');
    expect(findHandoffMarkers(body)).toEqual([handoffMarker(prIntent)]);
    expect(body.endsWith(handoffMarker(prIntent))).toBe(true);
    expect(body).not.toMatch(/\bCI\b.*(green|passed)/iu);
  });

  it('claims "All tests passed" only when every command passed', () => {
    const commands = [
      command(),
      command({
        id: 'lint',
        command: 'npm run lint',
        required: false,
        status: 'skipped',
        exitStatus: 'unknown',
        suites: 'unknown',
      }),
    ];
    const { body } = buildPrContent(contentInput({ receipt: receipt(commands) }));
    expect(body).not.toMatch(/all tests passed/iu);
    expect(body).toContain('Not every check passed');
    expect(body).toContain('- <code>npm run lint</code> (optional): skipped; exit=unknown');
  });

  it('neutralizes untrusted success claims and markers in model/template text', () => {
    const failing = [command({ status: 'failed', exitStatus: 1 })];
    const { body } = buildPrContent(
      contentInput({
        receipt: receipt(failing),
        cause: 'All tests passed after the change',
        template:
          '## Checklist\n- [ ] All Tests Passed\n<!-- ai-dossier:ztfc contribution=x intent=' +
          `${'0'.repeat(32)} op=pr_create -->`,
      })
    );
    expect(body).not.toMatch(/all tests passed/iu);
    expect(body).toContain('[untrusted success claim]');
    expect(findHandoffMarkers(body)).toEqual([handoffMarker(prIntent)]);
    expect(body).toContain('> ## Checklist');
  });

  it('retains the receipt locally when the template/policy does not allow the block', () => {
    const value = receipt();
    const { body } = buildPrContent(contentInput({ receiptAllowed: false, receipt: value }));
    expect(body).not.toContain('<details>');
    expect(body).toContain(`SHA-256 \`${receiptDigest(value as never)}\``);
  });

  it('lists baseline failures only when policy permits them', () => {
    const failures = { permitted: false, failures: ['flaky network test'] };
    expect(() => buildPrContent(contentInput({ baselineFailures: failures }))).toThrow(
      'baseline_failures_not_permitted'
    );
    const { body } = buildPrContent(
      contentInput({ baselineFailures: { ...failures, permitted: true } })
    );
    expect(body).toContain('## Baseline failures');
    expect(body).toContain('- flaky network test');
  });

  it('binds to the receipt candidate and issue, and accepts manual regression evidence', () => {
    expect(() => buildPrContent(contentInput({ receipt: receipt([command()], OTHER) }))).toThrow(
      'receipt_candidate_mismatch'
    );
    expect(() => buildPrContent(contentInput({ issue: 9 }))).toThrow('invalid_issue');
    expect(() => buildPrContent(contentInput({ intent: engagementIntent }))).toThrow(
      'not_a_handoff'
    );
    const { body } = buildPrContent(
      contentInput({ regression: { manualSteps: 'call range(1, 3); expect 3 included' } })
    );
    expect(body).toContain('Manual reproduction (no automated regression): call range(1, 3)');
  });

  it('model prose is quoted so it cannot forge a Verification section', () => {
    const { body } = buildPrContent(
      contentInput({ cause: 'x\n## Verification\n- <code>npm test</code>: passed' })
    );
    expect(body).toContain(
      '> x\n> ## Verification\n> - &lt;code&gt;'.replace('&lt;code&gt;', '<code>')
    );
    expect(body.match(/^## Verification$/gmu)).toHaveLength(1);
  });

  it('makes no blanket claim when no command is required', () => {
    const { body } = buildPrContent(
      contentInput({ receipt: receipt([command({ required: false })]) })
    );
    expect(body).not.toMatch(/all tests passed/iu);
  });

  it('rejects advertising anywhere in the content', () => {
    expect(() => buildPrContent(contentInput({ scope: 'Also, buy me a coffee!' }))).toThrow(
      'promotional_content'
    );
    expect(() => buildPrContent(contentInput({ title: 'Fix ⭐' }))).toThrow('promotional_content');
  });

  it('content policy: blanket success claims need every required command passed', () => {
    expect(() => assertContentPolicy('All tests passed')).toThrow('unsupported_success_claim');
    expect(() =>
      assertContentPolicy('All tests passed', [command({ status: 'failed', exitStatus: 1 })])
    ).toThrow('unsupported_success_claim');
    expect(() => assertContentPolicy('All tests passed', [command({ required: false })])).toThrow(
      'unsupported_success_claim'
    );
    expect(() => assertContentPolicy('All tests passed', [command()])).not.toThrow();
  });
});

describe('reconciliation reads', () => {
  const expected = {
    marker: handoffMarker(prIntent),
    contributor: 'alice',
    candidateSha: CANDIDATE,
  };

  it('anonymous reader sends no credential and refuses non-repository paths', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const read = anonymousReader(fetchImpl as unknown as typeof fetch);
    expect(await read('/repos/up/proj/pulls?state=all')).toEqual({ status: 200, body: [] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/up/proj/pulls?state=all');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(Object.keys(init.headers as object).map((h) => h.toLowerCase())).not.toContain(
      'authorization'
    );
    await expect(read('/user')).rejects.toThrow();
    const broken = anonymousReader(
      (async () => new Response('not json', { status: 502 })) as never
    );
    expect(await broken('/repos/x/y')).toEqual({ status: 502, body: null });
  });

  it('lists by head + base + state=all, never trusting a duplicate-PR refusal', async () => {
    const gh = github({ pulls: [] });
    expect(await reconcilePr(gh.read, binding, expected)).toEqual({ kind: 'absent' });
    expect(gh.calls).toEqual([
      '/repos/up/proj/pulls?state=all&head=alice%3Aztfc%2Ffix-8&base=main&per_page=100&page=1',
    ]);
  });

  it('one marked PR is found with URL, number and head SHA', async () => {
    const gh = github({ pulls: [pull()] });
    expect(await reconcilePr(gh.read, binding, expected)).toEqual({
      kind: 'found',
      url: 'https://github.com/up/proj/pull/5',
      number: 5,
      headSha: CANDIDATE,
      state: 'open',
      merged: false,
    });
  });

  it('closed-then-recreated: both PRs are listed with state=all and the match hands off', async () => {
    // GitHub's 422 only holds while the first PR is open; after a close a second create succeeds.
    const gh = github({ pulls: [pull({ number: 6 }), pull({ number: 5, state: 'closed' })] });
    expect(await reconcilePr(gh.read, binding, expected)).toEqual({
      kind: 'ambiguous',
      reason: 'multiple_matches',
    });
    // A closed single PR still counts: it is found, never treated as absent.
    const closed = github({ pulls: [pull({ state: 'closed' })] });
    expect(await reconcilePr(closed.read, binding, expected)).toMatchObject({
      kind: 'found',
      state: 'closed',
    });
  });

  it('a match without the marker, or by another author, hands off', async () => {
    for (const body of [null, 'edited body', `${expected.marker}${expected.marker}`])
      expect(
        await reconcilePr(github({ pulls: [pull({ body })] }).read, binding, expected)
      ).toEqual({
        kind: 'ambiguous',
        reason: 'marker_missing',
      });
    expect(
      await reconcilePr(github({ pulls: [pull({ author: 'mallory' })] }).read, binding, expected)
    ).toEqual({ kind: 'ambiguous', reason: 'foreign_author' });
  });

  it('a deleted fork (head.repo null) is never counted as submitted', async () => {
    const orphan = pull();
    const deleted = { ...orphan, head: { ...orphan.head, repo: null } };
    expect(await reconcilePr(github({ pulls: [deleted] }).read, binding, expected)).toEqual({
      kind: 'ambiguous',
      reason: 'fork_unverifiable',
    });
  });

  it('author logins compare case-insensitively', async () => {
    expect(
      await reconcilePr(github({ pulls: [pull({ author: 'ALICE' })] }).read, binding, expected)
    ).toMatchObject({ kind: 'found' });
  });

  it('a PR at another head SHA is a mismatch, never a verified claim', async () => {
    expect(
      await reconcilePr(github({ pulls: [pull({ sha: OTHER })] }).read, binding, expected)
    ).toEqual({ kind: 'head_mismatch', url: 'https://github.com/up/proj/pull/5', headSha: OTHER });
  });

  it('errors, malformed or out-of-filter listings are unknown', async () => {
    expect(await reconcilePr(github({ status: 403 }).read, binding, expected)).toEqual({
      kind: 'unknown',
    });
    const thrower: GitHubRead = async () => {
      throw new Error('offline');
    };
    expect(await reconcilePr(thrower, binding, expected)).toEqual({ kind: 'unknown' });
    expect(
      await reconcilePr(
        github({ pulls: [pull({ label: 'mallory:ztfc/fix-8' })] }).read,
        binding,
        expected
      )
    ).toEqual({ kind: 'unknown' });
    expect(await reconcilePr(github({ pulls: [{ number: 'x' }] }).read, binding, expected)).toEqual(
      {
        kind: 'unknown',
      }
    );
    const full = Array.from({ length: 1000 }, (_, i) => pull({ number: i + 1 }));
    expect(await reconcilePr(github({ pulls: full }).read, binding, expected)).toEqual({
      kind: 'unknown',
    });
  });

  it('pages through every result before deciding', async () => {
    const others = Array.from({ length: 100 }, (_, i) => comment(i + 1, 'unrelated'));
    const gh = github({
      comments: [...others, comment(500, `Request\n${handoffMarker(engagementIntent)}`)],
    });
    const found = await reconcileComment(gh.read, issue, {
      marker: handoffMarker(engagementIntent),
      contributor: 'alice',
    });
    expect(found).toEqual({
      kind: 'found',
      url: 'https://github.com/up/proj/issues/8#issuecomment-500',
      id: 500,
    });
    expect(gh.calls).toHaveLength(2);
  });

  it('engagement comment: missing, duplicated, or posted by someone else', async () => {
    const marker = handoffMarker(engagementIntent);
    const exp = { marker, contributor: 'alice' };
    expect(await reconcileComment(github({ comments: [] }).read, issue, exp)).toEqual({
      kind: 'absent',
    });
    expect(
      await reconcileComment(
        github({ comments: [comment(1, marker), comment(2, marker)] }).read,
        issue,
        exp
      )
    ).toEqual({ kind: 'ambiguous', reason: 'multiple_matches' });
    expect(
      await reconcileComment(github({ comments: [comment(1, marker, 'mallory')] }).read, issue, exp)
    ).toEqual({ kind: 'ambiguous', reason: 'foreign_author' });
    expect(await reconcileComment(github({ status: 500 }).read, issue, exp)).toEqual({
      kind: 'unknown',
    });
  });
});

describe('awaiting_contributor hand-off driver', () => {
  let dir: string;
  let journal: Journal;
  const journals: Journal[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
    journal = new Journal(path.join(dir, 'journal'));
    journals.push(journal);
  });
  afterEach(() => {
    for (const j of journals.splice(0)) j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The verified-push read-back is a stub here; the real adapter is exercised below. */
  function admission(overrides: Partial<HandoffAdmission> = {}): HandoffAdmission {
    return {
      policyFresh: async () => true,
      contributorVerified: async () => true,
      forkBindingVerified: async () => true,
      receiptValid: async (sha, digest) =>
        sha === CANDIDATE && digest === receiptDigest(receipt() as never),
      remoteBranchSha: async () => CANDIDATE,
      ...overrides,
    };
  }
  let clock = 0;
  const now = () => new Date(Date.parse(T) + ++clock * 1000).toISOString();
  function driver(
    read: GitHubRead,
    run: RunRecord = shipping,
    adm: HandoffAdmission = admission(),
    j: Journal = journal
  ) {
    return new HandoffDriver(
      j,
      { read, admission: adm, bodyDirectory: path.join(dir, 'bodies'), now },
      { run, contributionId: 'contribution-1' }
    );
  }
  const prRequest = () => ({ binding, content: contentInput() });

  it('scenario 16 (maintainer/S2): closure after implementation refuses publication with no link', async () => {
    const r = await freshnessRig();
    const p = r.probe({ contributor: 'alice' });
    expect(await p.policyFresh()).toBe(true);
    r.issue.state = 'closed';
    expect(await p.policyFresh()).toBe(false);
    const d = driver(github({ pulls: [] }).read, shipping, admission(p));
    const before = journal.read().length;
    await expect(d.issuePr(prRequest())).rejects.toThrow('admission_policy');
    expect(d.status()).toBeNull();
    expect(d.snapshot().run.state).toBe('shipping');
    expect(journal.read()).toHaveLength(before);
    expect(fs.existsSync(path.join(dir, 'bodies'))).toBe(false);
    expect(r.fake.calls.every((c) => c.method === 'GET' && c.token === undefined)).toBe(true);
  });

  it.each([
    'edited',
    'deleted',
  ])('refuses publication when the original invitation is %s', async (change) => {
    const r = await freshnessRig();
    const p = r.probe({
      contributor: 'alice',
      gated: { ...r.deps.gated, invitation: r.invitation },
    });
    expect(await p.policyFresh()).toBe(true);
    if (change === 'deleted') r.comments.length = 0;
    else
      Object.assign(r.comments[0] as object, {
        body: 'Do not proceed.',
        updated_at: '2026-10-06T10:00:00Z',
      });
    const d = driver(github({ pulls: [] }).read, shipping, admission(p));
    const before = journal.read().length;
    await expect(d.issuePr(prRequest())).rejects.toThrow('admission_policy');
    expect(d.status()).toBeNull();
    expect(journal.read()).toHaveLength(before);
    expect(fs.existsSync(path.join(dir, 'bodies'))).toBe(false);
  });

  it('issues the prefilled PR link durably and enters awaiting_contributor', async () => {
    const gh = github({ pulls: [] });
    const d = driver(gh.read);
    const outcome = await d.issuePr(prRequest());
    expect(outcome.kind).toBe('awaiting_contributor');
    const status = d.status();
    expect(status).toMatchObject({
      state: 'awaiting_contributor',
      operation: 'pr_create',
      linkKind: 'prefilled',
      author: 'alice',
      submits: `Pull request to up/proj:main from alice:ztfc/fix-8 at ${CANDIDATE}`,
    });
    expect(
      status?.link.startsWith(
        'https://github.com/up/proj/compare/main...alice:ztfc/fix-8?expand=1&title='
      )
    ).toBe(true);
    expect(status?.nextPermittedAction).toContain(
      'submit it from your own account (alice), as its author'
    );
    expect(renderHandoffStatus(status as never)).toContain('author: "alice"');
    expect(d.snapshot().run.state).toBe('awaiting_contributor');
    const body = fs.readFileSync(status?.bodyFile as string, 'utf8');
    expect(body).toBe(buildPrContent(contentInput()).body);
    expect(fs.statSync(status?.bodyFile as string).mode & 0o777).toBe(0o600);
    // Reads only: the pre-issue reconciliation, no write of any kind.
    expect(gh.calls).toHaveLength(1);
    expect(journal.read().map((e) => (e as { type: string }).type)).toEqual([
      'handoff_run',
      'link_issued',
    ]);
  });

  it.each([
    ['policy', { policyFresh: async () => false }],
    ['contributor', { contributorVerified: async () => false }],
    ['fork_binding', { forkBindingVerified: async () => false }],
    ['receipt', { receiptValid: async () => false }],
    ['remote_sha', { remoteBranchSha: async () => OTHER }],
    ['remote_sha', { remoteBranchSha: async () => null }],
    [
      'policy',
      {
        policyFresh: async () => {
          throw new Error('offline');
        },
      },
    ],
  ] as [
    string,
    Partial<HandoffAdmission>,
  ][])('no link without admission: %s', async (name, override) => {
    const gh = github({ pulls: [] });
    const d = driver(gh.read, shipping, admission(override));
    await expect(d.issuePr(prRequest())).rejects.toThrow(`admission_${name}`);
    expect(d.status()).toBeNull();
    expect(d.snapshot().run.state).toBe('shipping');
    expect(journal.read()).toHaveLength(1);
  });

  /** The production adapter (#1066): `ForkPusher.handoffReadBack` over a fork ref fake. */
  function pusherReadBack(remote: string | null, verified: string | null) {
    const fork = { repositoryId: 4242, owner: 'alice', repo: 'proj' };
    const target = forkTarget(fork, binding.branch);
    const ledger = verified
      ? [
          {
            v: 1,
            type: 'push_verified',
            key: 'k',
            repositoryId: fork.repositoryId,
            branch: binding.branch,
            remoteSha: verified,
          },
        ]
      : [];
    const pusher = new ForkPusher({
      broker: { withForkPush: async () => Promise.reject(new Error('no push here')) },
      read: async (p) =>
        p === '/repos/alice/proj'
          ? { status: 200, body: { id: fork.repositoryId } }
          : remote
            ? {
                status: 200,
                body: {
                  ref: `refs/heads/${binding.branch}`,
                  object: { type: 'commit', sha: remote },
                },
              }
            : { status: 404, body: null },
      fork,
      ledger: { read: () => ledger, append: () => undefined },
      trustedControllerKey: 'unused',
      nonces: {} as never,
      authorize: async () => Promise.reject(new Error('no authorization here')),
    });
    return pusher.handoffReadBack(target);
  }

  it.each([
    ['another verified SHA', OTHER, OTHER],
    ['an unverified SHA', CANDIDATE, null],
    ['an absent branch', null, CANDIDATE],
  ] as const)('the real read-back blocks the link on %s', async (_name, remote, verified) => {
    const d = driver(
      github({ pulls: [] }).read,
      shipping,
      admission({ remoteBranchSha: pusherReadBack(remote, verified) })
    );
    await expect(d.issuePr(prRequest())).rejects.toThrow('admission_remote_sha');
    expect(d.status()).toBeNull();
    expect(journal.read()).toHaveLength(1);
  });

  it('the real read-back admits the verified candidate', async () => {
    const d = driver(
      github({ pulls: [] }).read,
      shipping,
      admission({ remoteBranchSha: pusherReadBack(CANDIDATE, CANDIDATE) })
    );
    expect((await d.issuePr(prRequest())).kind).toBe('awaiting_contributor');
  });

  it('never issues while a matching PR exists in any state, or when GitHub is unreadable', async () => {
    const closed = driver(github({ pulls: [pull({ state: 'closed', body: 'no marker' })] }).read);
    await expect(closed.issuePr(prRequest())).rejects.toThrow('existing_submission');
    expect(closed.status()).toBeNull();
    journal.close();
    const j2 = new Journal(path.join(dir, 'journal-2'));
    journals.push(j2);
    const down = driver(github({ status: 503 }).read, shipping, admission(), j2);
    await expect(down.issuePr(prRequest())).rejects.toThrow('reconciliation_unavailable');
  });

  it('requires the bound target, the right phase and a hand-off operation', async () => {
    const d = driver(github({ pulls: [] }).read);
    await expect(
      d.issuePr({
        ...prRequest(),
        binding: { ...binding, upstream: { owner: 'other', repo: 'proj' } },
      })
    ).rejects.toThrow('invalid_binding');
    await expect(
      d.issuePr({ ...prRequest(), binding: { ...binding, headOwner: 'mallory' } })
    ).rejects.toThrow('invalid_binding');
    await expect(
      d.issuePr({
        binding,
        content: contentInput({ intent: { ...prIntent, contributionId: 'other' } }),
      })
    ).rejects.toThrow('invalid_contribution');
    await expect(
      d.issueEngagement({ intent: engagementIntent, binding: issue, body: 'x' })
    ).rejects.toThrow('admission_state');
  });

  it('resume reconciles first; absent or unreadable keeps waiting with the same link, no reminders', async () => {
    let gh = github({ pulls: [] });
    const d = driver((p) => gh.read(p));
    await d.issuePr(prRequest());
    const link = d.status()?.link;
    const events = journal.read().length;
    for (const routes of [{ pulls: [] }, { status: 502 }]) {
      gh = github(routes);
      const outcome = (await d.resume()) as Extract<
        HandoffOutcome,
        { kind: 'awaiting_contributor' }
      >;
      expect(outcome.kind).toBe('awaiting_contributor');
      expect(outcome.reconciliation).toBe('status' in routes ? 'unknown' : 'absent');
      expect(outcome.status.link).toBe(link);
    }
    // Asking again returns the pending hand-off; no second link is issued.
    expect((await d.issuePr(prRequest())).kind).toBe('awaiting_contributor');
    expect(journal.read()).toHaveLength(events);
  });

  it('observed PR reaches submitted with CI pending, never green; survives a restart', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    journal.close();
    const reopened = new Journal(path.join(dir, 'journal'));
    journals.push(reopened);
    const afterRun = d.snapshot().run;
    const gh = github({ pulls: [pull()] });
    const resumed = driver(gh.read, afterRun, admission(), reopened);
    expect(resumed.status()?.link).toBe(d.status()?.link);
    expect(await resumed.resume()).toEqual({
      kind: 'observed',
      operation: 'pr_create',
      url: 'https://github.com/up/proj/pull/5',
      prState: 'open',
      number: 5,
      headSha: CANDIDATE,
      ci: 'pending',
    });
    expect([...resumed.snapshot().handoffs.values()][0]).toMatchObject({
      status: 'observed',
      artifactRef: 'https://github.com/up/proj/pull/5',
      number: 5,
      headSha: CANDIDATE,
      prState: 'open',
    });
    expect(resumed.snapshot().run.state).toBe('submitted');
    expect(resumed.snapshot().run.reasonCode).toBe(ReasonCode.PublicationObserved);
    expect(resumed.status()).toBeNull();
    expect(await resumed.resume()).toBeNull();
    // A later request for the same intent reports the observation; it never issues again.
    expect(await resumed.issuePr(prRequest())).toMatchObject({
      kind: 'observed',
      number: 5,
      ci: 'unknown',
    });
    expect(replayHandoffs(reopened.read()).handoffs.size).toBe(1);
  });

  it('a merged or closed observed PR reports CI unknown', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    journal.close();
    const reopened = new Journal(path.join(dir, 'journal'));
    journals.push(reopened);
    const r = driver(
      github({ pulls: [pull({ state: 'closed', merged_at: T })] }).read,
      d.snapshot().run,
      admission(),
      reopened
    );
    expect(await r.resume()).toMatchObject({ kind: 'observed', prState: 'merged', ci: 'unknown' });
  });

  it('a head SHA other than the verified candidate blocks', async () => {
    let gh = github({ pulls: [] });
    const d = driver((p) => gh.read(p));
    await d.issuePr(prRequest());
    gh = github({ pulls: [pull({ sha: OTHER })] });
    const reason = 'unexpected_head_sha';
    expect(await d.resume()).toEqual({ kind: 'blocked', reason });
    expect(d.snapshot().run.state).toBe('blocked');
    expect(await d.issuePr(prRequest())).toEqual({ kind: 'blocked', reason });
  });

  it.each([
    [
      'two PRs (submitted twice)',
      { pulls: [pull({ number: 6 }), pull({ number: 5, state: 'closed' })] },
      'multiple_matches',
    ],
    ['marker removed', { pulls: [pull({ body: 'edited' })] }, 'marker_missing'],
    ['submitted by another account', { pulls: [pull({ author: 'mallory' })] }, 'foreign_author'],
    [
      'fork deleted (head no longer resolves)',
      { basePulls: [pull({ label: 'unknown:ztfc/fix-8' })] },
      'fork_unverifiable',
    ],
  ])('%s hands off: waits for a person, issues no link, re-reconciles', async (_name, routes, reason) => {
    let gh = github({ pulls: [] });
    const d = driver((p) => gh.read(p));
    await d.issuePr(prRequest());
    const events = journal.read().length;
    gh = github(routes);
    const outcome = (await d.resume()) as Extract<HandoffOutcome, { kind: 'awaiting_contributor' }>;
    expect(outcome).toMatchObject({
      kind: 'awaiting_contributor',
      reconciliation: 'ambiguous',
      ambiguity: reason,
    });
    expect(outcome.status.nextPermittedAction).toContain('No new link will be issued');
    expect(d.snapshot().run.state).toBe('awaiting_contributor');
    expect(journal.read()).toHaveLength(events);
    // Once a person leaves exactly one marked PR, resume observes it.
    gh = github({ pulls: [pull()] });
    expect(await d.resume()).toMatchObject({ kind: 'observed', number: 5 });
  });

  it('the base-only scan stops at the issue time and is skipped before issuance', async () => {
    let gh = github({ pulls: [], basePulls: [pull({ created_at: '2026-10-05T00:00:00.000Z' })] });
    const d = driver((p) => gh.read(p));
    await d.issuePr(prRequest());
    expect(gh.calls.some((c) => c.includes('direction=desc'))).toBe(false);
    expect(await d.resume()).toMatchObject({ reconciliation: 'absent' });
    expect(gh.calls.at(-1)).toBe(
      '/repos/up/proj/pulls?state=all&base=main&sort=created&direction=desc&per_page=100&page=1'
    );
    gh = github({ status: 500 });
    expect(await d.resume()).toMatchObject({ reconciliation: 'unknown' });
  });

  it('engagement: at most one disclosed request, reconciled by marker on the issue', async () => {
    let gh = github({ comments: [] });
    const d = driver((p) => gh.read(p), gating);
    const body = engagementBody(engagementIntent, {
      approach: 'compare with <=',
      verification: 'npm test',
    });
    const first = await d.issueEngagement({ intent: engagementIntent, binding: issue, body });
    expect(first.kind).toBe('awaiting_contributor');
    expect(d.status()).toMatchObject({
      operation: 'engagement_comment',
      link: 'https://github.com/up/proj/issues/8',
      linkKind: 'body_file',
      submits: 'Comment on up/proj#8 asking to work on the issue',
    });
    expect(d.status()?.nextPermittedAction).toContain('Paste the prepared body from');
    // Repeated resume before the comment is posted issues nothing new.
    expect((await d.issueEngagement({ intent: engagementIntent, binding: issue, body })).kind).toBe(
      'awaiting_contributor'
    );
    gh = github({ comments: [comment(42, `edited by alice\n${handoffMarker(engagementIntent)}`)] });
    expect(await d.resume()).toEqual({
      kind: 'observed',
      operation: 'engagement_comment',
      url: 'https://github.com/up/proj/issues/8#issuecomment-42',
      ci: 'unknown',
    });
    expect(d.snapshot().run.state).toBe('awaiting_maintainer');
    // A different engagement intent for the same contribution still gets no second request.
    const again = await d.issueEngagement({
      intent: { ...engagementIntent, target: 'up/proj#8 retry' },
      binding: issue,
      body,
    });
    expect(again.kind).toBe('observed');
    expect(
      journal.read().filter((e) => (e as { type: string }).type === 'link_issued')
    ).toHaveLength(1);
  });

  it('engagement comment duplicated by the contributor hands off', async () => {
    let gh = github({ comments: [] });
    const d = driver((p) => gh.read(p), gating);
    const body = engagementBody(engagementIntent, { approach: 'a', verification: 'b' });
    await d.issueEngagement({ intent: engagementIntent, binding: issue, body });
    const marker = handoffMarker(engagementIntent);
    gh = github({ comments: [comment(1, marker), comment(2, marker)] });
    expect(await d.resume()).toMatchObject({
      kind: 'awaiting_contributor',
      reconciliation: 'ambiguous',
      ambiguity: 'multiple_matches',
    });
    expect(d.snapshot().run.state).toBe('awaiting_contributor');
    // Only comments updated since the link was issued are read.
    expect(gh.calls[0]).toMatch(
      /comments\?since=2026-10-06T00%3A00%3A\d\d\.000Z&per_page=100&page=1$/u
    );
  });

  it('replay fails closed on a redirected link or a skipped transition', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    const events = journal.read() as Record<string, unknown>[];
    const issued = events[1];
    const redirected = { ...issued, link: String(issued.link).replace('/up/proj/', '/evil/proj/') };
    expect(() => replayHandoffs([events[0], redirected])).toThrow(HandoffError);
    const rebound = { ...issued, binding: { ...binding, headOwner: 'mallory' } };
    expect(() => replayHandoffs([events[0], rebound])).toThrow(HandoffError);
    const skipped = { ...issued, run: shipping };
    expect(() => replayHandoffs([events[0], skipped])).toThrow();
    expect(() => replayHandoffs([events[0], issued, issued])).toThrow(HandoffError);
    expect(() =>
      replayHandoffs([events[0], { v: 1, type: 'handoff_observed', key: 'x', run: shipping }])
    ).toThrow();
    expect(() => replayHandoffs([])).toThrow(HandoffError);
    expect(replayHandoffs(events).run.state).toBe('awaiting_contributor');
  });

  it('replay rejects any tampered link, body, body file or issue number', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    const [start, issued] = journal.read() as Record<string, unknown>[];
    const link = String(issued.link);
    for (const tampered of [
      { link: `${link}&template=evil.md` },
      { link: link.replace('title=', 'title=Other') },
      { body: `${issued.body} more` },
      { bodyDigest: 'e'.repeat(64) },
      { bodyFile: '/tmp/elsewhere.md' },
      { bodyFile: 'relative/x.md' },
      { linkKind: 'body_file' },
    ])
      expect(() => replayHandoffs([start, { ...issued, ...tampered }])).toThrow();
  });

  it('replay rejects an engagement link to another issue or path', async () => {
    const d = driver(github({ comments: [] }).read, gating);
    const body = engagementBody(engagementIntent, { approach: 'a', verification: 'b' });
    await d.issueEngagement({ intent: engagementIntent, binding: issue, body });
    const [start, issued] = journal.read() as Record<string, unknown>[];
    for (const link of [
      'https://github.com/up/proj/issues/80',
      'https://github.com/up/proj/issues/8/../../../evil/repo/issues/1',
    ])
      expect(() => replayHandoffs([start, { ...issued, link }])).toThrow(HandoffError);
  });

  it('replay rejects a link issued from the wrong phase', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    const [start, issued] = journal.read() as Record<string, unknown>[];
    const fromGating = { ...start, run: gating };
    expect(() =>
      replayHandoffs([
        fromGating,
        { ...issued, run: transitionRun(gating, ReasonCode.ContributorHandoff, T) },
      ])
    ).toThrow(HandoffError);
  });

  it('only the driver records a hand-off observation; body files stay in their directory', async () => {
    const d = driver(github({ pulls: [] }).read);
    await d.issuePr(prRequest());
    const forged = transitionRun(
      d.snapshot().run,
      ReasonCode.PublicationObserved,
      '2026-10-06T01:00:00.000Z'
    );
    expect(() => d.observeRun(forged)).toThrow(HandoffError);
    expect(d.snapshot().run.state).toBe('awaiting_contributor');
    journal.close();
    const reopened = new Journal(path.join(dir, 'journal'));
    journals.push(reopened);
    expect(
      () =>
        new HandoffDriver(
          reopened,
          {
            read: github({}).read,
            admission: admission(),
            bodyDirectory: path.join(dir, 'other'),
            now,
          },
          { run: d.snapshot().run, contributionId: 'contribution-1' }
        )
    ).toThrow(HandoffError);
  });

  it('a second journal on the same directory cannot exist, so two drivers cannot race', () => {
    expect(() => new Journal(path.join(dir, 'journal'))).toThrow(JournalError);
  });

  it('builds the PR content itself: content policy and receipt binding apply', async () => {
    const d = driver(github({ pulls: [] }).read);
    await expect(
      d.issuePr({ binding, content: contentInput({ scope: 'Please star this repo' }) })
    ).rejects.toThrow('promotional_content');
    const other = receipt([command({ id: 'other' })]);
    await expect(d.issuePr({ binding, content: contentInput({ receipt: other }) })).rejects.toThrow(
      'admission_receipt'
    );
    expect(d.status()).toBeNull();
  });

  it('one driver per journal; a cancelled run stops reconciliation', async () => {
    const d = driver(github({ pulls: [] }).read);
    expect(() => driver(github({}).read)).toThrow('journal_in_use');
    await d.issuePr(prRequest());
    const cancelled = transitionRun(
      d.snapshot().run,
      ReasonCode.UserCancelled,
      '2026-10-06T01:00:00.000Z'
    );
    d.observeRun(cancelled);
    expect(d.snapshot().run.state).toBe('cancelled');
    expect(await d.resume()).toBeNull();
    await expect(d.issuePr(prRequest())).rejects.toThrow('admission_state');
  });
});
