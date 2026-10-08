import { afterEach, describe, expect, it, vi } from 'vitest';
import * as handoff from '../../github/handoff';
import { HandoffDriver } from '../../github/handoff-driver';
import { IntentDriver } from '../../intents';
import * as lifecycle from '../../state';
import type { PolicyAssessment } from '../classify';
import { assessIssue } from '../eligibility';
import { decideGate } from '../gate';
import { checkInvitation } from '../invitation';

afterEach(() => vi.restoreAllMocks());
function recordEffects() {
  return [
    vi.spyOn(handoff, 'issueCommentLink'),
    vi.spyOn(handoff, 'compareLink'),
    vi.spyOn(HandoffDriver.prototype, 'issueEngagement'),
    vi.spyOn(HandoffDriver.prototype, 'issuePr'),
    vi.spyOn(IntentDriver.prototype, 'execute'),
    vi.spyOn(lifecycle, 'transitionRun'),
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Forbidden network effect');
    }),
  ];
}

describe('policy APIs observe zero forbidden effects', () => {
  it('AC1 direct contribution never comments, issues a link, writes or transitions', async () => {
    const user = { login: 'reporter', html_url: 'https://github.com/reporter' };
    const eligible = await assessIssue(
      async (p) => ({
        status: 200,
        body: p.endsWith('/proj')
          ? {
              id: 1,
              full_name: 'up/proj',
              default_branch: 'main',
              private: false,
              archived: false,
              disabled: false,
            }
          : p.includes('/timeline?')
            ? []
            : {
                number: 8,
                html_url: 'https://github.com/up/proj/issues/8',
                state: 'open',
                locked: false,
                user,
                author_association: 'NONE',
                labels: [{ name: 'bug' }],
                assignees: [],
                created_at: '2026-10-06T00:00:00Z',
              },
      }),
      { owner: 'up', repo: 'proj', issue: 8 },
      'alice'
    );
    const policy: PolicyAssessment = {
      ai: 'welcomed',
      assignment: 'not_required',
      directPr: 'welcomed',
      draftRequired: false,
      receiptBlockAllowed: true,
      baselineFailuresPermitted: false,
      citations: [],
    };
    const effects = recordEffects();
    expect(decideGate(policy, eligible, 'alice')).toEqual({ kind: 'proceed' });
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });
  it('AC5 plan-first does not persist, transition or create a new link', async () => {
    const effects = recordEffects();
    const persist = vi.fn();
    const read = vi.fn(async (p: string) => ({
      status: 200,
      body: p.includes('/comments?')
        ? [
            {
              id: 12,
              html_url: 'https://github.com/up/proj/issues/8#issuecomment-12',
              user: { login: 'maintainer', html_url: 'https://github.com/maintainer' },
              author_association: 'MEMBER',
              body: 'Please post a plan first',
              created_at: '2026-10-06T00:01:00Z',
              updated_at: '2026-10-06T00:01:00Z',
            },
          ]
        : [],
    }));
    expect(
      await checkInvitation(
        read,
        { upstream: { owner: 'up', repo: 'proj' }, issue: 8 },
        {
          engagementCommentUrl: 'https://github.com/up/proj/issues/8#issuecomment-11',
          engagementAt: '2026-10-06T00:00:00.000Z',
          contributor: 'alice',
          issueAuthor: 'reporter',
          policy: { digest: 'd'.repeat(64), issueAuthorMayInvite: false },
          persist,
        }
      )
    ).toEqual({ kind: 'ambiguous', url: 'https://github.com/up/proj/issues/8#issuecomment-12' });
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls.every(([p]) => p.startsWith('/repos/up/proj/issues/8/'))).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });
});
