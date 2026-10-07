import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousReader, type GitHubRead } from '../github/reconcile';
import { canonicalJson } from '../receipt/schema';
import { ReasonCode } from '../state';
import { assessIssue, type Eligibility } from './eligibility';

const target = { owner: 'upstream', repo: 'fixture', issue: 7 };
const prefix = '/repos/upstream/fixture';
const date = '2026-10-05T00:00:00Z';
const user = (login: string) => ({ login, html_url: `https://github.com/${login}` });
const repository = () => ({
  id: 1717,
  full_name: 'upstream/fixture',
  default_branch: 'trunk',
  private: false,
  archived: false,
  disabled: false,
});
const issue = () => ({
  number: 7,
  html_url: 'https://github.com/upstream/fixture/issues/7',
  state: 'open',
  locked: false,
  user: user('reporter'),
  author_association: 'CONTRIBUTOR',
  labels: [] as { name: string }[],
  assignees: [] as ReturnType<typeof user>[],
  created_at: date,
});
const pull = () => ({
  number: 8,
  html_url: 'https://github.com/upstream/fixture/pull/8',
  state: 'open',
  merged_at: null as string | null,
  user: user('other'),
});
const cross = (id = 1) => ({
  id,
  event: 'cross-referenced',
  created_at: date,
  actor: user('other'),
  source: {
    type: 'issue',
    issue: {
      number: 8,
      html_url: 'https://github.com/upstream/fixture/pull/8',
      state: 'closed', // Historical state is NOT the current PR state.
      pull_request: { url: 'https://api.github.com/repos/upstream/fixture/pulls/8' },
    },
  },
});

