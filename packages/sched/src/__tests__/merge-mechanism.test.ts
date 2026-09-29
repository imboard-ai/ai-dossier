import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecGroundTruth, detectMergeMechanism } from '../groundtruth';
import {
  type MergeMechanism,
  mergeMechanismVerdict,
  parseRepoMergeSettings,
  shipModeClause,
  workflowActsOnAutoMergeLabel,
} from '../merge-mechanism';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(workflows: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sched-mm-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  for (const [f, text] of Object.entries(workflows)) {
    writeFileSync(join(dir, '.github', 'workflows', f), text);
  }
  return dir;
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

describe('workflowActsOnAutoMergeLabel', () => {
  it('matches a label-triggered watcher', () => {
    expect(
      workflowActsOnAutoMergeLabel(
        "on:\n  pull_request:\n    types: [labeled]\njobs:\n  m:\n    if: contains(github.event.pull_request.labels.*.name, 'auto-merge')"
      )
    ).toBe(true);
  });
  it('does not match an unrelated workflow', () => {
    expect(workflowActsOnAutoMergeLabel('on: push\njobs: {}')).toBe(false);
  });
});

describe('detectMergeMechanism (#887)', () => {
  it('a repo with no watcher workflow and auto-merge disabled is none', () => {
    const dir = repoWith({ 'ci.yml': 'on: push\njobs: {}' });
    const m = detectMergeMechanism(() => settings(false), dir, null);
    expect(mergeMechanismVerdict(m)).toBe('none');
  });
  it('native auto-merge allowed is confirmed', () => {
    const dir = repoWith({});
    expect(mergeMechanismVerdict(detectMergeMechanism(() => settings(true), dir, null))).toBe(
      'confirmed'
    );
  });
  it('a watcher workflow is confirmed even when the api read fails', () => {
    const dir = repoWith({
      'w.yml': "on: pull_request\njobs:\n  a:\n    if: contains(labels, 'auto-merge')",
    });
    expect(mergeMechanismVerdict(detectMergeMechanism(() => null, dir, null))).toBe('confirmed');
  });
  it('a failed api read with no watcher is unknown, never none', () => {
    const dir = repoWith({});
    expect(mergeMechanismVerdict(detectMergeMechanism(() => null, dir, null))).toBe('unknown');
  });
  it('pins the api read to the verified repo and caches it', () => {
    const dir = repoWith({});
    const calls: string[][] = [];
    const gt = createExecGroundTruth(
      (_f, args) => {
        calls.push(args);
        return settings(false);
      },
      { repoDir: dir, repo: 'o/r' }
    );
    gt.mergeMechanism?.();
    gt.mergeMechanism?.();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('repos/o/r');
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
