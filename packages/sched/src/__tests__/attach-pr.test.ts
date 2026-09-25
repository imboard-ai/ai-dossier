/**
 * #824: `sched attach-pr --batch <id> <pr>` — the operator's explicit verb for
 * recording `batch.pr` after #789's automatic detection refused to guess.
 * Every refusal must leave the ledger AND the journal untouched; the one
 * success path records the PR, clears the ambiguity streak, journals its own
 * `pr-attached` event, and closes nothing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachBatchPr } from '../attach-pr';
import { createExecGroundTruth, type GroundTruth } from '../groundtruth';
import { Journal } from '../journal';
import { SchedStore } from '../persist';
import { findBatch, PR_DETECT_AMBIGUOUS_REASON, patchBatch, transitionBatch } from '../state';
import { withBlockedBatch } from './helpers/blocked-batch';
import { stubGroundTruth } from './helpers/ground-truth';
import { recording, recordingReturns } from './helpers/recording-exec';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BATCH = 'b-824-01';
const BRANCH = 'batch/b-824-01-20260925';
const SETUP_AT = new Date('2026-09-25T00:00:00.000Z');
const NOW = new Date('2026-09-25T06:00:00.000Z');
const MERGED_AT = '2026-09-25T03:00:00Z';
const CREATED_AT = '2026-09-25T01:00:00Z';

/** A store holding one `blocked` batch (branch recorded, pr null) with a live ambiguity streak. */
function blockedStore(
  opts: { status?: 'blocked' | 'executing'; pr?: number | null; undispatched?: number[] } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-attach-pr-'));
  dirs.push(dir);
  const store = new SchedStore(dir);
  let state = withBlockedBatch(store.load(), {
    batchId: BATCH,
    member: 8241,
    anchor: 8240,
    branch: BRANCH,
    at: SETUP_AT,
    undispatched: opts.undispatched,
  });
  if (opts.status === 'executing') {
    state = transitionBatch(state, BATCH, 'executing', { blocked_reason: null }, SETUP_AT);
  }
  state = patchBatch(
    state,
    BATCH,
    {
      pr: opts.pr ?? null,
      pr_detect_ambiguous_reason: PR_DETECT_AMBIGUOUS_REASON,
      pr_detect_ambiguous_since: SETUP_AT.toISOString(),
      pr_detect_ambiguous_ticks: 5,
    },
    SETUP_AT,
    false
  );
  store.withLock(() => ({ state, result: undefined }));
  return { store, journal: new Journal(store.dir) };
}

/** The `gh pr view` payload of the batch's own, genuinely merged PR. */
function goodPr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 4270,
    state: 'MERGED',
    headRefName: BRANCH,
    baseRefName: 'main',
    isCrossRepository: false,
    mergedAt: MERGED_AT,
    createdAt: CREATED_AT,
    ...over,
  };
}

function truthWith(candidate: Record<string, unknown> | undefined): GroundTruth {
  return stubGroundTruth({ batchPrCandidate: () => candidate });
}

/** Snapshot of everything a refusal must leave untouched. */
function snapshot(store: SchedStore, journal: Journal) {
  return { state: JSON.stringify(store.load()), events: journal.read().length };
}