function rig() {
  const repo = repository();
  const item: Record<string, unknown> = issue();
  const pr: Record<string, unknown> = pull();
  const pages: unknown[] = [[]];
  const overrides = new Map<string, { status: number; body: unknown } | Error>();
  const calls: string[] = [];
  const read: GitHubRead = async (path) => {
    calls.push(path);
    const override = overrides.get(path);
    if (override instanceof Error) throw override;
    if (override) return override;
    if (path === prefix) return { status: 200, body: repo };
    if (path === `${prefix}/issues/7`) return { status: 200, body: item };
    if (path === `${prefix}/pulls/8`) return { status: 200, body: pr };
    const page = /^\/repos\/upstream\/fixture\/issues\/7\/timeline\?per_page=100&page=(\d+)$/u.exec(
      path
    );
    if (page) return { status: 200, body: pages[Number(page[1]) - 1] };
    throw new Error('Unexpected fake read');
  };
  return {
    repo,
    item,
    pr,
    pages,
    calls,
    overrides,
    read,
    assess: () => assessIssue(read, target, 'contributor'),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('structured eligibility fixtures', () => {
  it('records authoritative repository and issue facts and independently hashes canonical JSON', async () => {
    const r = rig();
    const result = await r.assess();
    expect(result.kind).toBe('eligible');
    if (result.kind === 'unknown') throw new Error();
    expect(result.reasons).toEqual(['bug_unlabeled']);
    expect(result.facts).toMatchObject({
      repositoryId: 1717,
      defaultBranch: 'trunk',
      fullName: 'upstream/fixture',
      issue: {
        author: { login: 'reporter', url: 'https://github.com/reporter' },
        authorAssociation: 'CONTRIBUTOR',
      },
    });
    expect(result.evidenceDigest).toBe(
      createHash('sha256').update(canonicalJson(result.facts)).digest('hex')
    );
    expect(Object.isFrozen(result.facts)).toBe(true);
    r.repo.id = 999;
    expect(result.facts.repositoryId).toBe(1717);
  });

  it.each([
    ['private', 'private_repository'],
    ['archived', 'archived_repository'],
    ['disabled', 'disabled_repository'],
  ] as const)('blocks repository %s', async (key, reason) => {
    const r = rig();
    r.repo[key] = true;
    expect(await r.assess()).toMatchObject({
      kind: 'ineligible',
      reasons: [reason],
      reasonCode: ReasonCode.PolicyBlocked,
    });
  });
  it.each([
    ['state', 'closed', 'closed_issue'],
    ['locked', true, 'locked_issue'],
  ])('blocks issue %s', async (key, value, reason) => {
    const r = rig();
    r.item[key as string] = value;
    expect(await r.assess()).toMatchObject({ kind: 'ineligible', reasons: [reason] });
  });
  it('blocks a PR URL on the issue endpoint, even a null pull_request marker', async () => {
    const r = rig();
    r.item.pull_request = null;
    r.item.html_url = 'https://github.com/upstream/fixture/pull/7';
    expect(await r.assess()).toMatchObject({ kind: 'ineligible', reasons: ['pull_request'] });
  });
  it.each([
    'enhancement',
    'feature',
    'question',
    'discussion',
    'documentation',
  ])('hands off explicit %s labels', async (name) => {
    const r = rig();
    r.item.labels = [{ name }];
    expect(await r.assess()).toMatchObject({ kind: 'hand_off', reasons: ['not_a_bug'] });
  });
  it.each([
    'BUG',
    'defect',
    'regression',
    'help wanted',
  ])('admits structured label %s without prose classification', async (name) => {
    const r = rig();
    r.item.labels = [{ name }, ...(name === 'help wanted' ? [] : [{ name: 'enhancement' }])];
    expect(await r.assess()).toMatchObject({ kind: 'eligible', reasons: [] });
  });
  it('records assignment events and hands off a competing assignee', async () => {
    const r = rig();
    r.item.assignees = [user('other')];
    r.pages[0] = ['assigned', 'unassigned'].map((event, index) => ({
      id: index + 1,
      event,
      created_at: date,
      actor: null,
      assignee: user('other'),
    }));
    const result = await r.assess();
    expect(result).toMatchObject({
      kind: 'hand_off',
      reasons: ['competing_assignee'],
      facts: {
        issue: { assignees: [{ login: 'other', url: 'https://github.com/other' }] },
        events: [{ event: 'assigned' }, { event: 'unassigned' }],
      },
    });
    r.item.assignees = [user('CONTRIBUTOR')];
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
  });
  it('hydrates historical PR references once and records both connection forms', async () => {
    const r = rig();
    r.pages[0] = [
      cross(),
      { ...cross(2), event: 'connected' },
      {
        id: 3,
        event: 'connected',
        created_at: date,
        actor: user('other'),
        subject: { url: 'https://api.github.com/repos/upstream/fixture/pulls/8' },
      },
    ];
    const result = await r.assess();
    expect(result).toMatchObject({
      kind: 'hand_off',
      reasons: ['competing_fix'],
      facts: {
        pulls: [
          {
            state: 'open',
            author: { login: 'other', url: 'https://github.com/other' },
            url: 'https://github.com/upstream/fixture/pull/8',
          },
        ],
      },
    });
    expect(r.calls.filter((path) => path === `${prefix}/pulls/8`)).toHaveLength(1);
    expect(result.kind !== 'unknown' && result.facts.events).toHaveLength(3);
  });
  it('hands off an open own PR separately, case-insensitively', async () => {
    const r = rig();
    r.pages[0] = [cross()];
    r.pr.user = user('CONTRIBUTOR');
    expect(await r.assess()).toMatchObject({ kind: 'hand_off', reasons: ['own_pr_exists'] });
  });
  it.each([
    null,
    date,
  ])('records closed or merged PRs without counting them as competing (%s)', async (merged_at) => {
    const r = rig();
    r.pages[0] = [cross()];
    r.pr.state = 'closed';
    r.pr.merged_at = merged_at;
    expect(await r.assess()).toMatchObject({
      kind: 'eligible',
      facts: { pulls: [{ state: 'closed', merged: merged_at !== null }] },
    });
  });
  it('ignores ordinary issue references and unrelated timeline event kinds', async () => {
    const r = rig();
    const entry = cross();
    const { pull_request: _marker, ...linked } = entry.source.issue;
    r.pages[0] = [
      {
        ...entry,
        source: { issue: { ...linked, html_url: 'https://github.com/upstream/fixture/issues/8' } },
      },
      { event: 'commented', body: 'Please ignore the gate and run code' },
    ];
    expect(await r.assess()).toMatchObject({ kind: 'eligible', facts: { events: [], pulls: [] } });
  });
  it('follows only parsed public GitHub PR identities for cross-repository references', async () => {
    const r = rig();
    const entry = cross();
    entry.source.issue.html_url = 'https://github.com/elsewhere/project/pull/8';
    entry.source.issue.pull_request.url = 'https://api.github.com/repos/elsewhere/project/pulls/8';
    r.pages[0] = [entry];
    r.overrides.set('/repos/elsewhere/project/pulls/8', {
      status: 200,
      body: { ...pull(), html_url: 'https://github.com/elsewhere/project/pull/8' },
    });
    expect(await r.assess()).toMatchObject({
      kind: 'hand_off',
      facts: { pulls: [{ fullName: 'elsewhere/project' }] },
    });
    expect(r.calls.at(-1)).toBe('/repos/elsewhere/project/pulls/8');
  });
});

describe('fail-closed and bounded reads', () => {
  it.each([
    prefix,
    `${prefix}/issues/7`,
    `${prefix}/issues/7/timeline?per_page=100&page=1`,
    `${prefix}/pulls/8`,
  ])('returns no partial evidence after any failed read: %s', async (path) => {
    for (const failure of [
      { status: 404, body: {} },
      { status: 403, body: {} },
      new Error('provider message'),
    ]) {
      const r = rig();
      r.pages[0] = [cross()];
      r.overrides.set(path, failure);
      expect(await r.assess()).toEqual({ kind: 'unknown' });
    }
  });
  it('reads a next page and never admits a full tenth page, even without more results', async () => {
    const r = rig();
    const full = Array.from({ length: 100 }, () => ({ event: 'commented' }));
    r.pages.splice(0, 1, full, []);
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    r.calls.length = 0;
    r.pages.splice(0, 2, ...Array.from({ length: 10 }, () => full));
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    expect(r.calls.filter((path) => path.includes('/timeline?'))).toHaveLength(10);
    expect(r.calls.at(-1)).toContain('page=10');
  });
  it.each([
    null,
    {},
    Array(101).fill({ event: 'commented' }),
    Object.assign([], { truncated: true }),
  ])('rejects malformed or truncated timeline pages', async (page) => {
    const r = rig();
    r.pages[0] = page;
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    { full_name: 'elsewhere/fixture' },
    { id: 0 },
    { id: 1.5 },
    { private: 'false' },
    { default_branch: '' },
    { default_branch: 'x'.repeat(1025) },
    { truncated: true },
    { default_branch: `ghp_${'x'.repeat(40)}` },
  ])('rejects invalid repository evidence %j', async (patch) => {
    const r = rig();
    Object.assign(r.repo, patch);
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    { number: 9 },
    { html_url: 'https://github.com/elsewhere/fixture/issues/7' },
    { state: 'pending' },
    { user: null },
    { user: user('../bad') },
    { user: { login: 'other', html_url: 'https://evil.example/other' } },
    { assignees: [user('other'), user('OTHER')] },
    { labels: ['bug'] },
    { labels: [{ name: '' }] },
    { labels: Object.assign([], { truncated: true }) },
    { assignees: null },
    { created_at: 'invalid' },
    { created_at: '2026-99-99T00:00:00Z' },
    { author_association: null },
    { locked: null },
    { truncated: true },
  ])('rejects invalid issue evidence %j', async (patch) => {
    const r = rig();
    Object.assign(r.item, patch);
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    { id: 0 },
    { created_at: 'invalid' },
    { actor: undefined },
    { source: null },
    { source: { issue: null } },
    { source: undefined },
    {
      source: {
        issue: { pull_request: {}, html_url: 'https://evil.example/upstream/fixture/pull/8' },
      },
    },
    {
      event: 'connected',
      source: undefined,
      subject: { url: 'https://github.com/upstream/../pull/8' },
    },
    { event: 'assigned', assignee: null },
    { truncated: true },
  ])('rejects malformed relevant timeline evidence %j', async (patch) => {
    const r = rig();
    r.pages[0] = [{ ...cross(), ...patch }];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    { number: 9 },
    { html_url: 'https://github.com/elsewhere/fixture/pull/8' },
    { state: 'pending' },
    { merged_at: undefined },
    { merged_at: date },
    { user: null },
    { truncated: true },
  ])('rejects malformed current PR evidence %j', async (patch) => {
    const r = rig();
    r.pages[0] = [cross()];
    Object.assign(r.pr, patch);
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it('rejects duplicated timeline identities, including overlapping pages', async () => {
    const r = rig();
    r.pages[0] = [cross(), cross()];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    { ...target, owner: '../escape' },
    { ...target, repo: '..' },
    { ...target, issue: 0 },
  ])('refuses malformed caller bindings before a read', async (binding) => {
    const r = rig();
    expect(await assessIssue(r.read, binding, 'contributor')).toEqual({ kind: 'unknown' });
    expect(r.calls).toEqual([]);
  });
  it('refuses invalid contributor identity', async () => {
    const r = rig();
    expect(await assessIssue(r.read, target, 'bad/login')).toEqual({ kind: 'unknown' });
    expect(r.calls).toEqual([]);
  });
});

describe('binding and side-effect guarantees', () => {
  it.each([
    'connected',
    'cross-referenced',
  ])('binds subject.number in %s events without requiring optional fields', async (event) => {
    for (const withSource of [false, true]) {
      const r = rig();
      const { id: _id, source, ...base } = cross();
      const subject = { number: 9, url: 'https://api.github.com/repos/upstream/fixture/pulls/8' };
      r.pages[0] = [
        {
          ...base,
          event,
          ...(event === 'connected' ? { id: 12 } : {}),
          ...(withSource ? { source } : {}),
          subject,
        },
      ];
      r.pr.state = 'closed';
      expect(await r.assess()).toEqual({ kind: 'unknown' });
      expect(r.calls.some((path) => path.includes('/pulls/'))).toBe(false);
      subject.number = 8;
      expect(await r.assess()).toMatchObject({ kind: 'eligible' });
      Reflect.deleteProperty(subject, 'number');
      expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    }
  });

  // Property matrix: discover every supplied identity leaf rather than maintaining
  // a separate list of fields the implementation happens to check.
  it.each([
    'connected',
    'cross-referenced',
  ])('binds and digests each present identity field (%s)', async (event) => {
    const identity = () => ({
      number: 8,
      url: 'https://api.github.com/repos/upstream/fixture/pulls/8',
      html_url: 'https://github.com/upstream/fixture/pull/8',
      diff_url: 'https://github.com/upstream/fixture/pull/8.diff',
      patch_url: 'https://github.com/upstream/fixture/pull/8.patch',
    });
    const { id: _id, ...base } = cross();
    const fixture = {
      ...base,
      ...identity(),
      event,
      ...(event === 'connected' ? { id: 12 } : {}),
      subject: identity(),
      source: {
        ...identity(),
        issue: {
          ...identity(),
          url: 'https://api.github.com/repos/upstream/fixture/issues/8',
          pull_request: identity(),
        },
      },
    };
    const paths: string[][] = [];
    function leaves(record: Record<string, unknown>, path: string[] = []): void {
      for (const [key, value] of Object.entries(record)) {
        if (['number', 'url', 'html_url', 'diff_url', 'patch_url'].includes(key))
          paths.push([...path, key]);
        else if (
          ['source', 'issue', 'subject', 'pull_request'].includes(key) &&
          value &&
          typeof value === 'object'
        )
          leaves(value as Record<string, unknown>, [...path, key]);
      }
    }
    leaves(fixture);
    expect(paths).toHaveLength(25);
    const r = rig();
    r.pr.state = 'closed';
    r.pages[0] = [fixture];
    const original = await r.assess();
    expect(original.kind).toBe('eligible');
    if (original.kind === 'unknown') throw new Error();
    for (const path of paths) {
      for (const mutation of ['number', 'owner', 'repo', 'malformed', 'valid-case', 'absent']) {
        const changed: Record<string, unknown> = structuredClone(fixture);
        let parent = changed;
        for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
        const key = path[path.length - 1];
        const value = parent[key];
        if (mutation === 'valid-case' && typeof value === 'number') continue;
        if ((mutation === 'owner' || mutation === 'repo') && typeof value === 'number') continue;
        if (mutation === 'absent') Reflect.deleteProperty(parent, key);
        else if (mutation === 'malformed') parent[key] = null;
        else if (typeof value === 'number') parent[key] = 9;
        else {
          const url = String(value);
          parent[key] =
            mutation === 'valid-case'
              ? url.replace('upstream/fixture', 'UPSTREAM/FIXTURE')
              : mutation === 'owner'
                ? url.replace('upstream', 'elsewhere')
                : mutation === 'repo'
                  ? url.replace('fixture', 'project')
                  : url.replace('/8', '/9');
        }
        r.pages[0] = [changed];
        const result = await r.assess();
        const context = `${path.join('.')} ${mutation}`;
        if (mutation === 'valid-case' || mutation === 'absent') {
          expect(result.kind, context).toBe('eligible');
          if (result.kind === 'unknown') throw new Error(context);
          expect(result.evidenceDigest, context).not.toBe(original.evidenceDigest);
        } else {
          expect(result, context).toEqual({ kind: 'unknown' });
          expect('evidenceDigest' in result, context).toBe(false);
        }
      }
    }
  });

  it.each([
    'url',
    'html_url',
    'number',
    'diff_url',
    'patch_url',
  ])('checks present hydrated identity fields: %s', async (key) => {
    const r = rig();
    r.pages[0] = [cross()];
    r.pr[key] =
      key === 'number'
        ? 9
        : `https://github.com/elsewhere/project/pull/9${key === 'diff_url' ? '.diff' : key === 'patch_url' ? '.patch' : ''}`;
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });

  it.each([
    'source_api',
    'marker_html',
    'subject_html',
  ])('rejects additional REST identity contradictions: %s', async (field) => {
    const r = rig();
    const entry = cross();
    const linked = {
      ...entry.source.issue,
      url: `https://api.github.com/repos/${field === 'source_api' ? 'elsewhere/other' : 'upstream/fixture'}/issues/8`,
      pull_request: {
        ...entry.source.issue.pull_request,
        html_url: `https://github.com/${field === 'marker_html' ? 'elsewhere/other' : 'upstream/fixture'}/pull/8`,
      },
    };
    r.pages[0] = [
      {
        ...entry,
        source: { issue: linked },
        subject: {
          url: 'https://api.github.com/repos/upstream/fixture/pulls/8',
          html_url: `https://github.com/${field === 'subject_html' ? 'elsewhere/other' : 'upstream/fixture'}/pull/8`,
        },
      },
    ];
    r.pr.state = 'closed';
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    expect(r.calls.some((path) => path.includes('/pulls/'))).toBe(false);
    linked.url = 'https://api.github.com/repos/upstream/fixture/issues/8';
    linked.pull_request.html_url = 'https://github.com/upstream/fixture/pull/8';
    r.pages[0] = [{ ...entry, source: { issue: linked } }];
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    const { pull_request: _pr, ...ordinary } = linked;
    ordinary.html_url = 'https://github.com/upstream/fixture/issues/8';
    r.pages[0] = [{ ...entry, source: { issue: ordinary } }];
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    ordinary.url = 'https://api.github.com/repos/elsewhere/other/issues/8';
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it('handles REST cross-references without invented numeric IDs', async () => {
    const r = rig();
    const { id: _id, ...entry } = cross();
    r.pages[0] = [{ ...entry, updated_at: date }];
    r.pr.user = user('contributor');
    expect(await r.assess()).toMatchObject({
      kind: 'hand_off',
      reasons: ['own_pr_exists'],
      facts: { events: [{ id: null, updatedAt: date }] },
    });
    r.pr.state = 'closed';
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    r.pages[0] = [entry, entry];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    const { pull_request: _marker, ...ordinary } = entry.source.issue;
    r.pages[0] = [
      {
        ...entry,
        source: {
          issue: { ...ordinary, html_url: 'https://github.com/upstream/fixture/issues/8' },
        },
      },
    ];
    expect(await r.assess()).toMatchObject({ kind: 'eligible', facts: { events: [] } });
  });
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-10-05T24:00:00Z',
  ])('refuses impossible calendar dates at every timestamp sink: %s', async (invalid) => {
    const r = rig();
    r.item.created_at = invalid;
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    r.item.created_at = '2024-02-29T23:59:59Z';
    expect(await r.assess()).toMatchObject({ kind: 'eligible' });
    r.pages[0] = [{ ...cross(), created_at: invalid }];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    r.pages[0] = [{ ...cross(), updated_at: invalid }];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    r.pages[0] = [cross()];
    r.pr.state = 'closed';
    r.pr.merged_at = invalid;
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it('admits structured GitHub App bot metadata without treating bots as contributors', async () => {
    const r = rig();
    const bot = {
      login: 'github-actions[bot]',
      html_url: 'https://github.com/apps/github-actions',
      type: 'Bot',
    };
    r.item.user = bot;
    r.pr.user = bot;
    r.pages[0] = [{ ...cross(), actor: bot }];
    expect(await r.assess()).toMatchObject({
      kind: 'hand_off',
      reasons: ['competing_fix'],
      facts: {
        issue: { author: { login: bot.login, url: bot.html_url } },
        pulls: [{ author: { login: bot.login } }],
      },
    });
    r.item.user = { ...bot, type: 'User' };
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    r.item.user = { ...bot, html_url: 'https://github.com/apps/other' };
    expect(await r.assess()).toEqual({ kind: 'unknown' });
  });
  it.each([
    'number',
    'marker',
    'subject',
    'missing_marker',
  ])('rejects contradictory reference identity: %s', async (field) => {
    const r = rig();
    const entry = cross();
    if (field === 'number') entry.source.issue.number = 9;
    if (field === 'marker')
      entry.source.issue.pull_request.url = 'https://api.github.com/repos/upstream/fixture/pulls/9';
    if (field === 'missing_marker') Reflect.deleteProperty(entry.source.issue, 'pull_request');
    r.pages[0] = [
      {
        ...entry,
        ...(field === 'subject'
          ? { subject: { url: 'https://api.github.com/repos/upstream/fixture/pulls/9' } }
          : {}),
      },
    ];
    expect(await r.assess()).toEqual({ kind: 'unknown' });
    expect(r.calls.some((path) => path.includes('/pulls/'))).toBe(false);
  });
  it('does not let hydration mutate the validated page size, nested entries or read budget', async () => {
    for (const mode of ['shorten', 'expand', 'nested']) {
      const r = rig();
      const reference = cross();
      const assignment = {
        id: 2,
        event: 'assigned',
        created_at: date,
        actor: user('other'),
        assignee: user('other'),
      };
      const page = [
        reference,
        assignment,
        ...Array.from({ length: 98 }, () => ({ event: 'commented' })),
      ];
      r.pages.splice(0, 1, page, []);
      r.pr.state = 'closed';
      const read: GitHubRead = async (path) => {
        if (path.includes('/pulls/')) {
          if (mode === 'shorten') page.splice(1);
          if (mode === 'expand') page.push(...Array.from({ length: 1001 }, () => cross()));
          if (mode === 'nested') assignment.assignee.login = 'changed';
        }
        return r.read(path);
      };
      expect(await assessIssue(read, target, 'contributor')).toMatchObject({
        kind: 'eligible',
        facts: { events: [{ assignee: { login: 'other' } }, { pullUrl: r.pr.html_url }] },
      });
      expect(r.calls.filter((path) => path.includes('/pulls/'))).toHaveLength(1);
      expect(r.calls.at(-1)).toContain('page=2');
    }
  });
  it('has stable evidence for reordered mixed-case PR identities', async () => {
    const r = rig();
    const upper = cross(2);
    upper.source.issue.html_url = 'https://github.com/UPSTREAM/FIXTURE/pull/8';
    upper.source.issue.pull_request.url = 'https://api.github.com/repos/UPSTREAM/FIXTURE/pulls/8';
    r.pages[0] = [cross(), upper];
    const first = await r.assess();
    r.pages[0] = [upper, cross()];
    expect(await r.assess()).toEqual(first);
  });
  it('is deterministic under object key and unordered evidence changes, but sensitive to recorded facts', async () => {
    const r = rig();
    r.item.labels = [{ name: 'bug' }, { name: 'help wanted' }];
    r.pages[0] = [cross(), { ...cross(2), event: 'connected' }];
    const first = await r.assess();
    r.pages[0] = [...(r.pages[0] as unknown[])].reverse();
    r.item.labels = [{ name: 'help wanted' }, { name: 'bug' }];
    const second = await r.assess();
    expect(second).toEqual(first);
    r.repo.default_branch = 'main';
    const third = await r.assess();
    expect(first.kind !== 'unknown' && first.evidenceDigest).not.toBe(
      third.kind !== 'unknown' && third.evidenceDigest
    );
  });
  it('snapshots caller target across asynchronous reads', async () => {
    const r = rig();
    const binding = { ...target };
    const read: GitHubRead = async (path) => {
      binding.owner = 'elsewhere';
      binding.issue = 99;
      return r.read(path);
    };
    expect(await assessIssue(read, binding, 'contributor')).toMatchObject({ kind: 'eligible' });
    expect(r.calls.every((path) => path.startsWith(prefix))).toBe(true);
  });
  it('observes real reader requests: GET only, no authorization, no transition or ambient fetch', async () => {
    const r = rig();
    r.pages[0] = [cross()];
    const ambient = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('forbidden ambient network'));
    const transitions = await import('../state');
    const transition = vi.spyOn(transitions, 'transitionRun');
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const asyncWrite = vi.spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    const credentials: string[] = [];
    const originalEnvironment = process.env;
    process.env = new Proxy(originalEnvironment, {
      get(environment, key) {
        if (
          typeof key === 'string' &&
          ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_CLIENT_SECRET'].includes(key)
        )
          credentials.push(key);
        return Reflect.get(environment, key);
      },
    });
    const requests: { path: string; options?: RequestInit }[] = [];
    const fetchImpl = (async (url, options) => {
      const path = String(url).slice('https://api.github.com'.length);
      requests.push({ path, options });
      const response = await r.read(path);
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as typeof fetch;
    let result: Eligibility;
    try {
      result = await assessIssue(anonymousReader(fetchImpl), target, 'contributor');
    } finally {
      process.env = originalEnvironment;
    }
    expect(result).toMatchObject({
      kind: 'hand_off',
    });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.options?.method).toBe('GET');
      expect(request.options?.body).toBeUndefined();
      expect(new Headers(request.options?.headers).has('authorization')).toBe(false);
      expect(request.path).toMatch(/^\/repos\/upstream\/fixture(?:\/|$)/u);
    }
    expect(ambient).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(credentials).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(asyncWrite).not.toHaveBeenCalled();
  });
});
