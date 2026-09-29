import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createEmptyState,
  enqueueEntries,
  parseManifest,
  SchedStore,
  schedStateDir,
} from '@ai-dossier/sched';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBatchCommand } from '../../commands/batch';
import { errored, execHandles, logged, runCommandTree } from '../helpers/test-utils';

vi.mock('node:child_process');

const PROJECT = 'batch-compose-test';

interface FakeIssue {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: string;
  comments?: Array<string | { body: string; authorAssociation?: string; login?: string }>;
}

function ghIssue(i: FakeIssue): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title ?? `fix: issue ${i.number}`,
    body: i.body ?? 'Edit `packages/sched/src/status.ts` so the status column is right.',
    labels: (i.labels ?? []).map((name) => ({ name })),
    assignees: (i.assignees ?? []).map((login) => ({ login })),
    state: i.state ?? 'OPEN',
    comments: (i.comments ?? []).map((c) =>
      typeof c === 'string'
        ? { body: c }
        : { body: c.body, authorAssociation: c.authorAssociation, author: { login: c.login } }
    ),
  };
}

/** Remote workspace files served by the fake `gh api repos/<r>/contents/…` (`--repo` runs). */
interface FakeRepoFiles {
  files: Record<string, string>;
  dirs: string[];
}

/**
 * A fake `gh` over a fixed issue universe: `issue view`, `issue list`, `api …/contents`, and — for
 * the local workspace-config read — `git rev-parse --show-toplevel` (the temp checkout `home`).
 */