describe('attachBatchPr (#824): happy path', () => {
  it('records batch.pr under the lock, clears the ambiguity streak, journals pr-attached — and changes nothing else', () => {
    const { store, journal } = blockedStore();
    const before = findBatch(store.load(), BATCH);

    const result = attachBatchPr(
      { store, journal, groundTruth: truthWith(goodPr()) },
      BATCH,
      4270,
      NOW
    );

    expect(result).toEqual({
      outcome: 'attached',
      pr: 4270,
      mergedAt: MERGED_AT,
      clearedAmbiguousTicks: 5,
    });
    const after = findBatch(store.load(), BATCH);
    expect(after?.pr).toBe(4270);
    // The streak is cleared (AC1) ...
    expect(after?.pr_detect_ambiguous_reason).toBeNull();
    expect(after?.pr_detect_ambiguous_since).toBeNull();
    expect(after?.pr_detect_ambiguous_ticks).toBe(0);
    // ... but recording is ALL it does: no transition, no anchor write.
    expect(after?.status).toBe('blocked');
    expect(after?.blocked_reason).toBe(before?.blocked_reason);
    expect(after?.anchor_closed_at).toBeNull();
    expect(after?.updated_at).toBe(NOW.toISOString()); // re-arms the reconcile window
  });

  it('journals the operator action as pr-attached — distinct from automatic detection', () => {
    const { store, journal } = blockedStore();
    attachBatchPr({ store, journal, groundTruth: truthWith(goodPr()) }, BATCH, 4270, NOW);

    const events = journal.read();
    expect(events.map((e) => e.event)).toEqual(['pr-attached']);
    const ev = events[0];
    expect(ev.unit).toBe(`batch:${BATCH}`);
    expect(ev.pr).toBe(4270);
    expect(ev.mergedAt).toBe(MERGED_AT);
    expect(String(ev.detail)).toContain('operator attached PR #4270');
    expect(String(ev.detail)).toContain('cleared the pr-detect-ambiguous streak (5 tick(s))');
    // Never the automatic path's shape.
    expect(events.some((e) => e.event === 'stale-failure-reconciled')).toBe(false);
    expect((ev as Record<string, unknown>).pr_detected).toBeUndefined();
  });

  it('accepts a batch with no open ambiguity streak (Step 6b manual recovery) and says nothing about one', () => {
    const { store, journal } = blockedStore();
    store.withLock((s) => ({
      state: patchBatch(
        s,
        BATCH,
        {
          pr_detect_ambiguous_reason: null,
          pr_detect_ambiguous_since: null,
          pr_detect_ambiguous_ticks: 0,
        },
        SETUP_AT,
        false
      ),
      result: undefined,
    }));
    const r = attachBatchPr({ store, journal, groundTruth: truthWith(goodPr()) }, BATCH, 4270, NOW);
    expect(r).toMatchObject({ outcome: 'attached', clearedAmbiguousTicks: 0 });
    expect(String(journal.read()[0]?.detail)).not.toContain('pr-detect-ambiguous');
  });
});

