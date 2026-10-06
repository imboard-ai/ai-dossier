/** #1065 fork prerequisites against recorded fixture shapes (gate-3 probe). No network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretRedactionError } from '../../redaction';
import { createRun, ReasonCode, type RunRecord, restoreRun, transitionRun } from '../../state';
import { renderHuman, renderJson } from '../../status';
import {
  checkForkReadiness,
  checkInstallation,
  discoverFork,
  ForkError,
  type InstallationSource,
  type InstallationSummary,
  MAX_FORK_PAGES,
  prerequisiteAction,
  type ReadinessOutcome,
  upstreamOf,
} from '../fork';
import type { GitHubRead, GitHubResponse } from '../reconcile';

const UPSTREAM_ID = 1717;
const FORK_ID = 4242;
const OTHER_ID = 999;
const ISSUE = 'https://github.com/upstream-org/fixture/issues/1';
const SLUG = 'ztfc-contributor';
const DECLARED = { contents: 'write', metadata: 'read' } as const;
const time = '2026-10-06T00:00:00.000Z';
const later = '2026-10-06T01:00:00.000Z';
const upstream = { owner: 'upstream-org', repo: 'fixture', repositoryId: UPSTREAM_ID };

const base = createRun({ runId: 'run-1', upstreamIssue: ISSUE, contributor: 'contributor' }, time);
const shipping = [
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed,
].reduce((run, reason) => transitionRun(run, reason, time), base);

const repo = (overrides: Record<string, unknown> = {}) => ({
  id: FORK_ID,
  full_name: 'contributor/fixture',
  fork: true,
  owner: { login: 'contributor' },
  parent: { id: UPSTREAM_ID },
  source: { id: UPSTREAM_ID },
  ...overrides,
});

/** Anonymous reader over recorded responses; records every path it is asked for. */
class Reader {
  readonly paths: string[] = [];
  readonly responses = new Map<string, GitHubResponse | 'throw'>();
  forks: unknown[] = [];
  set(path: string, response: GitHubResponse | 'throw'): this {
    this.responses.set(path, response);
    return this;
  }
  read: GitHubRead = async (path) => {
    this.paths.push(path);
    const listing =
      /^\/repos\/upstream-org\/fixture\/forks\?sort=newest&per_page=100&page=([0-9]+)$/u.exec(path);
    const recorded = this.responses.get(path);
    if (recorded === 'throw') throw new Error('synthetic transport failure');
    if (recorded) return recorded;
    if (listing) {
      const page = Number(listing[1]);
      return { status: 200, body: this.forks.slice((page - 1) * 100, page * 100) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
}

const summary = (overrides: Partial<InstallationSummary> = {}): InstallationSummary => ({
  id: 99,
  account: 'contributor',
  repositorySelection: 'selected',
  permissions: { contents: 'write', metadata: 'read' },
  suspended: false,
  ...overrides,
});

/** The credential side, replaying the installation fixtures. */
function source(options: {
  fork?: InstallationSummary | 'none' | null | 'throw';
  upstream?: InstallationSummary | 'none' | null;
  selected?: readonly number[] | 'authorize' | null;
}): InstallationSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    installationFor: async (repository) => {
      const name = `${repository.owner}/${repository.repo}`;
      calls.push(`installation ${name}`);
      if (name === 'upstream-org/fixture')
        return options.upstream === undefined ? 'none' : options.upstream;
      if (options.fork === 'throw') throw new Error('synthetic');
      return options.fork === undefined ? summary() : options.fork;
    },
    selectedRepositories: async (id) => {
      calls.push(`selected ${id}`);
      return options.selected === undefined ? [FORK_ID] : options.selected;
    },
  };
}

const withFork = () =>
  new Reader().set('/repos/contributor/fixture', { status: 200, body: repo() });
const check = (
  reader: Reader,
  installations: InstallationSource,
  run: RunRecord = shipping,
  expectedForkId?: number
) =>
  checkForkReadiness(
    {
      run,
      upstreamId: UPSTREAM_ID,
      appSlug: SLUG,
      declaredPermissions: DECLARED,
      ...(expectedForkId === undefined ? {} : { expectedForkId }),
    },
    { read: reader.read, installations, now: () => later }
  );
const statusOf = (outcome: { run: RunRecord; nextPermittedAction: string }) => ({
  runId: outcome.run.runId,
  phase: 'shipping',
  state: outcome.run.state,
  upstreamIssue: outcome.run.upstreamIssue,
  contributor: outcome.run.contributor,
  activeTimeMs: 0,
  estimatedSpend: { amount: 0, currency: 'USD' },
  budgetRemaining: { amount: 1, currency: 'USD' },
  reasonCode: outcome.run.reasonCode,
  nextPermittedAction: outcome.nextPermittedAction,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fork discovery (AC2)', () => {
  it('fork present: binds by repository id, never sending a credential', async () => {
    const reader = withFork();
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({
      kind: 'found',
      fork: {
        repositoryId: FORK_ID,
        owner: 'contributor',
        repo: 'fixture',
        fullName: 'contributor/fixture',
      },
    });
    // The reader interface carries no credential; only public repository paths are read.
    expect(reader.paths.every((p) => p.startsWith('/repos/'))).toBe(true);
  });

  it('finds a renamed fork through the upstream listing filtered by owner', async () => {
    const reader = new Reader().set('/repos/contributor/fixture', { status: 301, body: null });
    reader.forks = [
      { full_name: 'someone/fixture', owner: { login: 'someone' } },
      { full_name: 'Contributor/my-fixture', owner: { login: 'Contributor' } },
    ];
    reader.set('/repos/Contributor/my-fixture', {
      status: 200,
      body: repo({ full_name: 'Contributor/my-fixture', owner: { login: 'Contributor' } }),
    });
    const found = await discoverFork(reader.read, upstream, 'contributor');
    expect(found).toMatchObject({ kind: 'found', fork: { repositoryId: FORK_ID } });
    // Another account's fork is never read, let alone bound.
    expect(reader.paths).not.toContain('/repos/someone/fixture');
  });

  it('fork missing: nothing owned by the contributor in the network', async () => {
    const reader = new Reader();
    reader.forks = [{ full_name: 'someone/fixture', owner: { login: 'someone' } }];
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'missing' });
  });

