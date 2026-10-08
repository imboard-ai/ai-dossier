import { describe, expect, it } from 'vitest';
import { policyDigest } from '../classify';
import { createFreshnessProbe, FreshnessUnavailableError } from '../freshness';
import { FRESH_HEAD, FRESH_PREFIX, freshActor, freshnessRig } from './freshness-rig';

describe('credential-free permission freshness', () => {
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
    r.setFile('Run the unit tests.');
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
    Object.assign(r.comments[0] as object, { author_association: 'NONE' });
    expect(await p.policyFresh()).toBe(true);
  });

  it('throws for ambiguous permission instead of passing or silently retrying', async () => {
    const r = await freshnessRig();
    r.revoke();
    Object.assign(r.comments[0] as object, { body: 'Maybe later.' });
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
