import { describe, expect, it, vi } from 'vitest';
import { createExecGroundTruth, detectMergeMechanism } from '../groundtruth';
import {
  advanceNoMergeMechanism,
  classifyWorkflowText,
  type MergeMechanism,
  mergeMechanismVerdict,
  parseRepoMergeSettings,
  shipModeClause,
} from '../merge-mechanism';

/** Deterministic 40-hex blob id for a path, as the git trees API would return. */
const blobSha = (path: string) => Buffer.from(path).toString('hex').padEnd(40, '0').slice(0, 40);

/**
 * A fake `gh` over the repo's DEFAULT-branch tree (the API, never a local ref): `files` maps a
 * repo path to its text; `settings` answers `repos/<r>`. `truncated`/`treeFails` shape the
 * `git/trees/HEAD` read, `blobFails` an individual blob read; `calls` records every gh argv.
 */
function fakeExec(opts: {
  files?: Record<string, string>;
  settings?: string | null;
  treeFails?: boolean;
  truncated?: boolean;
  blobFails?: boolean;
  calls?: string[][];
}) {
  const files = opts.files ?? {};
  return (file: string, args: string[]): string | null => {
    if (file !== 'gh') return null; // no git call may be needed to detect the mechanism
    opts.calls?.push(args);
    const endpoint =
      args[args.indexOf('api') + 1] === '-H' ? args[args.indexOf('api') + 3] : args[1];
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return opts.settings === undefined ? null : opts.settings;
    }
    if (endpoint.includes('/git/trees/HEAD')) {
      if (opts.treeFails) return null;
      const watched =
        /^(\.github\/workflows\/[^/]+\.ya?ml|\.mergify\.yml|\.github\/mergify\.yml|\.kodiak\.toml|\.github\/\.kodiak\.toml)$/;
      return JSON.stringify({
        truncated: opts.truncated === true,
        blobs: Object.keys(files)
          .filter((f) => watched.test(f))
          .map((f) => ({ path: f, sha: blobSha(f) })),
      });
    }
    const m = /\/git\/blobs\/([0-9a-f]{40})$/.exec(endpoint);
    if (m && !opts.blobFails) {
      const path = Object.keys(files).find((f) => blobSha(f) === m[1]);
      return path === undefined ? null : files[path];
    }
    return null;
  };
}

const settings = (auto: unknown) =>
  JSON.stringify({
    allow_auto_merge: auto,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: true,
  });

describe('mergeMechanismVerdict (#887)', () => {
  const m = (n: boolean | null, w: boolean | null): MergeMechanism => ({
    nativeAutoMerge: n,
    watcherWorkflow: w,
    allowedMethods: [],
  });
  it.each([
    [true, false, 'confirmed'],
    [false, true, 'confirmed'],
    [null, true, 'confirmed'],
    [false, false, 'none'],
    [null, false, 'unknown'],
    [false, null, 'unknown'],
    [null, null, 'unknown'],
  ] as const)('native=%s watcher=%s → %s', (n, w, verdict) => {
    expect(mergeMechanismVerdict(m(n, w))).toBe(verdict);
  });
});

describe('parseRepoMergeSettings', () => {
  it('reads allow_auto_merge and the allowed methods', () => {
    expect(parseRepoMergeSettings(settings(true))).toEqual({
      nativeAutoMerge: true,
      allowedMethods: ['squash', 'rebase'],
    });
  });
  it.each([null, '', 'nope', '{}', settings('yes')])('unusable payload %s → null', (p) => {
    expect(parseRepoMergeSettings(p)).toBeNull();
  });
});