describe('attachBatchPr (#824): every refusal records nothing and journals nothing', () => {
  const PR_REFUSALS: Array<{ name: string; candidate: Record<string, unknown>; message: RegExp }> =
    [
      {
        name: 'a fork PR (isCrossRepository=true)',
        candidate: goodPr({ isCrossRepository: true }),
        message: /from a fork/,
      },
      {
        name: 'a PR whose same-repo flag is unreadable',
        candidate: goodPr({ isCrossRepository: undefined }),
        message: /isCrossRepository unreadable/,
      },
      {
        name: 'an unmerged (OPEN) PR',
        candidate: goodPr({ state: 'OPEN', mergedAt: null }),
        message: /"OPEN", not MERGED/,
      },
      {
        name: 'a CLOSED-unmerged PR',
        candidate: goodPr({ state: 'CLOSED', mergedAt: null }),
        message: /"CLOSED", not MERGED/,
      },
      {
        name: 'a MERGED state with no real merge timestamp',
        candidate: goodPr({ mergedAt: 'yesterday' }),
        message: /no merge timestamp/,
      },
      {
        name: 'a PR against the wrong base',
        candidate: goodPr({ baseRefName: 'release' }),
        message: /base is "release", not the batch base "main"/,
      },
      {
        name: 'a PR from the wrong head branch',
        candidate: goodPr({ headRefName: 'feature/other' }),
        message: /head is "feature\/other", not the batch branch/,
      },
      {
        name: 'a PR created before the batch (an earlier use of the branch)',
        candidate: goodPr({ createdAt: '2026-09-01T00:00:00Z' }),
        message: /before the batch itself/,
      },
      {
        name: 'a payload answering for a different PR number',
        candidate: goodPr({ number: 9999 }),
        message: /answered for PR 9999, not #4270/,
      },
    ];

  for (const c of PR_REFUSALS) {
    it(`refuses ${c.name}`, () => {
      const { store, journal } = blockedStore();
      const before = snapshot(store, journal);
      expect(() =>
        attachBatchPr({ store, journal, groundTruth: truthWith(c.candidate) }, BATCH, 4270, NOW)
      ).toThrow(c.message);
      expect(snapshot(store, journal)).toEqual(before);
    });
  }

  it('refuses when the project repo is unverified — no batchPrCandidate means no PR is read at all', () => {
    const { store, journal } = blockedStore();
    const before = snapshot(store, journal);
    expect(() =>
      attachBatchPr({ store, journal, groundTruth: stubGroundTruth() }, BATCH, 4270, NOW)
    ).toThrow(/repository is not verified/);
    expect(snapshot(store, journal)).toEqual(before);
  });

  it('refuses when the gh read fails (fail closed, never "not found = fine")', () => {
    const { store, journal } = blockedStore();
    const before = snapshot(store, journal);
    expect(() =>
      attachBatchPr({ store, journal, groundTruth: truthWith(undefined) }, BATCH, 4270, NOW)
    ).toThrow(/could not read it from the project repository/);
    expect(snapshot(store, journal)).toEqual(before);
  });

  it('names the verified repo and the exact gh command when the read fails', () => {
    const { store, journal } = blockedStore();
    expect(() =>
      attachBatchPr(
        { store, journal, groundTruth: truthWith(undefined), repo: 'imboard-ai/imboard' },
        BATCH,
        4270,
        NOW
      )
    ).toThrow(/`gh pr view 4270 -R imboard-ai\/imboard` failed/);
  });

  it('refuses a batch with a surviving member that was never dispatched — the reconcile would never act on the PR', () => {
    const { store, journal } = blockedStore({ undispatched: [8242] });
    expect(findBatch(store.load(), BATCH)?.members).toContain(8242);
    const before = snapshot(store, journal);
    let read = 0;
    const groundTruth = stubGroundTruth({
      batchPrCandidate: () => {
        read++;
        return goodPr();
      },
    });
    expect(() => attachBatchPr({ store, journal, groundTruth }, BATCH, 4270, NOW)).toThrow(
      /member\(s\) #8242 that were never dispatched/
    );
    expect(snapshot(store, journal)).toEqual(before);
    expect(read).toBe(0);
  });

  it('refuses a different PR when batch.pr is already set', () => {
    const { store, journal } = blockedStore({ pr: 4100 });
    const before = snapshot(store, journal);
    let read = 0;
    const groundTruth = stubGroundTruth({
      batchPrCandidate: () => {
        read++;
        return goodPr();
      },
    });
    expect(() => attachBatchPr({ store, journal, groundTruth }, BATCH, 4270, NOW)).toThrow(
      /already has PR #4100 recorded — refusing to replace it with #4270/
    );
    expect(snapshot(store, journal)).toEqual(before);
    expect(read).toBe(0); // refused on the ledger alone, before any GitHub read
  });

  it('the SAME PR already recorded is a no-op — nothing read, written or journaled', () => {
    const { store, journal } = blockedStore({ pr: 4270 });
    const before = snapshot(store, journal);
    let read = 0;
    const groundTruth = stubGroundTruth({
      batchPrCandidate: () => {
        read++;
        return goodPr();
      },
    });
    expect(attachBatchPr({ store, journal, groundTruth }, BATCH, 4270, NOW)).toEqual({
      outcome: 'already-attached',
      pr: 4270,
    });
    expect(snapshot(store, journal)).toEqual(before);
    expect(read).toBe(0);
  });

  it('refuses a batch that is not blocked, naming its status', () => {
    const { store, journal } = blockedStore({ status: 'executing' });
    const before = snapshot(store, journal);
    expect(() =>
      attachBatchPr({ store, journal, groundTruth: truthWith(goodPr()) }, BATCH, 4270, NOW)
    ).toThrow(/Batch b-824-01 is executing — attach-pr only applies to a blocked batch/);
    expect(snapshot(store, journal)).toEqual(before);
  });

  it('refuses a blocked batch with no branch recorded', () => {
    const { store, journal } = blockedStore();
    store.withLock((s) => ({
      state: patchBatch(s, BATCH, { branch: null }, SETUP_AT, false),
      result: undefined,
    }));
    const before = snapshot(store, journal);
    expect(() =>
      attachBatchPr({ store, journal, groundTruth: truthWith(goodPr()) }, BATCH, 4270, NOW)
    ).toThrow(/no branch recorded/);
    expect(snapshot(store, journal)).toEqual(before);
  });

  it('refuses an unknown batch and a non-positive PR number', () => {
    const { store, journal } = blockedStore();
    const groundTruth = truthWith(goodPr());
    expect(() => attachBatchPr({ store, journal, groundTruth }, 'nope', 4270, NOW)).toThrow(
      /Batch not found: nope/
    );
    expect(() => attachBatchPr({ store, journal, groundTruth }, BATCH, 0, NOW)).toThrow(
      /positive integer/
    );
  });

  it('re-checks the ledger under the lock: a batch that left blocked during the GitHub read is refused, not written over', () => {
    const { store, journal } = blockedStore();
    const groundTruth = stubGroundTruth({
      batchPrCandidate: () => {
        // `sched resume --batch` lands while gh is answering.
        store.withLock((s) => ({
          state: transitionBatch(s, BATCH, 'executing', {}, NOW),
          result: undefined,
        }));
        return goodPr();
      },
    });
    expect(() => attachBatchPr({ store, journal, groundTruth }, BATCH, 4270, NOW)).toThrow(
      /is executing/
    );
    expect(findBatch(store.load(), BATCH)?.pr).toBeNull();
    expect(journal.read()).toHaveLength(0);
  });

  it('re-runs the candidate checks under the lock: a batch whose branch changed during the GitHub read is refused', () => {
    const { store, journal } = blockedStore();
    const groundTruth = stubGroundTruth({
      batchPrCandidate: () => {
        store.withLock((s) => ({
          state: patchBatch(s, BATCH, { branch: 'batch/b-824-01-rebuilt' }, NOW, false),
          result: undefined,
        }));
        return goodPr();
      },
    });
    expect(() => attachBatchPr({ store, journal, groundTruth }, BATCH, 4270, NOW)).toThrow(
      /not the batch branch "batch\/b-824-01-rebuilt"/
    );
    expect(findBatch(store.load(), BATCH)?.pr).toBeNull();
    expect(journal.read()).toHaveLength(0);
  });
});

