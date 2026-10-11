/** Gate 4 upstream acceptance (#1114): real createController, local Git and physical edge
 * fakes. Each title identifies the actor, expected outcome and owning PRD release slices;
 * the shared audit (`gate4-audit.ts`) checks the global invariants after every scenario. */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TrustedGit } from '../canonical/trusted-git';
import type { StopNotice } from '../controller/steps';
import { loadVerification } from '../controller/verification-record';
import { OWNER } from '../github/__tests__/github-fake';
import type { FreshnessReport } from '../policy/freshness';
import * as receipts from '../receipt/issue';
import { ReasonCode } from '../state';
import { MAX_REPORT_BYTES } from '../vm/adapter';
import { junit } from './fake-vm';
import { assertGlobalInvariants, forkPushes, gate4Suite, type Rig, rows } from './gate4-audit';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const fixture = gate4Suite();
// Captured before the suite hooks spy on the prototype: the real transport.
const realExecAsync = TrustedGit.prototype.execAsync;

type Run = { runId: string; state: string };
const FORK_REF = `/repos/${OWNER}/fixture/git/ref/heads/`;

/** Fires once, on the first fork-branch read while the run is shipping: the push preflight,
 * i.e. after implementation and verification and before any push. */
function beforePush(h: () => Rig, act: () => void) {
  let done = false;
  return async (p: string) => {
    if (!done && p.startsWith(FORK_REF) && h().controller.snapshot().state === 'shipping') {
      done = true;
      act();
    }
  };
}

/** A permission policy first needs the engagement comment and a maintainer invitation. */
async function gateThroughInvitation(h: Rig) {
  const gated = (await h.authorize(h.controller.start(h.config))) as Run;
  expect(gated.state).toBe('awaiting_contributor');
  h.submitEngagement(gated.runId);
  expect(((await h.authorize(h.controller.resume(gated.runId))) as Run).state).toBe(
    'awaiting_maintainer'
  );
  h.invite();
  return (await h.authorize(h.controller.resume(gated.runId))) as Run;
}

/** Initial publication observed; the next resume can revise the same PR. */
async function published(h: Rig, run?: Run) {
  const started = run ?? ((await h.authorize(h.controller.start(h.config))) as Run);
  expect(started.state).toBe('awaiting_contributor');
  h.submit(started.runId);
  expect(((await h.authorize(h.controller.resume(started.runId))) as Run).state).toBe('submitted');
  h.advanceClock();
  return started.runId;
}

function held(h: Rig, id: string) {
  const a = h.artifacts(id);
  try {
    return {
      branch: `ztfc/${a.store.contributionId}`,
      candidate: a.get<{ record: { candidateSha: string; baseSha: string } }>('candidate')?.record,
      notice: a.get<StopNotice>('stop_notice'),
      artifacts: Object.fromEntries(
        [
          'drift_handoff',
          'regression',
          'engagement',
          'publication',
          'revision_freshness',
          'shipping_base',
          'shipping_block',
          'shipping_freshness',
          'tracking',
        ].map((key) => [key, a.get<unknown>(key)])
      ) as Record<string, unknown>,
      dir: a.dir,
      history: a.store.run.history,
    };
  } finally {
    a.close();
  }
}

function links(h: Rig) {
  return rows(h, 'handoff').filter((row) => row.type === 'link_issued');
}

/** Receipt authorizations actually consumed (nonce rows other than the store header). */
function consumed(h: Rig) {
  return rows(h, 'nonces').filter((row) => row.type !== 'receipt-nonces');
}

async function issuedReceipts() {
  return Promise.all(
    vi
      .mocked(receipts.issueReceipt)
      .mock.results.map((result) => result.value as Promise<receipts.SignedReceipt>)
  );
}

function verificationRecords(dir: string) {
  const directory = path.join(dir, 'verification');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => /^[a-f0-9]{40}\.json$/u.test(name))
    : [];
}