describe('classifyWorkflowText (#887)', () => {
  it('a label-triggered merge watcher', () => {
    expect(
      classifyWorkflowText(
        "on: pull_request\njobs:\n  m:\n    if: contains(github.event.pull_request.labels.*.name, 'auto-merge')\n    steps:\n      - run: gh pr merge --squash"
      )
    ).toBe('watcher');
  });
  it('a cron sweeper and a check_suite watcher are watchers too (triggers are not inspected)', () => {
    for (const on of ['schedule:\n  - cron: "*/5 * * * *"', 'check_suite:', 'merge_group:']) {
      expect(
        classifyWorkflowText(
          `on:\n  ${on}\njobs:\n  m:\n    steps:\n      - run: gh pr list --label auto-merge | xargs gh pr merge`
        )
      ).toBe('watcher');
    }
  });
  it.each([
    [
      'auto-merge-blocked label only',
      "if: contains(labels, 'auto-merge-blocked')\nrun: gh pr merge",
    ],
    ['dependabot-auto-merge', 'name: dependabot-auto-merge\nrun: gh pr merge --auto'],
  ])('%s is not the label', (_n, text) => {
    expect(classifyWorkflowText(text)).toBe('none');
  });
  it('the label without a merge action, or a remote reusable workflow, is unknown', () => {
    expect(classifyWorkflowText("if: !contains(labels, 'auto-merge')\nrun: npm test")).toBe(
      'unknown'
    );
    expect(
      classifyWorkflowText('jobs:\n  m:\n    uses: org/.github/.github/workflows/merge.yml@main')
    ).toBe('unknown');
  });
  it('an unrelated workflow is none; a LOCAL reusable workflow is not remote', () => {
    expect(classifyWorkflowText('on: push\njobs: {}')).toBe('none');
    expect(classifyWorkflowText('jobs:\n  a:\n    uses: ./.github/workflows/ci.yml')).toBe('none');
  });
});

describe('detectMergeMechanism (#887)', () => {
  const CI = { '.github/workflows/ci.yml': 'on: push\njobs: {}' };
  const WATCHER = {
    '.github/workflows/w.yml':
      'on: schedule\nrun: gh pr list --label auto-merge | xargs gh pr merge',
  };
  it('auto-merge disabled and no watcher is none', () => {
    const m = detectMergeMechanism(fakeExec({ files: CI, settings: settings(false) }), '/r', null);
    expect(mergeMechanismVerdict(m)).toBe('none');
  });
  it('native auto-merge allowed is confirmed (but the watcher stays false)', () => {
    const m = detectMergeMechanism(fakeExec({ files: CI, settings: settings(true) }), '/r', null);
    expect(mergeMechanismVerdict(m)).toBe('confirmed');
    expect(m.watcherWorkflow).toBe(false);
  });
  it('a watcher is confirmed even when the api read fails', () => {
    const m = detectMergeMechanism(fakeExec({ files: WATCHER, settings: null }), '/r', null);
    expect(mergeMechanismVerdict(m)).toBe('confirmed');
  });
  it('a failed api read with no watcher is unknown, never none', () => {
    const m = detectMergeMechanism(fakeExec({ files: CI, settings: null }), '/r', null);
    expect(mergeMechanismVerdict(m)).toBe('unknown');
  });
  it('an unreadable tree, a truncated tree, a Mergify config, or an unreadable file => watcher unknown', () => {
    expect(
      detectMergeMechanism(fakeExec({ treeFails: true, settings: settings(false) }), '/r', null)
        .watcherWorkflow
    ).toBeNull();
    expect(
      detectMergeMechanism(
        fakeExec({ files: CI, truncated: true, settings: settings(false) }),
        '/r',
        null
      ).watcherWorkflow
    ).toBeNull();
    expect(
      detectMergeMechanism(
        fakeExec({
          files: { ...CI, '.mergify.yml': 'pull_request_rules: []' },
          settings: settings(false),
        }),
        '/r',
        null
      ).watcherWorkflow
    ).toBeNull();
    expect(
      detectMergeMechanism(
        fakeExec({ files: CI, blobFails: true, settings: settings(false) }),
        '/r',
        null
      ).watcherWorkflow
    ).toBeNull();
  });
  it('#921: reads the default branch through the API, never a local (possibly stale) origin ref', () => {
    const calls: string[][] = [];
    const seen: string[] = [];
    const exec = fakeExec({ files: WATCHER, settings: settings(false), calls });
    // A checkout whose `origin/main` predates the watcher: any git call would see NO workflow.
    const m = detectMergeMechanism(
      (f, args, cwd) => {
        seen.push(f);
        return f === 'git' ? '' : exec(f, args, cwd);
      },
      '/stale-checkout',
      { owner: 'o', name: 'r' }
    );
    expect(m.watcherWorkflow).toBe(true);
    expect(seen.every((f) => f === 'gh')).toBe(true);
    expect(calls.some((a) => a[1] === 'repos/o/r/git/trees/HEAD?recursive=1')).toBe(true);
  });
  it('#921: a verified repo needs no checkout (repoDir undefined still detects); placeholders with no cwd => unknown', () => {
    const exec = fakeExec({ files: WATCHER, settings: settings(false) });
    expect(detectMergeMechanism(exec, undefined, { owner: 'o', name: 'r' }).watcherWorkflow).toBe(
      true
    );
    expect(detectMergeMechanism(exec, undefined, null).watcherWorkflow).toBeNull();
  });
  it('pins the api read to the verified repo and caches it until the TTL passes', () => {
    const calls: string[][] = [];
    const gt = createExecGroundTruth(fakeExec({ files: CI, settings: settings(false), calls }), {
      repoDir: '/r',
      repo: 'o/r',
    });
    gt.mergeMechanism?.();
    const firstRead = calls.length;
    gt.mergeMechanism?.();
    expect(calls).toHaveLength(firstRead); // cached inside the TTL: no second read of anything
    expect(calls[0][1]).toBe('repos/o/r');
    expect(calls.every((a) => a.some((x) => x.startsWith('repos/o/r')))).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    gt.mergeMechanism?.();
    vi.useRealTimers();
    expect(calls).toHaveLength(firstRead * 2); // TTL passed: the whole detection is re-read
  });
});

