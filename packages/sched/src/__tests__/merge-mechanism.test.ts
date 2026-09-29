import { describe, expect, it, vi } from 'vitest';
import { createExecGroundTruth, detectMergeMechanism } from '../groundtruth';
import {
  classifyWorkflowText,
  type MergeMechanism,
  mergeMechanismVerdict,
  parseRepoMergeSettings,
  shipModeClause,
} from '../merge-mechanism';

/** A fake exec over a remote tree: `files` maps a repo path to its text. */
function fakeExec(opts: {
  files?: Record<string, string>;
  settings?: string | null;
  noRef?: boolean;
}) {
  const files = opts.files ?? {};
  return (file: string, args: string[]): string | null => {
    if (file === 'gh') return opts.settings === undefined ? null : opts.settings;
    if (opts.noRef) return null;
    if (args[0] === 'ls-tree') {
      const paths = args.slice(args.indexOf('--') + 1).filter(() => args.includes('--'));
      if (args.includes('--')) return paths.filter((p) => p in files).join('\n');
      return Object.keys(files)
        .filter((f) => f.startsWith('.github/workflows/'))
        .join('\n');
    }
    if (args[0] === 'show') return files[args[1].split(':')[1]] ?? null;
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
  it('no readable remote ref, a Mergify config, or an unreadable file => watcher unknown', () => {
    expect(
      detectMergeMechanism(fakeExec({ noRef: true, settings: settings(false) }), '/r', null)
        .watcherWorkflow
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
    const unreadable = (file: string, args: string[]) =>
      file === 'git' && args[0] === 'show'
        ? null
        : fakeExec({ files: CI, settings: settings(false) })(file, args);
    expect(detectMergeMechanism(unreadable, '/r', null).watcherWorkflow).toBeNull();
  });
  it('pins the api read to the verified repo and caches it until the TTL passes', () => {
    const calls: string[][] = [];
    const gt = createExecGroundTruth(
      (f, args, cwd) => {
        if (f === 'gh') calls.push(args);
        return fakeExec({ files: CI, settings: settings(false) })(f, args, cwd);
      },
      { repoDir: '/r', repo: 'o/r' }
    );
    gt.mergeMechanism?.();
    gt.mergeMechanism?.();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('repos/o/r');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    gt.mergeMechanism?.();
    vi.useRealTimers();
    expect(calls).toHaveLength(2);
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