function fakeGh(picks: FakeIssue[], backlog: FakeIssue[] = [], remote?: FakeRepoFiles): void {
  const all = new Map([...picks, ...backlog].map((i) => [i.number, i]));
  execHandles((file, args) => {
    if (file === 'git' && args[0] === 'rev-parse') return `${checkout}\n`;
    if (file !== 'gh') throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    if (args[0] === 'issue' && args[1] === 'view') {
      const issue = all.get(Number(args[2]));
      if (!issue) throw new Error('could not resolve to an Issue');
      if (args[4] === 'state') return JSON.stringify({ state: issue.state ?? 'OPEN' });
      return JSON.stringify(ghIssue(issue));
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return JSON.stringify(backlog.map(ghIssue));
    }
    if (args[0] === 'api') {
      const target = (args.find((a) => a.startsWith('repos/')) ?? '').replace(
        /^repos\/[^/]+\/[^/]+\/contents\/?/,
        ''
      );
      if (target === '') return (remote?.dirs ?? []).join('\n');
      const text = remote?.files[decodeURIComponent(target)];
      if (text === undefined) throw new Error('HTTP 404: Not Found');
      return text;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
}

function report(): Record<string, any> {
  const lines = logged();
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

function ghCalls(sub: string): string[][] {
  return vi
    .mocked(childProcess.execFileSync)
    .mock.calls.map((c) => c[1] as string[])
    .filter((args) => args[1] === sub);
}

let home: string;
/** A temp "local checkout" declaring `packages/*` workspaces — what the local workspace read sees. */
let checkout: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-compose-home-'));
  vi.stubEnv('HOME', home);
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-compose-checkout-'));
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"workspaces":["packages/*"]}');
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(checkout, { recursive: true, force: true });
});

const compose = (...args: string[]) =>
  runCommandTree(registerBatchCommand, [
    'batch',
    'compose',
    '--project',
    PROJECT,
    '--json',
    ...args,
  ]);

/** A plan:v1 artifact predicting `n` distinct files under packages/. */
function planBody(n: number, head: string): string {
  const files = Array.from({ length: n }, (_, k) => `- \`packages/p${k}/src/f.ts\` — f`).join('\n');
  return `<!-- plan:v1 head=${head} -->\n\n## Problem\np\n\n## Acceptance Criteria\n- a\n\n## Predicted Files\n${files}\n\n## Approach\nx\n\n## Test Scope\ny\n`;
}

describe('batch compose', () => {
  it("a stranger's runstate milestone does not mark the issue in-flight; a trusted one does (#808)", async () => {
    const milestone =
      '<!-- runstate:v1 -->\nphase=implement status=done run=r-1-aaaa at=2026-09-29T10:00:00Z\nnext=test';
    fakeGh([
      { number: 1, comments: [{ body: milestone, authorAssociation: 'NONE', login: 'mallory' }] },
      { number: 2, comments: [{ body: milestone, authorAssociation: 'OWNER' }] },
      { number: 3 },
    ]);

    await compose('--issues', '1,2,3');

    const r = report();
    expect(r.excluded.map((e: { issue: number }) => e.issue)).toEqual([2]);
    expect(r.members.map((m: { issue: number }) => m.issue).sort()).toEqual([1, 3]);
  });

  it('a plan:v1 comment with no reported association is not used (fail closed) and is named in warnings (#808)', async () => {
    fakeGh([{ number: 1, comments: [planBody(9, 'aaa1111')] }]);

    await compose('--issues', '1');

    const r = report();
    expect(r.members[0].review).toBe('light'); // the 9-file artifact was NOT read
    expect(r.warnings.join('\n')).toMatch(/#1: Ignored 1 newer plan:v1.*unreported/);
  });

  it('reads predicted files only from a write-access plan:v1 author and warns about the ignored newer one (#808)', async () => {
    fakeGh([
      {
        number: 1,
        comments: [
          { body: planBody(9, 'aaa1111'), authorAssociation: 'MEMBER', login: 'lead' },
          { body: planBody(1, 'bbb2222'), authorAssociation: 'NONE', login: 'mallory' },
        ],
      },
    ]);

    await compose('--issues', '1');

    const r = report();
    expect(r.degraded).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/#1: Ignored 1 newer plan:v1.*mallory/);
    // The legitimate 9-file artifact drove the assessment (the forged 1-file one did not
    // replace it): the issue is a review=full member on the file-count rule.
    expect(r.members).toEqual([
      expect.objectContaining({
        issue: 1,
        review: 'full',
        review_reasons: [expect.stringContaining('rule5-file-count')],
      }),
    ]);
  });

  it('composes three clean picks with zero model calls — every subprocess is gh or git (#773 AC2)', async () => {
    fakeGh([{ number: 1 }, { number: 2 }, { number: 3 }]);

    const code = await compose('--issues', '1,2,3');

    expect(code).toBeUndefined();
    const r = report();
    expect(r).toMatchObject({
      schema: 'batch-compose:v1',
      status: 'ok',
      base_branch: 'main',
      rules: 'v2',
      model_calls: 0,
      degraded: false,
    });
    expect(r.members.map((m: { issue: number }) => m.issue)).toEqual([1, 2, 3]);
    // No LLM spawn: every child process the command started was `gh`, and nothing was spawned.
    const files = vi.mocked(childProcess.execFileSync).mock.calls.map((c) => c[0]);
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files)).toEqual(new Set(['gh', 'git'])); // git: the local workspace-config read (#801)
    const { spawn, spawnSync, exec, execSync, execFile, fork } = childProcess;
    for (const fn of [spawn, spawnSync, exec, execSync, execFile, fork]) {
      expect(vi.mocked(fn)).not.toHaveBeenCalled();
    }
    // Enough picks — the backlog is never queried.
    expect(ghCalls('list')).toEqual([]);
  });

  it('emits manifest_entries that sched enqueue --from-manifest accepts (#773 AC3)', async () => {
    fakeGh([{ number: 1 }, { number: 2, title: 'fix: billing sweep windows' }, { number: 3 }]);

    await compose('--issues', '1..3', '--base', 'develop');

    const r = report();
    expect(r.manifest_entries).toEqual([
      { issue: 1, mode: 'slot', review: 'light', base_branch: 'develop' },
      { issue: 3, mode: 'slot', review: 'light', base_branch: 'develop' },
      { issue: 2, mode: 'slot', review: 'full', base_branch: 'develop' },
    ]);
    // batch-issues-preparation adds batch/anchor; with those the draft entries parse as-is.
    const parsed = parseManifest({
      entries: r.manifest_entries.map((e: object) => ({ ...e, batch: 'b-1', anchor: 900 })),
    });
    expect(parsed.map((e) => e.review)).toEqual(['light', 'light', 'full']);
  });

  it('backfills short picks from one backlog query, ranked by shared package', async () => {
    fakeGh(
      [{ number: 10 }, { number: 11, assignees: ['busy'] }],
      [
        { number: 20, body: 'Edit `registry/api/x.ts` so the behaviour is correct.' },
        { number: 21, body: 'Edit `packages/sched/src/engine.ts` so the behaviour is correct.' },
        {
          number: 22,
          body: 'Edit `packages/sched/src/x.ts` so the behaviour is correct.',
          labels: ['in-progress'],
        },
      ]
    );

    await compose('--issues', '10,11');

    const r = report();
    expect(ghCalls('list')).toHaveLength(1);
    expect(r.params.backlog.queried).toBe(true);
    // Backfill tops the set up to min_members: the package-sharing candidate first.
    expect(r.status).toBe('ok');
    expect(r.members.map((m: { issue: number; source: string }) => [m.issue, m.source])).toEqual([
      [10, 'pick'],
      [21, 'backfill'],
      [20, 'backfill'],
    ]);
    expect(r.backfill.map((b: { issue: number }) => b.issue)).toEqual([21, 20]);
    expect(r.excluded.map((e: { issue: number }) => e.issue).sort()).toEqual([11, 22]);
  });

  it('--no-backfill never queries the backlog', async () => {
    fakeGh([{ number: 10 }]);

    await compose('--issues', '10', '--no-backfill');

    expect(ghCalls('list')).toEqual([]);
    expect(report()).toMatchObject({ status: 'no-batch', backfill: [] });
  });

  it('excludes an issue that is already an active sched queue entry', async () => {
    const store = new SchedStore(schedStateDir(PROJECT));
    fs.mkdirSync(store.dir, { recursive: true });
    store.save(enqueueEntries(createEmptyState(), [{ issue: 2, mode: 'full' }]));
    fakeGh([{ number: 1 }, { number: 2 }, { number: 3 }]);

    await compose('--issues', '1,2,3', '--no-backfill');

    const r = report();
    expect(r.excluded).toEqual([
      expect.objectContaining({
        issue: 2,
        reasons: [expect.objectContaining({ code: 'sched-active' })],
      }),
    ]);
  });

  it('a Depends-on to an open issue outside the picks excludes; one inside the picks does not', async () => {
    fakeGh(
      [
        { number: 1, body: 'Depends on #2. Edit `cli/src/a.ts`.' },
        { number: 2 },
        { number: 3, body: 'Depends on #50.' },
      ],
      [{ number: 50, state: 'OPEN' }]
    );

    await compose('--issues', '1,2,3', '--no-backfill');

    const r = report();
    expect(r.excluded).toEqual([
      expect.objectContaining({
        issue: 3,
        reasons: [expect.objectContaining({ code: 'open-dependency' })],
      }),
    ]);
  });

  it('a pick depending on an EXCLUDED pick is excluded too (it would ship without it)', async () => {
    fakeGh([
      { number: 1, body: 'Depends on #2.' },
      { number: 2, assignees: ['busy'] },
      { number: 3 },
    ]);

    await compose('--issues', '1,2,3', '--no-backfill');

    const r = report();
    expect(r.excluded.map((e: { issue: number }) => e.issue).sort()).toEqual([1, 2]);
    expect(r.excluded.find((e: { issue: number }) => e.issue === 1).reasons).toEqual([
      expect.objectContaining({ code: 'open-dependency' }),
    ]);
  });

  it('a dependency whose state cannot be read fails closed (excluded, report degraded)', async () => {
    fakeGh([{ number: 1 }, { number: 2, body: 'Depends on #777.' }]);

    await compose('--issues', '1,2', '--no-backfill');

    const r = report();
    expect(r.degraded).toBe(true);
    expect(r.excluded).toEqual([
      expect.objectContaining({
        issue: 2,
        reasons: [expect.objectContaining({ code: 'open-dependency' })],
      }),
    ]);
  });

  it('backfills when the caps, not admission, leave the picks short', async () => {
    const full = (n: number) => ({ number: n, title: `fix: billing window ${n}` });
    fakeGh([full(1), full(2), full(3)], [{ number: 20 }]);

    await compose('--issues', '1,2,3');

    const r = report();
    expect(ghCalls('list')).toHaveLength(1);
    expect(r.held).toEqual([expect.objectContaining({ issue: 3, reason: 'review-full-cap' })]);
    expect(r.members.map((m: { issue: number }) => m.issue)).toEqual([1, 2, 20]);
  });

  it("fetches the backlog to refill a held pick's slot even when the picks reach min_members (#951)", async () => {
    const full = (n: number) => ({ number: n, title: `fix: billing window ${n}` });
    fakeGh([full(1), full(2), full(3), { number: 4 }, { number: 5 }], [{ number: 20 }]);

    await compose('--issues', '1,2,3,4,5');

    const r = report();
    expect(ghCalls('list')).toHaveLength(1);
    expect(r.held).toEqual([expect.objectContaining({ issue: 3, reason: 'review-full-cap' })]);
    expect(r.members).toHaveLength(5);
    expect(r.members).toContainEqual(expect.objectContaining({ issue: 20, source: 'backfill' }));
  });

  it('reads the workspace layout from the target repo via gh api when --repo is given (#801)', async () => {
    const body = 'Touches `main/packages/frontend/src/a.tsx` and `main/scripts/ci.sh` for the fix.';
    fakeGh(
      [
        { number: 1, body },
        { number: 2, body },
        { number: 3, body },
      ],
      [],
      {
        files: { 'main/pnpm-workspace.yaml': 'packages:\n  - packages/*\n' },
        dirs: ['main', 'docs'],
      }
    );

    await compose('--issues', '1,2,3', '--repo', 'acme/mono');

    const r = report();
    expect(r.workspace).toMatchObject({
      source: 'workspace-config',
      roots: [{ prefix: 'main', file: 'pnpm-workspace.yaml', globs: ['packages/*'] }],
    });
    expect(r.members.map((m: { packages: string[] }) => m.packages)).toEqual([
      ['packages/frontend'],
      ['packages/frontend'],
      ['packages/frontend'],
    ]);
    expect(r.shared_packages).toEqual(['packages/frontend']);
    expect(r.degraded).toBe(false);
  });

  it('falls back to the path heuristic and says so when the repo declares no workspaces (#801)', async () => {
    const body = 'Touches `main/scripts/ci.sh` and `main/docs/x.md` for the fix.';
    fakeGh(
      [
        { number: 1, body },
        { number: 2, body },
        { number: 3, body },
      ],
      [],
      {
        files: {},
        dirs: ['main'],
      }
    );

    await compose('--issues', '1,2,3', '--repo', 'acme/mono');

    const r = report();
    expect(r.workspace).toEqual({ source: 'heuristic', roots: [] });
    expect(r.degraded).toBe(false);
    expect(r.notices.join(' ')).toMatch(/path heuristics: no workspace config/);
    expect(r.members[0].packages).toEqual(['main']);
  });

  it('screens unready BACKLOG candidates with a stated reason and keeps explicit picks (#802)', async () => {
    const ready = {
      title: 'fix: crash',
      labels: ['bug'],
      body: 'The `packages/sched/src/a.ts` crash. Steps: save twice.',
    };
    fakeGh(
      [{ number: 1, ...ready }],
      [
        { number: 20, ...ready },
        { number: 21, ...ready },
        {
          number: 30,
          title: 'feat: portfolio mode',
          labels: ['enhancement'],
          body: 'Search across all boards for everyone, whatever that means.',
        },
        {
          number: 31,
          title: 'fix(mobile): layout punch list',
          labels: ['bug'],
          body: 'A long list of findings follows below in this body.',
        },
      ]
    );

    await compose('--issues', '1', '--backlog');

    const r = report();
    expect(r.members.map((m: { issue: number }) => m.issue)).toEqual([1, 20, 21]);
    const notReady = r.excluded.filter((e: { reasons: Array<{ code: string }> }) =>
      e.reasons.some((x) => x.code === 'not-ready')
    );
    expect(notReady.map((e: { issue: number }) => e.issue)).toEqual([30, 31]);
    expect(notReady[0].reasons[0].message).toMatch(/feature with no acceptance-criteria section/);
    expect(notReady[1].reasons[0].message).toMatch(/punch list/);
  });

  it('an explicit pick that is not ready is kept, with a note that does not degrade the report (#802)', async () => {
    fakeGh([
      {
        number: 1,
        title: 'feat: portfolio mode',
        labels: ['enhancement'],
        body: 'Search across all boards for everyone, whatever that means.',
      },
      { number: 2 },
      { number: 3 },
    ]);

    await compose('--issues', '1,2,3');

    const r = report();
    expect(r.members.map((m: { issue: number }) => m.issue)).toContain(1);
    expect(r.notices.join(' ')).toMatch(/#1 \(pick\) does not look batch-ready/);
    expect(r.degraded).toBe(false);
  });

  it('an unreadable pick is excluded and degrades the report instead of failing it', async () => {
    fakeGh([{ number: 1 }, { number: 2 }]);

    await compose('--issues', '1,2,404', '--no-backfill');

    const r = report();
    expect(r.degraded).toBe(true);
    expect(r.excluded).toEqual([
      expect.objectContaining({
        issue: 404,
        reasons: [expect.objectContaining({ code: 'unreadable' })],
      }),
    ]);
    expect(r.status).toBe('under-min');
  });

  it('text mode prints the composition and the recommendation', async () => {
    fakeGh([{ number: 1 }, { number: 2 }, { number: 3 }]);

    await runCommandTree(registerBatchCommand, [
      'batch',
      'compose',
      '--project',
      PROJECT,
      '--issues',
      '1,2,3',
    ]);

    const out = logged().join('\n');
    expect(out).toContain('status: ok');
    expect(out).toContain('#1  review=light  ready=');
  });

  it('text mode prints a held pick with its source, review reasons and next-run note (#951)', async () => {
    const full = (n: number) => ({ number: n, title: `fix: billing window ${n}` });
    fakeGh([full(1), full(2), full(3)], [{ number: 20 }]);

    await runCommandTree(registerBatchCommand, [
      'batch',
      'compose',
      '--project',
      PROJECT,
      '--issues',
      '1,2,3',
    ]);

    const out = logged().join('\n');
    expect(out).toContain('#3  review=full  review-full-cap  (pick)');
    expect(out).toMatch(/#3 {2}review=full[\s\S]*full because: .*billing/);
    expect(out).toContain('submit #3 again then (no extra small batch is opened for it)');
  });

  it('text mode strips terminal escapes from untrusted issue titles', async () => {
    fakeGh([{ number: 1, title: 'fix: \u001b]52;c;cGF5bG9hZA==\u0007evil \u001b[31mred' }]);

    await runCommandTree(registerBatchCommand, [
      'batch',
      'compose',
      '--project',
      PROJECT,
      '--issues',
      '1',
      '--no-backfill',
    ]);

    const out = logged().join('\n');
    expect(out).toContain('evil');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
  });

  it('refuses to run with nothing to compose', async () => {
    fakeGh([]);
    const code = await compose();
    expect(code).toBe(1);
    expect(errored().join('\n')).toContain('Nothing to compose');
  });

  it('rejects min above max', async () => {
    fakeGh([]);
    const code = await compose('--issues', '1', '--min-members', '5', '--max-members', '4');
    expect(code).toBe(1);
  });
});
