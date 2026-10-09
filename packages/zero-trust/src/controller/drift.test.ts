import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSource, type SourceGitHubRead } from '../canonical/acquire';
import { createManifest, sha256 } from '../canonical/export';
import { type CommitInputs, createCandidate, reconstructCandidate } from '../canonical/reconstruct';
import { createRun, ReasonCode as R, type RunRecord, transitionRun } from '../state';
import { checkBase, checkShippingBase, rebaseCandidate, type ShippingBaseInput } from './drift';
import { WorkspaceOverlay } from './workspace-overlay';

const temps: string[] = [];
const upstream = { owner: 'owner', repo: 'repo', defaultBranch: 'main' };
const author = {
  login: 'alice',
  name: 'Alice',
  email: 'alice@example.org',
  timestamp: '2026-10-05T00:00:00Z',
};
const time = '2026-10-05T00:01:00.000Z';
function shipping(): RunRecord {
  return [R.GatePassed, R.PlanApproved, R.CandidateReady, R.VerificationPassed].reduce(
    (run, reason) => transitionRun(run, reason, time),
    createRun(
      {
        runId: 'drift-1',
        upstreamIssue: 'https://github.com/owner/repo/issues/1',
        contributor: 'alice',
      },
      time
    )
  );
}
function rig() {
  const root = fs.mkdtempSync(join(tmpdir(), 'zt-drift-'));
  temps.push(root);
  const git = (args: string[], input?: string) =>
    execFileSync('/usr/bin/git', ['-C', root, ...args], {
      input,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  git(['init', '--bare', '--template=', '.']);
  let head: string | undefined;
  const advance = (files: Record<string, string>, mode = '100644') => {
    const rows = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([file, bytes]) => `${mode} blob ${git(['hash-object', '-w', '--stdin'], bytes)}\t${file}\n`
      )
      .join('');
    const tree = git(['mktree'], rows);
    head = git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.org',
        'commit-tree',
        tree,
        ...(head ? ['-p', head] : []),
      ],
      'upstream\n'
    );
    git(['update-ref', 'refs/heads/main', head]);
    return head;
  };
  const baseSha = advance({ file: 'old', other: 'one' });
  const read: SourceGitHubRead = async (path) => {
    expect(path).toBe('/repos/owner/repo/branches/main');
    return { status: 200, body: { commit: { sha: git(['rev-parse', 'refs/heads/main']) } } };
  };
  const acquire = (base: string) =>
    acquireSource({ ...upstream, baseSha: base }, { remoteUrlForTest: pathToFileURL(root).href });
  const old = acquire(baseSha);
  const overlay = new WorkspaceOverlay(old.manifest);
  overlay.write('file', 'fixed');
  const approval: CommitInputs = {
    baseSha,
    author,
    committerTimestamp: '2026-10-05T00:01:00Z',
    message: 'fix defect\n',
  };
  const input: ShippingBaseInput = {
    run: shipping(),
    overlay,
    approval,
    rebases: 0,
    pushIntentJournaled: false,
  };
  const deps = {
    read,
    upstream,
    acquire: vi.fn(acquire),
    now: () => new Date('2026-10-05T00:02:00.000Z'),
  };
  return { advance, baseSha, old, overlay, approval, input, deps, acquire };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('upstream drift admission', () => {
  it('leaves an unchanged candidate alone, without acquiring or resetting session count', async () => {
    const f = rig();
    expect(await checkBase(f.deps.read, upstream, f.baseSha)).toEqual({ kind: 'unchanged' });
    const result = await checkShippingBase(f.deps, { ...f.input, rebases: 1 });
    expect(result).toEqual({ kind: 'unchanged', run: f.input.run, rebases: 1 });
    expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it('rebases onto a real advanced parent, preserving approved identity/message and requiring fresh verification', async () => {
    const f = rig();
    const before = createCandidate(
      createManifest([
        ...f.old.manifest.entries.filter((e) => e.path !== 'file'),
        ...f.overlay.writtenEntries(),
      ]),
      f.approval,
      f.old.pack
    );
    const next = f.advance({ file: 'old', other: 'two', new: 'upstream' });
    expect(await checkBase(f.deps.read, upstream, f.baseSha)).toEqual({
      kind: 'advanced',
      newSha: next,
    });
    const result = await checkShippingBase(f.deps, f.input);
    expect(result.kind).toBe('rebased');
    if (result.kind !== 'rebased') throw new Error('expected rebase');
    expect(result.run.state).toBe('verifying');
    expect(result.run.reasonCode).toBe(R.BaseAdvanced);
    expect(result.rebases).toBe(1);
    expect(result.candidate.record.baseSha).toBe(next);
    expect(result.candidate.record.author).toEqual(before.record.author);
    expect(result.candidate.record.message).toBe(before.record.message);
    expect(result.candidate.record.committerTimestamp).toBe('2026-10-05T00:02:00Z');
    expect(result.candidate.record.candidateSha).not.toBe(before.record.candidateSha);
    expect(result.candidate.authority.recordDigest).not.toBe(before.authority.recordDigest);
    expect(result.manifest.entries.find((e) => e.path === 'file')?.bytes).toBe(
      Buffer.from('fixed').toString('base64')
    );
    expect(result.manifest.entries.find((e) => e.path === 'other')?.bytes).toBe(
      Buffer.from('two').toString('base64')
    );
    expect(result.overlay.base).toEqual(f.acquire(next).manifest);
    expect(result.overlay.writtenEntries()).toEqual(f.overlay.writtenEntries());
    expect(
      reconstructCandidate(
        result.manifest,
        result.candidate.record,
        result.candidate.authority,
        f.acquire(next).pack
      ).record
    ).toEqual(result.candidate.record);
    // Old candidate-bound authority cannot authorize the new commit/tree.
    expect(() =>
      reconstructCandidate(result.manifest, before.record, before.authority, f.acquire(next).pack)
    ).toThrow();
    expect(() => transitionRun(result.run, R.PublicationObserved, time)).toThrow();
  });
  it.each([
    'changed',
    'deleted',
    'mode',
  ])('hands off touched-path %s without a candidate', async (kind) => {
    const f = rig();
    f.advance(
      kind === 'deleted'
        ? { other: 'two' }
        : { file: kind === 'changed' ? 'upstream change' : 'old', other: 'two' },
      kind === 'mode' ? '100755' : '100644'
    );
    expect(await checkShippingBase(f.deps, f.input)).toEqual({
      kind: 'hand_off',
      reason: 'rebase_conflict',
      paths: ['file'],
    });
    expect(f.input.run.state).toBe('shipping');
  });
  it('checks even byte-identical writes and freezes byte-sorted conflict paths', async () => {
    const f = rig();
    f.overlay.write('file', 'old');
    f.overlay.write('other', 'one');
    f.advance({ file: 'changed', other: 'changed' });
    const result = await checkShippingBase(f.deps, f.input);
    expect(result).toEqual({
      kind: 'hand_off',
      reason: 'rebase_conflict',
      paths: ['file', 'other'],
    });
    if (result.kind === 'hand_off') expect(Object.isFrozen(result.paths)).toBe(true);
  });
  it('preserves the two-rebase budget through verification; third advance stops before acquisition', async () => {
    const f = rig();
    let input = f.input;
    for (let n = 1; n <= 2; n++) {
      f.advance({ file: 'old', other: String(n) });
      const result = await checkShippingBase(
        { ...f.deps, now: () => new Date(`2026-10-05T00:0${n + 2}:00.000Z`) },
        input
      );
      if (result.kind !== 'rebased') throw new Error('expected rebase');
      expect(result.rebases).toBe(n);
      input = {
        ...input,
        overlay: result.overlay,
        approval: result.candidate.record,
        rebases: result.rebases,
        run: transitionRun(result.run, R.VerificationPassed, result.run.updatedAt),
      };
    }
    f.advance({ file: 'old', other: 'third' });
    f.deps.acquire.mockClear();
    expect(await checkShippingBase(f.deps, input)).toEqual({
      kind: 'hand_off',
      reason: 'base_unstable',
    });
    expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it.each([
    'intent',
    'pushed',
    'awaiting_contributor',
  ])('records %s drift only, names both SHAs and preserves lifecycle', async (phase) => {
    const f = rig();
    const next = f.advance({ file: 'conflicting change', other: 'two' });
    const run =
      phase === 'awaiting_contributor'
        ? transitionRun(f.input.run, R.ContributorHandoff, time)
        : f.input.run;
    const result = await checkShippingBase(f.deps, {
      ...f.input,
      run,
      pushIntentJournaled: phase !== 'awaiting_contributor',
      rebases: 2,
    });
    expect(result.kind).toBe('recorded');
    if (result.kind !== 'recorded') throw new Error('expected record');
    expect(result.run).toEqual(run);
    expect(result.observation.verifiedBase).toBe(f.baseSha);
    expect(result.observation.currentBase).toBe(next);
    expect(result.observation.limitation).toContain(f.baseSha);
    expect(result.observation.limitation).toContain(next);
    expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it('uses the same shipping guard after a revision', async () => {
    const f = rig();
    const run = [
      R.PublicationObserved,
      R.RevisionRequested,
      R.CandidateReady,
      R.VerificationPassed,
    ].reduce((r, reason) => transitionRun(r, reason, time), f.input.run);
    f.advance({ file: 'old', other: 'two' });
    const result = await checkShippingBase(f.deps, { ...f.input, run });
    expect(result.kind).toBe('rebased');
    if (result.kind === 'rebased') expect(result.run.state).toBe('verifying');
  });
  it.each([
    null,
    {},
    { commit: {} },
    { commit: { sha: 'truncated' } },
    { commit: { sha: 'A'.repeat(40) } },
  ])('fails closed on malformed base %j', async (body) => {
    const f = rig();
    const read: SourceGitHubRead = async () => ({ status: 200, body });
    expect(await checkBase(read, upstream, f.baseSha)).toEqual({ kind: 'unknown' });
    expect(await checkShippingBase({ ...f.deps, read }, f.input)).toEqual({
      kind: 'hand_off',
      reason: 'base_unknown',
    });
    expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it('does not expose read errors or unknown post-intent bases as verification', async () => {
    const f = rig();
    const read: SourceGitHubRead = async () => {
      throw new Error('private read failure');
    };
    expect(await checkBase(read, upstream, f.baseSha)).toEqual({ kind: 'unknown' });
    expect(await checkBase(read, upstream, 'bad')).toEqual({ kind: 'unknown' });
    expect(await checkBase(async () => ({ status: 404, body: {} }), upstream, f.baseSha)).toEqual({
      kind: 'unknown',
    });
    const result = await checkShippingBase(
      { ...f.deps, read },
      { ...f.input, pushIntentJournaled: true }
    );
    expect(result.kind).toBe('recorded');
    if (result.kind === 'recorded') expect(result.observation.currentBase).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private read failure');
    const same = await checkShippingBase(f.deps, { ...f.input, pushIntentJournaled: true });
    if (same.kind !== 'recorded') throw new Error('expected record');
    expect(same.observation.currentBase).toBe(f.baseSha);
  });
  it.each([-1, 3, NaN, 0.5])('refuses invalid session count %s', async (rebases) => {
    const f = rig();
    await expect(checkShippingBase(f.deps, { ...f.input, rebases })).rejects.toThrow();
    expect(f.deps.acquire).not.toHaveBeenCalled();
  });
  it('refuses unrelated phases and malformed push-intent/base facts', async () => {
    const f = rig();
    await expect(
      checkShippingBase(f.deps, {
        ...f.input,
        run: transitionRun(f.input.run, R.BaseAdvanced, time),
      })
    ).rejects.toThrow();
    await expect(
      checkShippingBase(f.deps, { ...f.input, pushIntentJournaled: undefined as never })
    ).rejects.toThrow();
    await expect(
      checkShippingBase(f.deps, { ...f.input, approval: { ...f.approval, baseSha: 'bad' } })
    ).rejects.toThrow();
  });
  it('hands off failed acquisition, manifest binding and non-advancing clocks without leaking errors', async () => {
    const f = rig();
    f.advance({ file: 'old', other: 'two' });
    for (const deps of [
      {
        ...f.deps,
        acquire: () => {
          throw new Error('private acquisition failure');
        },
      },
      { ...f.deps, acquire: () => f.old },
      { ...f.deps, now: () => new Date('2026-10-05T00:00:00Z') },
      { ...f.deps, now: () => new Date(NaN) },
    ])
      expect(await checkShippingBase(deps, f.input)).toEqual({
        kind: 'hand_off',
        reason: 'rebase_unavailable',
      });
  });
});

describe('synthetic structural overlays', () => {
  const file = (path: string, text: string) => ({
    path,
    mode: '100644' as const,
    bytes: Buffer.from(text).toString('base64'),
    sha256: sha256(text),
  });
  it('rejects an overlay based on a different old manifest', () => {
    const f = rig();
    expect(() =>
      rebaseCandidate({
        overlay: f.overlay,
        oldBaseManifest: createManifest([]),
        newBase: f.old,
        approval: f.approval,
      })
    ).toThrow();
  });
  it('rejects a forged new manifest that disagrees with the pack', () => {
    const f = rig();
    expect(() =>
      rebaseCandidate({
        overlay: f.overlay,
        oldBaseManifest: f.old.manifest,
        newBase: { pack: f.old.pack, manifest: createManifest([file('different', 'x')]) },
        approval: f.approval,
      })
    ).toThrow();
  });
  it('handles added files/directories and refuses an upstream ancestor replacing a directory', () => {
    const f = rig();
    const overlay = new WorkspaceOverlay(f.old.manifest);
    overlay.write('dir/new.test.ts', 'test');
    overlay.write('new.txt', 'added');
    const next = f.advance({ file: 'old', other: 'two' });
    const result = rebaseCandidate({
      overlay,
      oldBaseManifest: f.old.manifest,
      newBase: f.acquire(next),
      approval: { ...f.approval, baseSha: next, committerTimestamp: '2026-10-05T00:02:00Z' },
    });
    expect(result.kind).toBe('rebased');
    if (result.kind === 'rebased') {
      expect(result.manifest.entries.map((e) => e.path)).toEqual([
        'dir',
        'dir/new.test.ts',
        'file',
        'new.txt',
        'other',
      ]);
      expect(result.overlay.testFiles()).toEqual(['dir/new.test.ts']);
    }
    const collision = f.advance({ file: 'old', other: 'two', dir: 'file now' });
    expect(
      rebaseCandidate({
        overlay,
        oldBaseManifest: f.old.manifest,
        newBase: f.acquire(collision),
        approval: { ...f.approval, baseSha: collision },
      })
    ).toEqual({ kind: 'conflict', paths: ['dir/new.test.ts'] });
  });
  it('refuses concurrent upstream creation of an overlay-added path', () => {
    const f = rig();
    f.overlay.write('added', 'mine');
    const next = f.advance({ file: 'old', other: 'one', added: 'theirs' });
    expect(
      rebaseCandidate({
        overlay: f.overlay,
        oldBaseManifest: f.old.manifest,
        newBase: f.acquire(next),
        approval: { ...f.approval, baseSha: next },
      })
    ).toEqual({ kind: 'conflict', paths: ['added'] });
  });
});