  it('a matching name alone never counts', async () => {
    for (const body of [
      repo({ fork: false }),
      // Another project of the same name: outside the upstream's fork network.
      repo({ parent: { id: 555 }, source: { id: 555 } }),
      repo({ id: 'x' }),
      repo({ owner: null }),
      'not a repository',
    ]) {
      const reader = new Reader().set('/repos/contributor/fixture', { status: 200, body });
      expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'missing' });
    }
  });

  it('wrong parent blocks: a fork of a fork in the upstream network', async () => {
    const reader = new Reader().set('/repos/contributor/fixture', {
      status: 200,
      body: repo({ parent: { id: OTHER_ID } }),
    });
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({
      kind: 'invalid',
      reason: 'fork_wrong_parent',
      fullName: 'contributor/fixture',
    });
  });

  it('wrong owner blocks: the repository read back belongs to another account', async () => {
    const reader = new Reader();
    reader.forks = [{ full_name: 'contributor/fixture-2', owner: { login: 'contributor' } }];
    reader.set('/repos/contributor/fixture-2', {
      status: 200,
      body: repo({ full_name: 'mallory/fixture-2', owner: { login: 'mallory' } }),
    });
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({
      kind: 'invalid',
      reason: 'fork_wrong_owner',
      fullName: 'mallory/fixture-2',
    });
  });

  it('a different repository than the one bound earlier blocks; so does a deleted one', async () => {
    expect(await discoverFork(withFork().read, upstream, 'contributor', 1)).toMatchObject({
      kind: 'invalid',
      reason: 'fork_replaced',
    });
    expect(await discoverFork(new Reader().read, upstream, 'contributor', FORK_ID)).toMatchObject({
      kind: 'invalid',
      reason: 'fork_replaced',
    });
  });

  it('unreadable listing or candidate is unknown, never missing', async () => {
    const failing = new Reader().set(
      '/repos/upstream-org/fixture/forks?sort=newest&per_page=100&page=1',
      'throw'
    );
    expect(await discoverFork(failing.read, upstream, 'contributor')).toEqual({ kind: 'unknown' });
    const limited = new Reader().set(
      '/repos/upstream-org/fixture/forks?sort=newest&per_page=100&page=1',
      { status: 403, body: { message: 'rate limited' } }
    );
    expect(await discoverFork(limited.read, upstream, 'contributor')).toEqual({ kind: 'unknown' });
    const candidate = new Reader().set('/repos/contributor/fx', 'throw');
    candidate.forks = [{ full_name: 'contributor/fx', owner: { login: 'contributor' } }];
    expect(await discoverFork(candidate.read, upstream, 'contributor')).toEqual({
      kind: 'unknown',
    });
  });

  it('bounds the listing and skips malformed entries', async () => {
    const reader = new Reader();
    reader.forks = [
      { full_name: '../../x', owner: { login: 'contributor' } },
      { full_name: 42, owner: { login: 'contributor' } },
      null,
      ...Array.from({ length: 100 * MAX_FORK_PAGES + 5 }, (_, i) => ({
        full_name: `u${i}/fixture`,
        owner: { login: `u${i}` },
      })),
    ];
    // Capped listing, but the same-name read answered 404: a first-time contributor is told to fork.
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'missing' });
    expect(reader.paths.filter((p) => p.includes('/forks?'))).toHaveLength(MAX_FORK_PAGES);
    // A capped listing never proves a bound fork gone, nor anything when the direct read failed.
    expect(await discoverFork(reader.read, upstream, 'contributor', FORK_ID)).toEqual({
      kind: 'unknown',
    });
    reader.set('/repos/contributor/fixture', { status: 502, body: null });
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'unknown' });
  });

  it('a failed same-name read is harmless when the listing is complete', async () => {
    const reader = new Reader().set('/repos/contributor/fixture', 'throw');
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'missing' });
  });

  it('a full_name that disagrees with its owner is not the fork', async () => {
    const reader = new Reader().set('/repos/contributor/fixture', {
      status: 200,
      body: repo({ full_name: 'someone-else/fixture' }),
    });
    expect(await discoverFork(reader.read, upstream, 'contributor')).toEqual({ kind: 'missing' });
  });

  it('rejects an invalid binding before reading', async () => {
    const reader = new Reader();
    await expect(discoverFork(reader.read, upstream, 'not a login')).rejects.toThrow(ForkError);
    await expect(
      discoverFork(reader.read, { ...upstream, repositoryId: 0 }, 'contributor')
    ).rejects.toThrow(ForkError);
    expect(reader.paths).toEqual([]);
  });
});