describe('gate 4 upstream: API-response loss', () => {
  it('actor=GitHub transport outcome=lost push acknowledgment reconciled from the remote SHA, no second push owner=S4', async () => {
    const h = fixture();
    let dropped = false;
    vi.mocked(TrustedGit.prototype.execAsync).mockImplementation(async function (
      this: TrustedGit,
      args,
      options
    ) {
      const result = await realExecAsync.call(this, args, options);
      // The bare repository accepted the push; only its answer is lost.
      if (!dropped && args[0] === 'push') {
        dropped = true;
        throw new Error('connection reset after the ref moved');
      }
      return result;
    });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
    });
    const id = h.controller.snapshot().runId;
    const before = held(h, id);
    expect(h.controller.snapshot().state).toBe('shipping');
    expect(h.fork.sha(before.branch)).toBe(before.candidate?.candidateSha);
    expect(rows(h, 'intents').map((row) => row.type)).toEqual([
      'run',
      'intended',
      'attempted',
      'ambiguous',
    ]);
    expect(links(h)).toHaveLength(0);
    expect(((await h.authorize(h.controller.resume(id))) as Run).state).toBe(
      'awaiting_contributor'
    );
    expect(forkPushes(h)).toHaveLength(1);
    expect(rows(h, 'intents').filter((row) => row.type === 'confirmed')).toEqual([
      expect.objectContaining({ remoteSha: before.candidate?.candidateSha }),
    ]);
    expect(rows(h, 'intents').some((row) => row.type === 'absent')).toBe(false);
    expect(links(h)).toHaveLength(1);
  });

  it('actor=contributor outcome=unobserved prefilled PR found once by head, base, state=all and marker owner=S4', async () => {
    const h = fixture();
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    h.submit(run.runId);
    const listings: string[] = [];
    // The submission happened, but the run's listing answer is lost.
    h.interceptRead((p) => {
      if (!p.startsWith('/repos/upstream/fixture/pulls?')) return undefined;
      listings.push(p);
      return { status: 502, body: null };
    });
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe(
      'awaiting_contributor'
    );
    expect(listings.some((p) => p.includes('state=all') && p.includes('head='))).toBe(true);
    expect(links(h)).toHaveLength(1);
    h.interceptRead(undefined);
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe('submitted');
    expect(held(h, run.runId).artifacts.publication).toMatchObject({
      url: 'https://github.com/upstream/fixture/pull/8',
    });
    expect(links(h)).toHaveLength(1);
    expect(rows(h, 'handoff').filter((row) => row.type === 'handoff_observed')).toHaveLength(1);
  });

  it('actor=contributor outcome=double submission is an ambiguous hand-off, never a third link owner=S4', async () => {
    const h = fixture();
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    h.submit(run.runId, 2);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe(
        'awaiting_contributor'
      );
      expect(links(h)).toHaveLength(1);
      expect(rows(h, 'handoff').some((row) => row.type === 'handoff_observed')).toBe(false);
    }
    const after = held(h, run.runId);
    expect(after.artifacts.publication).toBeUndefined();
    // Status names the ambiguity instead of pointing back at the prefilled link.
    expect(after.notice).toMatchObject({
      state: 'awaiting_contributor',
      historyLength: after.history.length,
      reason: 'ambiguous:multiple_matches',
      nextPermittedAction: expect.stringContaining('No new link will be issued'),
    });
  });

  it('actor=contributor outcome=unobserved engagement comment reconciled after restart without a duplicate request owner=S2', async () => {
    const h = fixture({ policy: 'permission' });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('awaiting_contributor');
    h.submitEngagement(run.runId);
    h.interceptRead((p) =>
      p.includes('/issues/7/comments?') ? { status: 502, body: null } : undefined
    );
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe(
      'awaiting_contributor'
    );
    h.interceptRead(undefined);
    // A new controller process: only durable journals carry the issued request.
    const reopened = h.reopen();
    expect(((await h.authorize(reopened.resume(run.runId), reopened)) as Run).state).toBe(
      'awaiting_maintainer'
    );
    expect(links(h)).toHaveLength(1);
    expect(links(h)[0]?.input).toMatchObject({ operationKind: 'engagement_comment' });
    expect(rows(h, 'handoff').filter((row) => row.type === 'handoff_observed')).toHaveLength(1);
    expect(held(h, run.runId).artifacts.engagement).toMatchObject({
      url: 'https://github.com/upstream/fixture/issues/7#issuecomment-9',
    });
  });
});

