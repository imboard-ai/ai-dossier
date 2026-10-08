import { describe, expect, it, vi } from 'vitest';
import type { GitHubRead } from '../../github/reconcile';
import { ReasonCode } from '../../state';
import { checkInvitation, INVITATION_PAGE_LIMIT, type InvitationOptions } from '../invitation';

const binding = { upstream: { owner: 'up', repo: 'proj' }, issue: 8 };
const date = '2026-10-06T00:01:00Z';
const user = (login: string) => ({ login, html_url: `https://github.com/${login}` });
function comment(
  body = 'Go ahead!',
  association = 'MEMBER',
  login = 'maintainer',
  id = 12
): Record<string, unknown> {
  return {
    id,
    html_url: `https://github.com/up/proj/issues/8#issuecomment-${id}`,
    created_at: date,
    updated_at: date,
    user: user(login),
    author_association: association,
    body,
  };
}
function assignment(event = 'assigned', login = 'alice'): Record<string, unknown> {
  return {
    id: 42,
    event,
    url: 'https://api.github.com/repos/up/proj/issues/events/42',
    created_at: date,
    actor: user('triager'),
    assignee: user(login),
  };
}
function rig(comments: unknown[] = [], events: unknown[] = []) {
  const persist = vi.fn();
  const options: InvitationOptions = {
    engagementCommentUrl: 'https://github.com/up/proj/issues/8#issuecomment-11',
    engagementAt: '2026-10-06T00:00:00.000Z',
    contributor: 'alice',
    issueAuthor: 'reporter',
    policy: { digest: 'd'.repeat(64), issueAuthorMayInvite: false },
    persist,
  };
  const calls: string[] = [];
  const read: GitHubRead = async (p) => {
    calls.push(p);
    return { status: 200, body: p.includes('/comments?') ? comments : events };
  };
  return { options, persist, read, calls };
}