describe('shipModeClause (#887)', () => {
  it('confirmed: detached only after autoMergeRequest is verified, with a direct-merge fallback', () => {
    const c = shipModeClause(
      { nativeAutoMerge: true, watcherWorkflow: false, allowedMethods: ['squash'] },
      'issue'
    );
    expect(c).toContain('ship_mode=detached');
    expect(c).toContain('autoMergeRequest');
    expect(c).toContain('do NOT park');
  });
  it('none/undetected: attached, and names the loud block reason', () => {
    for (const m of [
      { nativeAutoMerge: false, watcherWorkflow: false, allowedMethods: [] },
      undefined,
    ]) {
      const c = shipModeClause(m, 'batch');
      expect(c).toContain('ship_mode=attached');
      expect(c).toContain('no-merge-mechanism');
    }
  });

  it('batch: native auto-merge alone never confirms a detached batch ship (watcher required)', () => {
    const native = { nativeAutoMerge: true, watcherWorkflow: false, allowedMethods: ['rebase'] };
    const c = shipModeClause(native, 'batch');
    expect(c).toContain('ship_mode=attached');
    expect(c).toContain('needs a label watcher');
    expect(shipModeClause({ ...native, watcherWorkflow: true }, 'batch')).toContain(
      'ship_mode=detached'
    );
    // the same facts DO confirm a per-issue detached ship
    expect(shipModeClause(native, 'issue')).toContain('ship_mode=detached');
  });
});

describe('advanceNoMergeMechanism (#921)', () => {
  const t0 = new Date('2026-09-29T10:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  it('arms on first sight, is not due inside the grace window, and is due after it', () => {
    const armed = advanceNoMergeMechanism(null, 7, t0);
    expect(armed).toEqual({ due: false, arm: '7@2026-09-29T10:00:00.000Z' });
    expect(advanceNoMergeMechanism(armed.arm, 7, at(5 * 60_000))).toEqual({
      due: false,
      arm: null,
    });
    expect(advanceNoMergeMechanism(armed.arm, 7, at(10 * 60_000)).due).toBe(true);
  });
  it('a marker for another PR (or garbage) re-arms instead of firing', () => {
    const old = '6@2026-09-29T09:00:00.000Z';
    expect(advanceNoMergeMechanism(old, 7, t0)).toEqual({
      due: false,
      arm: '7@2026-09-29T10:00:00.000Z',
    });
    expect(advanceNoMergeMechanism('7@nonsense', 7, t0).due).toBe(false);
  });
});