const POLICY_CHANGES = [
  { change: 'AI ban', reason: 'policy_changed' },
  { change: 'issue closure', reason: 'issue_closed' },
  { change: 'invitation revocation', reason: 'invitation_revoked' },
] as const;

function applyPolicyChange(h: Rig, change: (typeof POLICY_CHANGES)[number]['change']) {
  if (change === 'AI ban') h.banPolicy();
  if (change === 'issue closure') h.closeIssue();
  if (change === 'invitation revocation') h.revokeInvitation();
}

describe('gate 4 upstream: policy changes', () => {
  it.each(
    POLICY_CHANGES
  )('actor=maintainer outcome=$change after implementation blocks before any receipt, evidence retained owner=S2/S4', async ({
    change,
    reason,
  }) => {
    let h!: Rig;
    h = fixture({
      ...(change === 'invitation revocation' ? { policy: 'permission' as const } : {}),
      beforeRead: beforePush(
        () => h,
        () => applyPolicyChange(h, change)
      ),
    });
    const run =
      change === 'invitation revocation'
        ? await gateThroughInvitation(h)
        : ((await h.authorize(h.controller.start(h.config))) as Run);
    expect(run.state).toBe('blocked');
    expect(h.controller.snapshot().history.at(-1)).toMatchObject({
      from: 'shipping',
      to: 'blocked',
      reasonCode: ReasonCode.PolicyBlocked,
    });
    expect(vi.mocked(receipts.issueReceipt)).not.toHaveBeenCalled();
    expect(consumed(h)).toEqual([]);
    expect(forkPushes(h)).toHaveLength(0);
    const after = held(h, run.runId);
    expect(
      loadVerification(after.dir, after.candidate?.candidateSha as string, { runId: run.runId })
        .verdict
    ).toBe('passed');
    expect(after.artifacts.shipping_freshness).toMatchObject({ fresh: false, reasons: [reason] });
    expect(after.notice).toMatchObject({
      state: 'blocked',
      historyLength: after.history.length,
      reason,
    });
    const calls = h.modelCalls();
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe('blocked');
    expect(h.modelCalls()).toBe(calls);
    expect(forkPushes(h)).toHaveLength(0);
  });

  it.each(
    POLICY_CHANGES
  )('actor=maintainer outcome=$change during a revision blocks before the revision push, evidence retained owner=S2/S5', async ({
    change,
    reason,
  }) => {
    let h!: Rig;
    let revising = false;
    let changed = false;
    h = fixture({
      ...(change === 'invitation revocation' ? { policy: 'permission' as const } : {}),
      // The revision is implemented and its fresh verification starts; then the change lands.
      beforeExec: async () => {
        if (revising && !changed && h.controller.snapshot().state === 'verifying') {
          changed = true;
          applyPolicyChange(h, change);
        }
      },
    });
    const id = await published(
      h,
      change === 'invitation revocation' ? await gateThroughInvitation(h) : undefined
    );
    const pushes = forkPushes(h).length;
    const issued = vi.mocked(receipts.issueReceipt).mock.calls.length;
    const before = held(h, id);
    h.feedback();
    revising = true;
    expect(((await h.authorize(h.controller.resume(id, { revise: true }))) as Run).state).toBe(
      'blocked'
    );
    expect(changed).toBe(true);
    expect(forkPushes(h)).toHaveLength(pushes);
    expect(vi.mocked(receipts.issueReceipt).mock.calls).toHaveLength(issued);
    expect(h.fork.sha(before.branch)).toBe(before.candidate?.candidateSha);
    const after = held(h, id);
    expect(after.candidate?.candidateSha).not.toBe(before.candidate?.candidateSha);
    expect(after.artifacts.tracking).toMatchObject({ blockedReason: 'admission_policy' });
    expect(after.artifacts.revision_freshness as FreshnessReport).toMatchObject({
      fresh: false,
      reasons: expect.arrayContaining([reason]),
    });
  });
});

