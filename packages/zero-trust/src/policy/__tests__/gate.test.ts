import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitHubFake } from '../../github/__tests__/github-fake';
import * as handoff from '../../github/handoff';
import { handoffMarker } from '../../github/handoff';
import { HandoffDriver } from '../../github/handoff-driver';
import { Journal } from '../../journal';
import { createRun, ReasonCode } from '../../state';
import { classifyPolicy, type PolicyAssessment } from '../classify';
import type { Eligibility } from '../eligibility';
import { engagementBody } from '../engagement';
import { decideGate, GATE_ROWS } from '../gate';

const policy: PolicyAssessment = {
  ai: 'silent',
  assignment: 'not_required',
  directPr: 'welcomed',
  draftRequired: false,
  receiptBlockAllowed: true,
  baselineFailuresPermitted: false,
  citations: [],
};
function eligible(): Exclude<Eligibility, { kind: 'unknown' }> {
  return {
    kind: 'eligible',
    reasons: [],
    evidenceDigest: 'd'.repeat(64),
    facts: {
      repositoryId: 1,
      fullName: 'up/proj',
      defaultBranch: 'main',
      public: true,
      archived: false,
      disabled: false,
      contributor: 'alice',
      pulls: [],
      events: [],
      issue: {
        number: 8,
        url: 'https://github.com/up/proj/issues/8',
        state: 'open',
        locked: false,
        isPullRequest: false,
        author: { login: 'reporter', url: 'https://github.com/reporter' },
        authorAssociation: 'NONE',
        labels: ['bug'],
        assignees: [],
        createdAt: '2026-10-06T00:00:00Z',
      },
    },
  };
}
const citation = {
  path: 'CONTRIBUTING.md',
  line: 1,
  ruleId: 'ai-ban-1',
  excerpt: 'No AI contributions.',
};
const rows: { id: string; p: Partial<PolicyAssessment>; e?: Eligibility; kind: string }[] = [
  { id: 'ai_banned', p: { ai: 'banned', citations: [citation] }, kind: 'terminate' },
  {
    id: 'ineligible',
    p: {},
    e: {
      ...eligible(),
      kind: 'ineligible',
      reasons: ['closed_issue'],
      reasonCode: ReasonCode.PolicyBlocked,
    },
    kind: 'ineligible',
  },
  { id: 'policy_refused', p: { reason: 'budget' }, kind: 'hand_off' },
  {
    id: 'eligibility_hand_off',
    p: {},
    e: { ...eligible(), kind: 'hand_off', reasons: ['competing_fix'] },
    kind: 'hand_off',
  },
  { id: 'ai_unclear', p: { ai: 'unclear' }, kind: 'hand_off' },
  { id: 'ownership_unclear', p: { assignment: 'unclear', directPr: 'unclear' }, kind: 'hand_off' },
  { id: 'ai_approval', p: { ai: 'requires_approval' }, kind: 'request_permission' },
  { id: 'assignment_required', p: { assignment: 'required' }, kind: 'request_permission' },
  { id: 'discussion_first', p: { directPr: 'discussion_first' }, kind: 'request_permission' },
  { id: 'proceed', p: {}, kind: 'proceed' },
];