describe('installation scope (AC5)', () => {
  const fork = {
    repositoryId: FORK_ID,
    owner: 'contributor',
    repo: 'fixture',
    fullName: 'contributor/fixture',
  };
  it.each([
    ['installation all', summary({ repositorySelection: 'all' }), undefined, 'all_repositories'],
    ['installation with an extra repo', summary(), [FORK_ID, 7], 'extra_repositories'],
    [
      'extra permission',
      summary({ permissions: { contents: 'write', issues: 'write' } }),
      [FORK_ID],
      'extra_permissions',
    ],
    [
      'higher level',
      summary({ permissions: { contents: 'admin' } }),
      [FORK_ID],
      'extra_permissions',
    ],
    [
      'unknown level',
      summary({ permissions: { contents: 'owner' } }),
      [FORK_ID],
      'extra_permissions',
    ],
  ] as const)('%s is too broad', (_name, installation, ids, detail) => {
    expect(checkInstallation(installation, fork, DECLARED, ids)).toEqual({
      kind: 'too_broad',
      detail,
      installationId: 99,
    });
  });

  it('missing: none, suspended, another account, or a selection without the fork', () => {
    expect(checkInstallation('none', fork, DECLARED)).toEqual({ kind: 'missing' });
    expect(checkInstallation(summary({ suspended: true }), fork, DECLARED)).toEqual({
      kind: 'missing',
      suspendedId: 99,
    });
    expect(checkInstallation(summary({ account: 'someone' }), fork, DECLARED)).toEqual({
      kind: 'missing',
    });
    expect(checkInstallation(summary(), fork, DECLARED, [])).toEqual({ kind: 'missing' });
  });

  it('exactly the fork, within the declared permissions, is limited', () => {
    expect(checkInstallation(summary(), fork, DECLARED)).toEqual({
      kind: 'unconfirmed',
      installationId: 99,
    });
    expect(
      checkInstallation(summary({ permissions: { contents: 'read' } }), fork, DECLARED, [FORK_ID])
    ).toEqual({ kind: 'limited', installationId: 99 });
  });
});

