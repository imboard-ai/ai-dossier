import { describe, expect, it } from 'vitest';
import { anonymousReader } from '../../github/reconcile';
import { policyDigest } from '../classify';
import { createFreshnessProbe, FreshnessUnavailableError } from '../freshness';
import { checkInvitation } from '../invitation';
import { FRESH_HEAD, FRESH_PREFIX, freshActor, freshnessRig } from './freshness-rig';

describe('credential-free permission freshness', () => {
  it('records actual anonymous transport requests without credentials or writes', async () => {
    const r = await freshnessRig();
    const requests: Request[] = [];
    const read = anonymousReader(async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      const route = new URL(request.url);
      const response = await r.read(route.pathname + route.search);
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    const p = r.probe({ read, gated: { ...r.deps.gated, invitation: r.invitation } });
    expect(await p.policyFresh()).toBe(true);
    r.revoke();
    expect(await p.policyFresh()).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      expect(request.body).toBeNull();
      expect(new URL(request.url).origin).toBe('https://api.github.com');
    }
  });
  it('reuses an unchanged assessed policy, reads anew, and freezes the report', async () => {
    const r = await freshnessRig();
    const p = r.probe();
    const report = await p.check();
    expect(report).toMatchObject({
      fresh: true,
      reasons: [],
      head: FRESH_HEAD,
      policyDigest: r.deps.gated.policyDigest,
    });
    expect(report.policy).toEqual(r.policy);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.reasons)).toBe(true);
    r.issue.state = 'closed';
    expect(await p.policyFresh()).toBe(false);
    expect(
      r.fake.calls.every((c) => c.method === 'GET' && c.token === undefined && c.body === undefined)
    ).toBe(true);
    expect(r.fake.tokens.size).toBe(0);
  });

  it.each(['closed', 'locked'])('reports issue_closed for %s', async (state) => {
    const r = await freshnessRig();
    if (state === 'closed') r.issue.state = 'closed';
    else r.issue.locked = true;
    expect(await r.probe().check()).toMatchObject({ fresh: false, reasons: ['issue_closed'] });
  });

  it.each([
    'No AI contributions.',
    'AI contributions welcome.',
  ])('reports policy_changed conservatively: %s', async (text) => {
    const r = await freshnessRig();
    r.setFile(text);
    expect(await r.probe().check()).toMatchObject({ fresh: false, reasons: ['policy_changed'] });
  });

  it('records a changed digest when the current AI policy still permits', async () => {
    const r = await freshnessRig();
    r.setFile('You must be assigned before opening a PR.');
    r.issue.assignees.push(freshActor('contributor'));
    const report = await r.probe().check();
    expect(report.fresh).toBe(true);
    expect(report.policy.ai).toBe('silent');
    expect(report.policyDigest).not.toBe(r.deps.gated.policyDigest);
  });

  it('blocks a newly required approval without an invitation', async () => {
    const r = await freshnessRig();
    r.setFile('AI contributions require approval.');
    expect(await r.probe().policyFresh()).toBe(false);
  });

  it('does not transfer an old invitation to a changed approval policy', async () => {
    const r = await freshnessRig();
    r.setFile('AI contributions require approval.');
    expect(
      await r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } }).check()
    ).toMatchObject({ fresh: false, reasons: ['policy_changed'] });
  });

  it('retains gated assignment requirements and refuses unresolved current ownership', async () => {
    const r = await freshnessRig();
    const policy = { ...r.policy, assignment: 'required' as const };
    const p = r.probe({
      gated: { ...r.deps.gated, policy, policyDigest: policyDigest(policy, []) },
    });
    r.setFile('Run the unit tests.');
    expect(await p.check()).toMatchObject({
      fresh: false,
      reasons: ['policy_changed', 'assignment_changed'],
    });
    expect(await r.probe().check()).toMatchObject({ fresh: false, reasons: ['policy_changed'] });
  });

  it.each([
    'edited',
    'missing',
    'author',
    'authority',
    'timestamp',
  ])('refuses an %s invitation source', async (kind) => {
    const r = await freshnessRig();
    const source = r.comments[0] as Record<string, unknown>;
    if (kind === 'missing') r.comments.length = 0;
    else if (kind === 'edited')
      Object.assign(source, { body: 'Do not proceed.', updated_at: '2026-10-06T10:00:00Z' });
    else if (kind === 'author') source.user = freshActor('other');
    else if (kind === 'authority') source.author_association = 'NONE';
    else source.created_at = '2026-10-06T08:00:00Z';
    await expect(
      r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } }).policyFresh()
    ).rejects.toThrow(FreshnessUnavailableError);
  });

  it('round-trips genuine comment and assignment invitation evidence, then blocks revocation', async () => {
    for (const assignment of [false, true]) {
      const r = await freshnessRig();
      if (assignment) {
        r.comments.length = 0;
        r.issue.assignees.push(freshActor('contributor'));
        r.timeline.push({
          id: 9,
          event: 'assigned',
          actor: freshActor('maintainer'),
          assignee: freshActor('contributor'),
          created_at: '2026-10-06T09:00:00Z',
          url: 'https://api.github.com/repos/up/proj/issues/events/9',
        });
      }
      const result = await checkInvitation(
        r.read,
        { upstream: r.deps.upstream, issue: 8 },
        {
          engagementCommentUrl: 'https://github.com/up/proj/issues/8#issuecomment-100',
          engagementAt: '2026-10-06T08:00:00.000Z',
          contributor: 'contributor',
          issueAuthor: 'reporter',
          policy: { digest: r.deps.gated.policyDigest, issueAuthorMayInvite: false },
          persist: () => {},
        }
      );
      expect(result.kind).toBe('invited');
      if (result.kind !== 'invited') throw new Error('Broken producer fixture');
      const p = r.probe({ gated: { ...r.deps.gated, invitation: result.evidence } });
      expect(await p.policyFresh()).toBe(true);
      r.revoke();
      expect(await p.check()).toMatchObject({ fresh: false, reasons: ['invitation_revoked'] });
    }
  });

  it('does not retain assignment permission once the contributor is no longer assigned', async () => {
    const r = await freshnessRig();
    r.timeline.push({
      id: 9,
      event: 'assigned',
      actor: freshActor('maintainer'),
      assignee: freshActor('contributor'),
      created_at: '2026-10-06T09:00:00Z',
      url: 'https://api.github.com/repos/up/proj/issues/events/9',
    });
    const p = r.probe({
      gated: {
        ...r.deps.gated,
        invitation: {
          ...r.invitation,
          association: 'ASSIGNMENT_EVENT',
          url: 'https://api.github.com/repos/up/proj/issues/events/9',
        },
      },
    });
    expect(await p.check()).toMatchObject({ fresh: false, reasons: ['invitation_revoked'] });
  });

  it('reports competing and required-but-missing assignments', async () => {
    const r = await freshnessRig();
    r.issue.assignees.push(freshActor('other'));
    expect(await r.probe().check()).toMatchObject({
      fresh: false,
      reasons: ['assignment_changed'],
    });
    r.issue.assignees.length = 0;
    const policy = { ...r.policy, assignment: 'required' as const };
    const p = r.probe({
      gated: { ...r.deps.gated, policy, policyDigest: policyDigest(policy, []) },
    });
    expect(await p.check()).toMatchObject({ fresh: false, reasons: ['assignment_changed'] });
    r.issue.assignees.push(freshActor('CONTRIBUTOR'));
    expect(await p.policyFresh()).toBe(true);
  });

  it('blocks another author, including a foreign-repository ownPr number collision', async () => {
    const r = await freshnessRig();
    r.addPull(5, 'other', 'foreign/proj');
    expect(await r.probe({ ownPr: { number: 5 } }).check()).toMatchObject({
      fresh: false,
      reasons: ['competing_fix'],
    });
  });

  it('permits the contributor own PR and ignores closed competing PRs', async () => {
    const r = await freshnessRig();
    r.addPull(5, 'contributor');
    r.addPull(6, 'other');
    r.set(`${FRESH_PREFIX}/pulls/6`, {
      number: 6,
      html_url: 'https://github.com/up/proj/pull/6',
      state: 'closed',
      merged_at: null,
      user: freshActor('other'),
    });
    expect(await r.probe({ ownPr: { number: 5 } }).policyFresh()).toBe(true);
  });

  it('reports invitation_revoked for a later authorized negative comment', async () => {
    const r = await freshnessRig();
    r.revoke();
    const p = r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } });
    expect(await p.check()).toMatchObject({ fresh: false, reasons: ['invitation_revoked'] });
    expect(await p.policyFresh()).toBe(false);
  });

  it('retains an invitation with no later answer or only an unauthorized decline', async () => {
    const r = await freshnessRig();
    const p = r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } });
    expect(await p.policyFresh()).toBe(true);
    r.revoke();
    Object.assign(r.comments[1] as object, { author_association: 'NONE' });
    expect(await p.policyFresh()).toBe(true);
  });

  it('throws for ambiguous permission instead of passing or silently retrying', async () => {
    const r = await freshnessRig();
    r.revoke();
    Object.assign(r.comments[1] as object, { body: 'Maybe later.' });
    await expect(
      r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } }).policyFresh()
    ).rejects.toThrow(FreshnessUnavailableError);
  });

  it.each(['private', 'archived', 'disabled'])('blocks repository %s', async (key) => {
    const r = await freshnessRig();
    Object.assign(r.repo, { [key]: true });
    expect(await r.probe().check()).toMatchObject({ fresh: false, reasons: ['issue_ineligible'] });
  });

  it('blocks non-bug eligibility', async () => {
    const r = await freshnessRig();
    r.issue.labels = [{ name: 'enhancement' }];
    expect(await r.probe().check()).toMatchObject({ fresh: false, reasons: ['issue_ineligible'] });
  });

  it('throws on every transport/read failure, including after known closure', async () => {
    const r = await freshnessRig();
    const gated = { ...r.deps.gated, invitation: r.invitation };
    await r.probe({ gated }).check();
    const paths = [...new Set(r.fake.calls.map((c) => c.path))];
    r.issue.state = 'closed';
    for (const path of paths) {
      for (const throwing of [true, false]) {
        let failures = 0;
        const p = r.probe({
          gated,
          read: async (route) => {
            if (route === path) {
              failures++;
              if (throwing) throw new Error('private transport detail');
              return { status: 503, body: null };
            }
            return r.read(route);
          },
        });
        await expect(p.policyFresh()).rejects.toThrow('Permission freshness unavailable');
        expect(failures).toBe(1);
      }
    }
  });

  it.each([
    { ref: 'refs/heads/wrong', object: { type: 'commit', sha: FRESH_HEAD } },
    { ref: 'refs/heads/main', object: { type: 'tree', sha: FRESH_HEAD } },
    { ref: 'refs/heads/main', object: { type: 'commit', sha: 'bad' } },
  ])('throws on an invalid default-head response', async (body) => {
    const r = await freshnessRig();
    r.set(`${FRESH_PREFIX}/git/ref/heads/main`, body);
    await expect(r.probe().check()).rejects.toThrow(FreshnessUnavailableError);
  });

  it('throws on truncated policy, malformed issue and truncated timeline', async () => {
    const r = await freshnessRig();
    r.set(r.contentPath('CONTRIBUTING.md'), { truncated: true });
    await expect(r.probe().check()).rejects.toThrow(FreshnessUnavailableError);
    r.set(r.contentPath('CONTRIBUTING.md'), null, 404);
    r.issue.state = 'unknown';
    await expect(r.probe().check()).rejects.toThrow(FreshnessUnavailableError);
    r.issue.state = 'open';
    r.timeline.push(...Array.from({ length: 101 }, () => ({ event: 'commented' })));
    await expect(r.probe().check()).rejects.toThrow(FreshnessUnavailableError);
  });

  it('snapshots controller bindings before calls and rejects malformed input', async () => {
    const r = await freshnessRig();
    const p = r.probe();
    Object.assign(r.deps.upstream, { owner: 'other' });
    expect(await p.policyFresh()).toBe(true);
    expect(() => createFreshnessProbe({ ...r.deps, contributor: 'bad/login' })).toThrow(
      FreshnessUnavailableError
    );
    expect(() =>
      r.probe({ gated: { ...r.deps.gated, policyDigest: ['a'] as unknown as string } })
    ).toThrow(FreshnessUnavailableError);
    expect(() => r.probe({ ownPr: { number: 0 } })).toThrow(FreshnessUnavailableError);
    expect(() =>
      r.probe({
        gated: { ...r.deps.gated, invitation: { ...r.invitation, policyDigest: 'b'.repeat(64) } },
      })
    ).toThrow(FreshnessUnavailableError);
  });
});