describe('gate 4 upstream: upstream drift', () => {
  it('actor=upstream maintainer outcome=base advances before push: rebase, fresh verification, shipped SHA equals verified SHA, old SHA never receipted owner=S3/S4', async () => {
    let h!: Rig;
    let advanced: string | undefined;
    h = fixture({
      beforeExec: async () => {
        if (!advanced && h.controller.snapshot().state === 'verifying')
          advanced = h.advanceUpstream('package.json', (text) =>
            text.replace('{', '{"description":"upstream change",')
          );
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('awaiting_contributor');
    const after = held(h, run.runId);
    const shipped = h.fork.sha(after.branch);
    expect(after.history).toContainEqual(
      expect.objectContaining({
        from: 'shipping',
        to: 'verifying',
        reasonCode: ReasonCode.BaseAdvanced,
      })
    );
    expect(after.candidate).toMatchObject({ candidateSha: shipped, baseSha: advanced });
    expect(loadVerification(after.dir, shipped as string, { runId: run.runId })).toMatchObject({
      verdict: 'passed',
      baseSha: advanced,
    });
    // The first verdict (old base) stays retained, but no receipt or push ever names it.
    const records = verificationRecords(after.dir).map((name) => name.slice(0, -5));
    expect(records).toHaveLength(2);
    const old = records.find((sha) => sha !== shipped) as string;
    expect(loadVerification(after.dir, old, { runId: run.runId }).verdict).toBe('passed');
    expect((await issuedReceipts()).map((signed) => signed.receipt.candidateSha)).toEqual([
      shipped,
    ]);
    expect(forkPushes(h).map((call) => (call[0].at(-1) as string).split(':')[0])).toEqual([
      shipped,
    ]);
  });

  it('actor=upstream maintainer outcome=base advances after push: limitation recorded, not re-verified owner=S3/S4', async () => {
    const h = fixture();
    let advanced: string | undefined;
    h.interceptRead((p) => {
      if (!advanced && forkPushes(h).length > 0 && p.includes('/branches/'))
        advanced = h.advanceUpstream('package.json', (text) =>
          text.replace('{', '{"description":"upstream change",')
        );
      return undefined;
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('awaiting_contributor');
    const after = held(h, run.runId);
    expect(advanced).toBeDefined();
    expect(after.artifacts.shipping_base).toEqual({
      verifiedBase: after.candidate?.baseSha,
      currentBase: advanced,
    });
    expect(after.candidate?.baseSha).not.toBe(advanced);
    expect(after.history.some((e) => e.reasonCode === ReasonCode.BaseAdvanced)).toBe(false);
    expect(verificationRecords(after.dir)).toHaveLength(1);
    expect(String(links(h)[0]?.body)).toContain(
      `upstream is now at \`${advanced}\`; the merge result was not verified`
    );
    expect(h.fork.sha(after.branch)).toBe(after.candidate?.candidateSha);
  });

  it('actor=upstream maintainer outcome=base advances on a touched file: rebase_conflict hand-off, nothing pushed owner=S3', async () => {
    let h!: Rig;
    let advanced = false;
    h = fixture({
      beforeExec: async () => {
        if (!advanced && h.controller.snapshot().state === 'verifying') {
          advanced = true;
          h.advanceUpstream('src/duration.js', (text) => `${text}\n// upstream edit\n`);
        }
      },
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('paused_user');
    const after = held(h, run.runId);
    expect(after.artifacts.drift_handoff).toEqual({
      reason: 'rebase_conflict',
      paths: ['src/duration.js'],
    });
    expect(after.notice).toMatchObject({
      state: 'paused_user',
      historyLength: after.history.length,
      reason: 'rebase_conflict',
    });
    expect(vi.mocked(receipts.issueReceipt)).not.toHaveBeenCalled();
    expect(forkPushes(h)).toHaveLength(0);
    // Resume re-checks the base and hands off again: no text merge, no push.
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe('paused_user');
    expect(forkPushes(h)).toHaveLength(0);
    expect(held(h, run.runId).notice?.historyLength).toBe(h.controller.snapshot().history.length);
  });
});

describe('gate 4 upstream: remote divergence', () => {
  it('actor=contributor outcome=out-of-band fork commit before push: remote_diverged, nothing overwritten owner=S4', async () => {
    let h!: Rig;
    let foreign: string | undefined;
    h = fixture({
      beforeRead: beforePush(
        () => h,
        () => {
          foreign = h.writeOutOfBand(h.controller.snapshot().runId);
        }
      ),
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('blocked');
    const after = held(h, run.runId);
    expect(h.fork.sha(after.branch)).toBe(foreign);
    expect(forkPushes(h)).toHaveLength(0);
    expect(rows(h, 'intents')).toContainEqual(
      expect.objectContaining({ type: 'blocked', reason: 'remote_diverged' })
    );
    expect(after.artifacts.shipping_block).toEqual({ reason: 'remote_diverged' });
    expect(after.notice).toMatchObject({
      state: 'blocked',
      historyLength: after.history.length,
      reason: 'remote_diverged',
    });
    expect(links(h)).toHaveLength(0);
    expect(((await h.authorize(h.controller.resume(run.runId))) as Run).state).toBe('blocked');
    expect(h.fork.sha(after.branch)).toBe(foreign);
    expect(forkPushes(h)).toHaveLength(0);
    // Negative control: the audit refuses the same remote once it is not declared foreign.
    h.foreign.delete(foreign as string);
    await expect(assertGlobalInvariants(h)).rejects.toThrow();
    h.foreign.add(foreign as string);
  });

  it.each([
    { when: 'before the revision', at: 'admission' },
    { when: 'after revision admission (CAS race)', at: 'mint' },
  ])('actor=contributor outcome=out-of-band fork commit $when blocks, nothing overwritten owner=S4/S5', async ({
    at,
  }) => {
    let h!: Rig;
    let revising = false;
    let foreign: string | undefined;
    h = fixture({
      beforeFetch: async (url) => {
        if (at === 'mint' && revising && !foreign && url.pathname.endsWith('/access_tokens'))
          foreign = h.writeOutOfBand(h.controller.snapshot().runId);
      },
    });
    const id = await published(h);
    const pushes = forkPushes(h).length;
    const before = held(h, id);
    h.feedback();
    revising = true;
    if (at === 'admission') foreign = h.writeOutOfBand(id);
    expect(((await h.authorize(h.controller.resume(id, { revise: true }))) as Run).state).toBe(
      'blocked'
    );
    expect(foreign).toBeDefined();
    expect(h.fork.sha(before.branch)).toBe(foreign);
    expect(held(h, id).artifacts.tracking).toMatchObject({ blockedReason: 'push_blocked' });
    if (at === 'admission') expect(forkPushes(h)).toHaveLength(pushes);
    else {
      // The lease names the last verified SHA, so Git itself refuses the overwrite.
      expect(forkPushes(h)).toHaveLength(pushes + 1);
      expect(forkPushes(h).at(-1)?.[0]).toContain(
        `--force-with-lease=refs/heads/${before.branch}:${before.candidate?.candidateSha}`
      );
      expect(rows(h, 'intents')).toContainEqual(
        expect.objectContaining({ type: 'blocked', reason: 'remote_diverged' })
      );
    }
  });

  it('actor=contributor outcome=expected revision history rewrite is a CAS push from the last verified SHA owner=S4/S5', async () => {
    const h = fixture();
    const id = await published(h);
    const before = held(h, id);
    const verified = before.candidate?.candidateSha as string;
    h.feedback();
    expect(((await h.authorize(h.controller.resume(id, { revise: true }))) as Run).state).toBe(
      'submitted'
    );
    const after = held(h, id);
    const revised = after.candidate?.candidateSha as string;
    expect(revised).not.toBe(verified);
    expect(h.fork.sha(before.branch)).toBe(revised);
    // A rewrite, not a fast-forward: the revision is rebuilt on the base, not on the old head.
    expect(h.fork.git(['rev-parse', `${revised}^`])).toBe(after.candidate?.baseSha);
    const pushes = forkPushes(h);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.[0]).toContain(`--force-with-lease=refs/heads/${before.branch}:${verified}`);
    expect(pushes[1]?.[0]).not.toContain('--force');
    const signed = await issuedReceipts();
    expect(signed.at(-1)?.receipt).toMatchObject({ candidateSha: revised });
    expect(signed.at(-1)?.receipt.permittedShippingOperations).toEqual([
      expect.objectContaining({ kind: 'push_branch', expectedRemoteSha: verified }),
    ]);
    expect(loadVerification(after.dir, revised, { runId: id }).verdict).toBe('passed');
  });
});

describe('gate 4 upstream: shipping integrity', () => {
  it.each([
    {
      damage: 'altered byte',
      corrupt: (bytes: Buffer) =>
        Buffer.from(bytes.toString().replace('"exitStatus":0', '"exitStatus":1')),
    },
    { damage: 'torn write', corrupt: (bytes: Buffer) => bytes.subarray(0, 40) },
  ])('actor=filesystem outcome=verification record $damage after the verdict refuses the receipt and needs fresh verification owner=S3/S4', async ({
    corrupt,
  }) => {
    let h!: Rig;
    h = fixture({
      beforeRead: beforePush(
        () => h,
        () => {
          const runs = path.join(h.config.executionProfile.stateDir, 'runs');
          for (const file of fs.readdirSync(runs, { recursive: true, encoding: 'utf8' }))
            if (/verification\/[a-f0-9]{40}\.json$/u.test(file)) {
              const target = path.join(runs, file);
              fs.writeFileSync(target, corrupt(fs.readFileSync(target)));
            }
        }
      ),
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    expect(run.state).toBe('blocked');
    expect(vi.mocked(receipts.issueReceipt)).not.toHaveBeenCalled();
    expect(consumed(h)).toEqual([]);
    expect(forkPushes(h)).toHaveLength(0);
    expect(held(h, run.runId).notice).toMatchObject({
      state: 'blocked',
      reason: 'verification_altered',
      nextPermittedAction: expect.stringContaining('Fresh verification requires a new run'),
    });
    // Replaying the altered verdict refuses; the run never ships from it.
    await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
      code: 'invalid_outcome',
    });
    expect(h.controller.snapshot().state).toBe('blocked');
    expect(forkPushes(h)).toHaveLength(0);
  });
});

const REPORTS = [
  { report: 'malformed', bytes: () => Buffer.from('<testsuites><testsuite name="s0"') },
  { report: 'missing', bytes: () => null },
  {
    report: 'oversize',
    bytes: () => Buffer.concat([junit(1), Buffer.alloc(MAX_REPORT_BYTES, 0x20)]),
  },
  { report: 'zero-suite', bytes: () => Buffer.from('<testsuites></testsuites>') },
] as const;

describe('gate 4 upstream: report parsing failures', () => {
  it.each(
    REPORTS.flatMap((r) => [
      { ...r, layer: 'regression evidence' },
      { ...r, layer: 'independent verifier' },
    ])
  )('actor=repository tests outcome=$report junit report in $layer is inconclusive and never ships owner=S3', async ({
    bytes,
    layer,
  }) => {
    const h = fixture();
    let first: string | undefined;
    const fullSuite = new Set<string>();
    // Exit status 0 claims success; only the supervisor-captured report is damaged. The
    // first verifying guest proves the regression on the base; the independent verifier's
    // guest runs the full suite and then the regression command.
    h.overrideExec((request, guest) => {
      if (!request.report || h.controller.snapshot().state !== 'verifying') return undefined;
      const vm = guest.handle.vmId;
      const regression = request.argv.includes('test/regression.test.js');
      first ??= vm;
      if (!regression) fullSuite.add(vm);
      const damaged =
        layer === 'regression evidence' ? vm === first : regression && fullSuite.has(vm);
      return damaged ? { exitCode: 0, report: bytes(), stdout: 'tests\n' } : undefined;
    });
    const run = (await h.authorize(h.controller.start(h.config))) as Run;
    const after = held(h, run.runId);
    const records = verificationRecords(after.dir);
    if (layer === 'regression evidence') {
      expect(run.state).toBe('paused_user');
      expect(after.artifacts.regression).toMatchObject({ proof: 'inconclusive' });
      expect(records).toEqual([]);
    } else {
      // Every independent verdict, original and both repairs, is inconclusive: no pass.
      expect(run.state).toBe('failed');
      expect(records).toHaveLength(3);
      for (const name of records)
        expect(loadVerification(after.dir, name.slice(0, -5), { runId: run.runId }).verdict).toBe(
          'inconclusive'
        );
    }
    expect(after.history.some((e) => e.reasonCode === ReasonCode.VerificationPassed)).toBe(false);
    expect(after.history.some((e) => e.to === 'shipping')).toBe(false);
    expect(vi.mocked(receipts.issueReceipt)).not.toHaveBeenCalled();
    expect(forkPushes(h)).toHaveLength(0);
  });
});