describe('durable readiness wait (AC3, AC4, AC5)', () => {
  it('fork missing: awaiting_contributor with the exact fork URL, no compute, no timers', async () => {
    vi.useFakeTimers();
    const installations = source({});
    const outcome = await check(new Reader(), installations);
    expect(outcome).toMatchObject({
      kind: 'awaiting_contributor',
      reason: 'fork_missing',
      link: 'https://github.com/upstream-org/fixture/fork',
    });
    const waiting = outcome as Extract<ReadinessOutcome, { kind: 'awaiting_contributor' }>;
    expect(waiting.run.state).toBe('awaiting_contributor');
    expect(waiting.run.reasonCode).toBe(ReasonCode.ForkMissing);
    expect(waiting.nextPermittedAction).toContain('https://github.com/upstream-org/fixture/fork');
    expect(waiting.nextPermittedAction).not.toMatch(/\n/u);
    // Nothing is scheduled: no polling, no reminders. Installations are not even read.
    expect(vi.getTimerCount()).toBe(0);
    expect(installations.calls).toEqual([]);
    // Status carries the same facts and passes the redaction policy.
    expect(JSON.parse(renderJson(statusOf(waiting)))).toMatchObject({
      state: 'awaiting_contributor',
      reasonCode: 'fork_missing',
    });
    expect(renderHuman(statusOf(waiting))).toContain('/fork');
  });

  it('an explicit resume re-checks; an unchanged wait records nothing new', async () => {
    const first = (await check(new Reader(), source({}))) as { run: RunRecord };
    const again = await check(new Reader(), source({}), first.run);
    expect(again.kind).toBe('awaiting_contributor');
    expect(again.run).toBe(first.run);
  });

  it('fork created, App not installed: same wait, now with the install link', async () => {
    const waiting = (await check(new Reader(), source({}))) as { run: RunRecord };
    const outcome = await check(withFork(), source({ fork: 'none' }), waiting.run);
    expect(outcome).toMatchObject({
      kind: 'awaiting_contributor',
      reason: 'installation_missing',
      link: `https://github.com/apps/${SLUG}/installations/new`,
    });
    const run = (outcome as { run: RunRecord }).run;
    expect(run.state).toBe('awaiting_contributor');
    expect(run.reasonCode).toBe(ReasonCode.InstallationMissing);
    expect((outcome as { nextPermittedAction: string }).nextPermittedAction).toContain(
      'only contributor/fixture'
    );
    // The persisted run alone re-derives the status line after a restart.
    expect(prerequisiteAction(restoreRun(JSON.parse(JSON.stringify(run))), upstream, SLUG)).toEqual(
      {
        link: `https://github.com/apps/${SLUG}/installations/new`,
        nextPermittedAction: expect.stringContaining('your fork of upstream-org/fixture'),
      }
    );
  });

  it('a suspended installation waits with the settings link, not the install page', async () => {
    const outcome = await check(withFork(), source({ fork: summary({ suspended: true }) }));
    expect(outcome).toMatchObject({
      kind: 'awaiting_contributor',
      reason: 'installation_missing',
      link: 'https://github.com/settings/installations/99',
    });
    expect((outcome as { nextPermittedAction: string }).nextPermittedAction).toContain('Unsuspend');
  });

  it('installation missing from a fresh check enters the wait from gating', async () => {
    const outcome = await check(withFork(), source({ selected: [] }), base);
    expect(outcome).toMatchObject({ kind: 'awaiting_contributor', reason: 'installation_missing' });
    expect((outcome as { run: RunRecord }).run.history.at(-1)?.from).toBe('gating');
  });

  it('ready after the wait resumes the phase that entered it', async () => {
    const waiting = (await check(new Reader(), source({}))) as { run: RunRecord };
    const outcome = await check(withFork(), source({}), waiting.run);
    expect(outcome).toEqual({
      kind: 'ready',
      run: expect.objectContaining({ state: 'shipping', reasonCode: ReasonCode.ResumeShipping }),
      fork: {
        repositoryId: FORK_ID,
        owner: 'contributor',
        repo: 'fixture',
        fullName: 'contributor/fixture',
        installationId: 99,
      },
    });
    // Ready on the first check changes nothing.
    const direct = await check(withFork(), source({}), base);
    expect(direct.kind).toBe('ready');
    expect(direct.run).toBe(base);
  });

  it.each([
    ['installation all', { fork: summary({ repositorySelection: 'all' }) }, 'all_repositories'],
    ['installation with an extra repo', { selected: [FORK_ID, 7] }, 'extra_repositories'],
    [
      'extra permissions',
      { fork: summary({ permissions: { administration: 'write' } }) },
      'extra_permissions',
    ],
    [
      'App on the upstream',
      { upstream: summary({ account: 'upstream-org' }) },
      'upstream_installation',
    ],
  ] as const)('%s blocks with installation_too_broad and narrowing instructions', async (_n, fixture, detail) => {
    const outcome = await check(withFork(), source(fixture));
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'installation_too_broad', detail });
    const blocked = outcome as Extract<ReadinessOutcome, { kind: 'blocked' }>;
    expect(blocked.run.state).toBe('blocked');
    expect(blocked.run.reasonCode).toBe(ReasonCode.InstallationTooBroad);
    expect(blocked.nextPermittedAction).toContain(blocked.link);
    if (detail !== 'upstream_installation') {
      expect(blocked.link).toBe('https://github.com/settings/installations/99');
      expect(blocked.nextPermittedAction).toContain('Only select repositories');
    }
    expect(renderJson(statusOf(blocked))).toContain('installation_too_broad');
  });

  it('wrong parent blocks the run with the direct fork link', async () => {
    const reader = new Reader().set('/repos/contributor/fixture', {
      status: 200,
      body: repo({ parent: { id: OTHER_ID } }),
    });
    const outcome = await check(reader, source({}));
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'fork_wrong_parent' });
    expect(outcome.run.reasonCode).toBe(ReasonCode.PolicyBlocked);
    expect((outcome as { nextPermittedAction: string }).nextPermittedAction).toContain(
      'https://github.com/upstream-org/fixture/fork'
    );
    const replaced = await check(withFork(), source({}), shipping, 1);
    expect(replaced).toMatchObject({ kind: 'blocked', reason: 'fork_replaced' });
  });

  it('no user token yet: authorization_required carries the broker binding, records nothing', async () => {
    const outcome = await check(withFork(), source({ selected: 'authorize' }));
    expect(outcome).toMatchObject({
      kind: 'authorization_required',
      fork: { repositoryId: FORK_ID, installationId: 99, owner: 'contributor' },
    });
    expect(outcome.run).toBe(shipping);
    expect((outcome as { nextPermittedAction: string }).nextPermittedAction).toContain('Authorize');
  });

  it.each([
    [
      'fork read',
      new Reader().set(
        '/repos/upstream-org/fixture/forks?sort=newest&per_page=100&page=1',
        'throw'
      ),
      {},
    ],
    ['upstream installation', withFork(), { upstream: null }],
    ['fork installation', withFork(), { fork: null }],
    ['fork installation throw', withFork(), { fork: 'throw' }],
    ['selection', withFork(), { selected: null }],
  ] as const)('unreadable %s: unknown, nothing recorded', async (_n, reader, fixture) => {
    const outcome = await check(reader, source(fixture as Parameters<typeof source>[0]));
    expect(outcome.kind).toBe('unknown');
    expect(outcome.run).toBe(shipping);
  });

  it('refuses runs outside gating, shipping or a prerequisite wait, and bad bindings', async () => {
    const link = transitionRun(shipping, ReasonCode.ContributorHandoff, time);
    await expect(check(withFork(), source({}), link)).rejects.toThrow(ForkError);
    const planning = transitionRun(base, ReasonCode.GatePassed, time);
    await expect(check(withFork(), source({}), planning)).rejects.toThrow(ForkError);
    await expect(
      checkForkReadiness(
        {
          run: shipping,
          upstreamId: UPSTREAM_ID,
          appSlug: 'Bad Slug',
          declaredPermissions: DECLARED,
        },
        { read: withFork().read, installations: source({}), now: () => later }
      )
    ).rejects.toThrow(ForkError);
    const odd = createRun({ runId: 'r', upstreamIssue: 'o/r#1', contributor: 'contributor' }, time);
    expect(() => upstreamOf(odd, UPSTREAM_ID)).toThrow(ForkError);
    expect(() => upstreamOf(base, 0)).toThrow(ForkError);
  });

  it('status text never carries a token-shaped value', () => {
    const run = transitionRun(shipping, ReasonCode.ForkMissing, time);
    expect(() => prerequisiteAction(run, { ...upstream, owner: 'ghp_x' }, SLUG)).toThrow(
      SecretRedactionError
    );
    expect(prerequisiteAction(shipping, upstream, SLUG)).toBeNull();
  });
});