describe('createExecGroundTruth.batchPrCandidate (#824)', () => {
  it('is absent without a verified repo — never reads a PR from the cwd repository', () => {
    expect(createExecGroundTruth(() => '{}').batchPrCandidate).toBeUndefined();
    expect(
      createExecGroundTruth(() => '{}', { repo: '--repo=evil' }).batchPrCandidate
    ).toBeUndefined();
  });

  it('pins every read with -R <owner/name> and asks for the fields the checks need', () => {
    const rec = recordingReturns(JSON.stringify(goodPr()));
    const gt = createExecGroundTruth(rec.exec, { repo: 'imboard-ai/imboard' });
    expect(gt.batchPrCandidate?.(4270)).toEqual(goodPr());
    expect(rec.calls).toHaveLength(1);
    const { file, args } = rec.calls[0];
    expect(file).toBe('gh');
    expect(args.slice(0, 3)).toEqual(['pr', 'view', '4270']);
    expect(args[args.indexOf('-R') + 1]).toBe('imboard-ai/imboard');
    expect(args[args.indexOf('--json') + 1]).toBe(
      'state,number,headRefName,baseRefName,isCrossRepository,mergedAt,createdAt'
    );
  });

  it('prState — the read that settles an attached PR — is pinned with -R too when the repo is verified', () => {
    const payload = JSON.stringify({ state: 'MERGED', mergedAt: MERGED_AT });
    const pinned = recordingReturns(payload);
    createExecGroundTruth(pinned.exec, { repo: 'imboard-ai/imboard' }).prState(4270);
    expect(pinned.calls[0]?.args[pinned.calls[0].args.indexOf('-R') + 1]).toBe(
      'imboard-ai/imboard'
    );
    // Without a verified repo nothing changes (the pre-#824 cwd-resolved read).
    const unpinned = recordingReturns(payload);
    createExecGroundTruth(unpinned.exec).prState(4270);
    expect(unpinned.calls[0]?.args).not.toContain('-R');
  });

  it('a failed gh call or a non-object payload is unreadable (undefined)', () => {
    expect(
      createExecGroundTruth(() => null, { repo: 'o/r' }).batchPrCandidate?.(1)
    ).toBeUndefined();
    expect(
      createExecGroundTruth(() => '[]', { repo: 'o/r' }).batchPrCandidate?.(1)
    ).toBeUndefined();
    expect(
      createExecGroundTruth(() => 'not json', { repo: 'o/r' }).batchPrCandidate?.(1)
    ).toBeUndefined();
  });

  it('never runs gh for a non-positive PR number', () => {
    const rec = recording(() => '{}');
    const gt = createExecGroundTruth(rec.exec, { repo: 'o/r' });
    expect(gt.batchPrCandidate?.(0)).toBeUndefined();
    expect(gt.batchPrCandidate?.(-3)).toBeUndefined();
    expect(rec.calls).toHaveLength(0);
  });
});