describe('gate table', () => {
  it('refuses sparse evidence collections including assigned contributor plus an unknown assignee', () => {
    const e = eligible();
    for (const key of ['labels', 'assignees'])
      expect(
        decideGate(
          policy,
          { ...e, facts: { ...e.facts, issue: { ...e.facts.issue, [key]: new Array(1) } } },
          'alice'
        ).kind
      ).toBe('hand_off');
    const assignees = [{ login: 'alice', url: 'https://github.com/alice' }];
    assignees.length = 2;
    expect(
      decideGate(
        { ...policy, assignment: 'required' },
        { ...e, facts: { ...e.facts, issue: { ...e.facts.issue, assignees } } },
        'alice'
      ).kind
    ).toBe('hand_off');
  });
  it('cannot erase non-bug labels or accept an explicitly truncated policy', () => {
    const e = eligible();
    expect(
      decideGate(
        policy,
        { ...e, facts: { ...e.facts, issue: { ...e.facts.issue, labels: ['enhancement'] } } },
        'alice'
      )
    ).toEqual({ kind: 'hand_off', reasons: ['not_a_bug'] });
    expect(decideGate({ ...policy, truncated: true } as PolicyAssessment, e, 'alice').kind).toBe(
      'hand_off'
    );
    expect(decideGate({ ...policy, truncated: false } as PolicyAssessment, e, 'alice').kind).toBe(
      'proceed'
    );
  });
  it('refuses truncated collections and malformed event evidence', () => {
    const e = eligible();
    for (const key of ['pulls', 'events'])
      expect(
        decideGate(
          policy,
          { ...e, facts: { ...e.facts, [key]: Object.assign([], { truncated: true }) } },
          'alice'
        ).kind
      ).toBe('hand_off');
    for (const key of ['assignees', 'labels'])
      expect(
        decideGate(
          policy,
          {
            ...e,
            facts: {
              ...e.facts,
              issue: { ...e.facts.issue, [key]: Object.assign([], { truncated: true }) },
            },
          },
          'alice'
        ).kind
      ).toBe('hand_off');
    for (const events of [[null], [{ event: 'assigned', id: 1, createdAt: 'bad', actor: null }]])
      expect(
        decideGate(policy, { ...e, facts: { ...e.facts, events } } as Eligibility, 'alice').kind
      ).toBe('hand_off');
    expect(
      decideGate({ ...policy, citations: Object.assign([], { truncated: true }) }, e, 'alice').kind
    ).toBe('hand_off');
    const event = {
      event: 'assigned' as const,
      id: 1,
      createdAt: '2026-10-06T00:00:00Z',
      actor: { login: 'triager', url: 'https://github.com/triager' },
      assignee: { login: 'alice', url: 'https://github.com/alice' },
    };
    expect(decideGate(policy, { ...e, facts: { ...e.facts, events: [event] } }, 'alice').kind).toBe(
      'proceed'
    );
    const cross = {
      event: 'cross-referenced' as const,
      id: null,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      actor: null,
      pullUrl: 'https://github.com/up/proj/pull/9',
      identityFields: { number: 9, html_url: 'https://github.com/up/proj/pull/9' },
    };
    expect(decideGate(policy, { ...e, facts: { ...e.facts, events: [cross] } }, 'alice').kind).toBe(
      'proceed'
    );
  });
  it.each([
    'competing_assignee',
    'competing_fix',
    'own_pr_exists',
  ] as const)('cannot proceed with inconsistent eligible reason %s', (reason) => {
    expect(decideGate(policy, { ...eligible(), reasons: [reason] }, 'alice')).toEqual({
      kind: 'hand_off',
      reasons: [reason],
    });
  });
  it('keeps bug_unlabeled advisory and rejects malformed/incomplete facts', () => {
    expect(decideGate(policy, { ...eligible(), reasons: ['bug_unlabeled'] }, 'alice').kind).toBe(
      'proceed'
    );
    const e = eligible();
    for (const input of [
      { kind: 'eligible', reasons: [], facts: { contributor: 'alice', issue: { assignees: [] } } },
      { ...e, reasons: ['unknown'] },
      { ...e, evidenceDigest: ['d'.repeat(64)] },
      { ...e, facts: { ...e.facts, public: false } },
      { ...e, facts: { ...e.facts, pulls: null } },
      { ...e, facts: { ...e.facts, issue: { ...e.facts.issue, createdAt: 'bad' } } },
      { ...e, kind: 'hand_off' },
    ])
      expect(decideGate(policy, input as Eligibility, 'alice').kind).toBe('hand_off');
  });
  it('derives competing PR evidence even if a caller erased the reason', () => {
    const e = eligible();
    const pr = {
      number: 9,
      url: 'https://github.com/up/proj/pull/9',
      fullName: 'up/proj',
      state: 'open' as const,
      merged: false,
      author: { login: 'other', url: 'https://github.com/other' },
    };
    expect(decideGate(policy, { ...e, facts: { ...e.facts, pulls: [pr] } }, 'alice')).toEqual({
      kind: 'hand_off',
      reasons: ['competing_fix'],
    });
    expect(
      decideGate(
        policy,
        {
          ...e,
          facts: {
            ...e.facts,
            pulls: [{ ...pr, author: { login: 'alice', url: 'https://github.com/alice' } }],
          },
        },
        'alice'
      )
    ).toEqual({ kind: 'hand_off', reasons: ['own_pr_exists'] });
    expect(
      decideGate(
        policy,
        { ...e, facts: { ...e.facts, pulls: [{ ...pr, state: 'closed', merged: true }] } },
        'alice'
      ).kind
    ).toBe('proceed');
  });
  it('freezes every table row so consumers cannot weaken a ban', () => {
    for (const row of GATE_ROWS) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(() => Object.assign(row, { decide: () => ({ kind: 'proceed' }) })).toThrow();
    }
    expect(
      decideGate({ ...policy, ai: 'banned', citations: [citation] }, eligible(), 'alice').kind
    ).toBe('terminate');
  });
  it('has an independently specified case for every ordered row', () =>
    expect(GATE_ROWS.map((r) => r.id)).toEqual(rows.map((r) => r.id)));
  it.each(rows)('$id', ({ p, e, kind }) =>
    expect(decideGate({ ...policy, ...p }, e ?? eligible(), 'alice').kind).toBe(kind));
  it('cites a real parser ban before other restrictions', () => {
    const p = classifyPolicy([
      { path: 'CONTRIBUTING.md', content: 'No AI contributions.', sha: 'a'.repeat(40) },
    ]);
    expect(decideGate(p, eligible(), 'alice')).toMatchObject({
      kind: 'terminate',
      citation,
      reasonCode: ReasonCode.PolicyBlocked,
    });
  });
  it('missing or invalid ban evidence hands off', () => {
    expect(decideGate({ ...policy, ai: 'banned' }, eligible(), 'alice').kind).toBe('hand_off');
    expect(
      decideGate(
        { ...policy, ai: 'banned', citations: [{ ...citation, line: 0 }] },
        eligible(),
        'alice'
      ).kind
    ).toBe('hand_off');
  });
  it.each([
    'competing_assignee',
    'competing_fix',
    'own_pr_exists',
  ] as const)('ownership reason %s outranks approval', (reason) =>
    expect(
      decideGate(
        { ...policy, ai: 'requires_approval' },
        { ...eligible(), kind: 'hand_off', reasons: [reason] },
        'alice'
      )
    ).toEqual({ kind: 'hand_off', reasons: [reason] }));
  it.each([
    'welcomed',
    'disclosure_required',
    'silent',
  ] as const)('safe AI %s proceeds without an effect', (ai) =>
    expect(decideGate({ ...policy, ai }, eligible(), 'alice')).toEqual({ kind: 'proceed' }));
  it('assignment recognizes the contributor case-insensitively and refuses a competitor', () => {
    const e = eligible();
    const withAssignment = {
      ...e,
      facts: {
        ...e.facts,
        issue: {
          ...e.facts.issue,
          assignees: [{ login: 'ALICE', url: 'https://github.com/ALICE' }],
        },
      },
    };
    expect(decideGate({ ...policy, assignment: 'required' }, withAssignment, 'alice').kind).toBe(
      'proceed'
    );
    expect(
      decideGate(
        policy,
        {
          ...withAssignment,
          facts: {
            ...withAssignment.facts,
            issue: {
              ...withAssignment.facts.issue,
              assignees: [{ login: 'other', url: 'https://github.com/other' }],
            },
          },
        },
        'alice'
      ).kind
    ).toBe('hand_off');
  });
  it('unknown inputs and invalid identities fail closed', () => {
    for (const p of [
      null,
      { ...policy, ai: 'unknown' },
      { ...policy, assignment: 'unknown' },
      { ...policy, directPr: 'unknown' },
      { ...policy, reason: 'unknown' },
      { ...policy, citations: null },
      { ...policy, draftRequired: undefined },
      { ...policy, receiptBlockAllowed: 'unknown' },
      { ...policy, baselineFailuresPermitted: null },
    ])
      expect(decideGate(p as PolicyAssessment, eligible(), 'alice').kind).toBe('hand_off');
    expect(decideGate(policy, { kind: 'unknown' }, 'alice').kind).toBe('hand_off');
    expect(decideGate(policy, eligible(), 'other').kind).toBe('hand_off');
    expect(decideGate(policy, eligible(), 'invalid/name').kind).toBe('hand_off');
  });
  it('reuses the existing driver request across repeated gate/resume and journal reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-gate-'));
    try {
      const time = '2026-10-06T00:00:00.000Z';
      const fake = new GitHubFake(() => Date.parse(time));
      const intent = {
        contributionId: 'contribution-1',
        target: 'up/proj#8',
        operationKind: 'engagement_comment' as const,
        candidateSha: null,
      };
      const binding = { upstream: { owner: 'up', repo: 'proj' }, issue: 8 };
      const run = createRun(
        {
          runId: 'run-1',
          upstreamIssue: 'https://github.com/up/proj/issues/8',
          contributor: 'alice',
        },
        time
      );
      const read = async (p: string) => {
        const r = await fake.http({ method: 'GET', path: p, authorization: '' });
        return { status: r.status, body: r.json };
      };
      const deps = {
        read,
        bodyDirectory: path.join(dir, 'bodies'),
        now: () => time,
        admission: {
          policyFresh: async () => true,
          contributorVerified: async () => true,
          forkBindingVerified: async () => true,
          prBindingVerified: async () => true,
          commitPr: async () => true,
          finalizePr: () => true,
          receiptValid: async () => true,
          remoteBranchSha: async () => null,
        },
      };
      const journalPath = path.join(dir, 'handoff.jsonl');
      const journal = new Journal(journalPath);
      const driver = new HandoffDriver(journal, deps, {
        run,
        contributionId: intent.contributionId,
      });
      const body = `${engagementBody({ testCommand: 'npm test' })}\n\n${handoffMarker(intent)}`;
      const request = { intent, binding, body };
      const linkConstruction = vi.spyOn(handoff, 'issueCommentLink');
      expect(decideGate({ ...policy, assignment: 'required' }, eligible(), 'alice').kind).toBe(
        'request_permission'
      );
      fake.override('GET /repos/up/proj/issues/8/comments', { status: 200, json: [] }, 3);
      const first = await driver.issueEngagement(request);
      const second = await driver.issueEngagement(request);
      expect(decideGate({ ...policy, assignment: 'required' }, eligible(), 'alice').kind).toBe(
        'request_permission'
      );
      expect(first.kind).toBe('awaiting_contributor');
      expect(second).toMatchObject({ kind: 'awaiting_contributor', reconciliation: 'absent' });
      await driver.resume();
      const recordCount = journal.read().length;
      journal.close();
      const reopenedJournal = new Journal(journalPath);
      const reopened = new HandoffDriver(reopenedJournal, deps, {
        run: driver.snapshot().run,
        contributionId: intent.contributionId,
      });
      fake.override('GET /repos/up/proj/issues/8/comments', {
        status: 200,
        json: [
          {
            id: 11,
            html_url: 'https://github.com/up/proj/issues/8#issuecomment-11',
            body,
            user: { login: 'alice' },
            created_at: time,
          },
        ],
      });
      expect((await reopened.resume())?.kind).toBe('observed');
      expect(
        await reopened.issueEngagement({
          ...request,
          intent: { ...intent, contributionId: 'contribution-1' },
        })
      ).toMatchObject({ kind: 'observed' });
      expect(reopened.snapshot().handoffs.size).toBe(1);
      expect(reopenedJournal.read().length).toBe(recordCount + 1);
      expect(fake.calls.every((c) => c.method === 'GET' && c.token === undefined)).toBe(true);
      expect(fs.readdirSync(deps.bodyDirectory)).toHaveLength(1);
      expect(linkConstruction).toHaveBeenCalledTimes(1);
      linkConstruction.mockRestore();
      reopenedJournal.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