describe('explicit resume invitation', () => {
  it.each([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
  ])('accepts affirmative %s and persists exact authority evidence', async (association) => {
    const r = rig([comment('Go ahead!', association)]);
    const result = await checkInvitation(r.read, binding, r.options);
    const evidence = {
      actor: 'maintainer',
      association,
      url: 'https://github.com/up/proj/issues/8#issuecomment-12',
      policyDigest: 'd'.repeat(64),
      at: '2026-10-06T00:01:00.000Z',
    };
    expect(result).toEqual({ kind: 'invited', evidence, reasonCode: ReasonCode.MaintainerInvited });
    expect(r.persist).toHaveBeenCalledExactlyOnceWith(evidence);
    expect(r.calls).toEqual([
      '/repos/up/proj/issues/8/comments?per_page=100&page=1',
      '/repos/up/proj/issues/8/timeline?per_page=100&page=1',
    ]);
  });
  it.each([
    'CONTRIBUTOR',
    'NONE',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'MANNEQUIN',
  ])('does not infer authority from %s', async (association) => {
    const r = rig([comment('PR welcome', association)]);
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({ kind: 'waiting' });
    expect(r.persist).not.toHaveBeenCalled();
  });
  it('author permission requires an explicit repository-policy fact', async () => {
    const r = rig([comment('Feel free', 'NONE', 'reporter')]);
    expect((await checkInvitation(r.read, binding, r.options)).kind).toBe('waiting');
    expect(
      (
        await checkInvitation(r.read, binding, {
          ...r.options,
          policy: { ...r.options.policy, issueAuthorMayInvite: true },
        })
      ).kind
    ).toBe('invited');
  });
  it('assignment of contributor accepts API authorization evidence', async () => {
    const r = rig([], [assignment('assigned', 'ALICE')]);
    const result = await checkInvitation(r.read, binding, r.options);
    expect(result).toMatchObject({
      kind: 'invited',
      evidence: {
        actor: 'triager',
        association: 'ASSIGNMENT_EVENT',
        url: 'https://api.github.com/repos/up/proj/issues/events/42',
        at: '2026-10-06T00:01:00.000Z',
      },
    });
    expect(r.persist).toHaveBeenCalledOnce();
    const other = rig([], [assignment('assigned', 'other')]);
    expect((await checkInvitation(other.read, binding, other.options)).kind).toBe('waiting');
  });
  it.each([
    'PR welcome',
    'feel free to open a PR',
    'assigned you',
    'you are assigned',
    "you're assigned",
    'a PR is welcome',
    'PRs welcome',
  ])('accepts whole affirmative %s', async (body) => {
    const r = rig([comment(body)]);
    expect((await checkInvitation(r.read, binding, r.options)).kind).toBe('invited');
  });
  it.each([
    'not accepting',
    'not accepting PRs',
    'No AI',
    "won't fix",
    'will not fix',
    'please do not proceed',
    'do not proceed',
  ])('declines whole negative %s without invitation persistence', async (body) => {
    const r = rig([comment(body)]);
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({
      kind: 'declined',
      url: 'https://github.com/up/proj/issues/8#issuecomment-12',
      reasonCode: ReasonCode.UpstreamDeclined,
    });
    expect(r.persist).not.toHaveBeenCalled();
  });
  it.each([
    'Please post a plan first',
    'Do not go ahead',
    'Go ahead if approved',
    'Go ahead, but no AI',
    '> Go ahead',
    'Someone said "PR welcome"',
    'Feel free?',
    'PR welcome\nNo AI',
    '',
  ])('ambiguous authorized prose %s has no transition, link or persisted evidence', async (body) => {
    const r = rig([comment(body)]);
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({
      kind: 'ambiguous',
      url: 'https://github.com/up/proj/issues/8#issuecomment-12',
    });
    expect(r.persist).not.toHaveBeenCalled();
  });
  it('conflicts, unassignment and edited messages fail closed', async () => {
    for (const r of [
      rig([comment(), comment('No AI', 'OWNER', 'owner', 13)]),
      rig([comment()], [assignment('unassigned')]),
      rig([{ ...comment(), updated_at: '2026-10-06T00:02:00Z' }]),
    ]) {
      expect((await checkInvitation(r.read, binding, r.options)).kind).toBe('ambiguous');
      expect(r.persist).not.toHaveBeenCalled();
    }
  });
  it('ignores prior/equal-time responses, unrelated events, the engagement itself and self invitation', async () => {
    const r = rig(
      [
        { ...comment(), created_at: rDate(), updated_at: rDate() },
        comment('Go ahead', 'OWNER', 'alice', 13),
        comment('Go ahead', 'OWNER', 'maintainer', 11),
      ],
      [{ event: 'cross-referenced' }, { ...assignment(), created_at: rDate() }]
    );
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({ kind: 'waiting' });
  });
  it('awaits persistence and reports failure without granting a transition', async () => {
    const r = rig([comment()]);
    r.persist.mockRejectedValue(new Error('private detail'));
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({ kind: 'unknown' });
  });
  it.each([
    { id: 0 },
    { html_url: 'https://github.com/other/proj/issues/8#issuecomment-12' },
    { created_at: 'invalid' },
    { created_at: '2026-02-30T00:01:00Z' },
    { user: user('bad/name') },
    { user: { login: 'maintainer', html_url: 'https://github.com/other' } },
    { author_association: 'BOT' },
    { author_association: undefined },
    { body: null },
    { body: 'x'.repeat(65537) },
    { truncated: true },
    { body: `sk-proj-${'x'.repeat(48)}` },
  ])('malformed comment %j fails closed', async (patch) => {
    const r = rig([{ ...comment(), ...patch }]);
    expect(await checkInvitation(r.read, binding, r.options)).toEqual({ kind: 'unknown' });
    expect(r.persist).not.toHaveBeenCalled();
  });
  it.each([
    { actor: null },
    { assignee: null },
    { url: 'https://api.github.com/repos/other/proj/issues/events/42' },
    { id: 0 },
    { truncated: true },
    { event: null },
  ])('malformed event %j fails closed', async (patch) => {
    const r = rig([comment()], [{ ...assignment(), ...patch }]);
    expect((await checkInvitation(r.read, binding, r.options)).kind).toBe('unknown');
    expect(r.persist).not.toHaveBeenCalled();
  });
  it('read errors, non-array, oversized/truncated pages and duplicates never persist', async () => {
    for (const body of [
      null,
      {},
      Array(101).fill(comment()),
      Object.assign([comment()], { truncated: true }),
      [comment(), comment()],
    ]) {
      const r = rig();
      const read: GitHubRead = async () => ({ status: 200, body });
      expect((await checkInvitation(read, binding, r.options)).kind).toBe('unknown');
      expect(r.persist).not.toHaveBeenCalled();
    }
    const r = rig([comment()]);
    expect(
      (
        await checkInvitation(
          async () => {
            throw new Error('private');
          },
          binding,
          r.options
        )
      ).kind
    ).toBe('unknown');
    expect(
      (await checkInvitation(async () => ({ status: 403, body: [] }), binding, r.options)).kind
    ).toBe('unknown');
  });
  it('scans all pages and refuses the cap without persisting an early affirmative', async () => {
    const r = rig();
    const read: GitHubRead = async (p) => {
      const page = Number(new URL(p, 'https://api.github.com').searchParams.get('page'));
      return {
        status: 200,
        body: Array.from({ length: 100 }, (_, i) =>
          comment('Go ahead', 'MEMBER', 'maintainer', 100 * page + i)
        ),
      };
    };
    const spy = vi.fn(read);
    expect((await checkInvitation(spy, binding, r.options)).kind).toBe('unknown');
    expect(spy).toHaveBeenCalledTimes(INVITATION_PAGE_LIMIT);
    expect(r.persist).not.toHaveBeenCalled();
  });
  it('detaches a full comment page before a later reader mutates it', async () => {
    const r = rig();
    const first = Array.from({ length: 100 }, (_, i) =>
      comment('Go ahead', 'NONE', 'other', i + 100)
    );
    first[0] = comment();
    const read: GitHubRead = async (p) => {
      if (p.endsWith('page=1') && p.includes('/comments?')) return { status: 200, body: first };
      if (first[0]) first[0].body = 'No AI';
      first.length = 0;
      return { status: 200, body: [] };
    };
    expect((await checkInvitation(read, binding, r.options)).kind).toBe('invited');
    expect(r.persist).toHaveBeenCalledOnce();
  });
  it.each([
    { contributor: 'bad/name' },
    { issueAuthor: 'bad/name' },
    { engagementAt: 'bad' },
    { engagementCommentUrl: 'https://github.com/up/proj/issues/9#issuecomment-11' },
    { policy: { digest: 'bad', issueAuthorMayInvite: false } },
    { policy: { digest: 'd'.repeat(64), issueAuthorMayInvite: 'yes' } },
    { persist: null },
  ])('rejects invalid controller options %j before reading', async (patch) => {
    const r = rig([comment()]);
    expect(
      (await checkInvitation(r.read, binding, { ...r.options, ...patch } as InvitationOptions)).kind
    ).toBe('unknown');
    expect(r.calls).toHaveLength(0);
  });
});
function rDate() {
  return '2026-10-06T00:00:00Z';
}
