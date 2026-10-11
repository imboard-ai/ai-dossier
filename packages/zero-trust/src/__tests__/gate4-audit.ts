/** Shared release-gate-4 audit for the lifecycle (#1113) and upstream (#1114) suites.
 * Every fixture a suite creates is audited after its scenario, refusal paths included. */

import fs from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { TrustedGit } from '../canonical/trusted-git';
import { rig, TIME } from '../controller/__tests__/composition-fixture';
import { compositionHooks } from '../controller/__tests__/composition-hooks';
import { requestControl } from '../controller/control';
import { RunStore } from '../controller/run-store';
import { loadVerification, VerificationRecordError } from '../controller/verification-record';
import { parseJunitReport } from '../ecosystem/report';
import { type IntentInput, idempotencyKey } from '../intents';
import { Journal } from '../journal';
import type * as receipts from '../receipt/issue';

export type Rig = ReturnType<typeof rig>;

/** Registers the shared audit and returns the suite's fixture constructor. */
export function gate4Suite() {
  const audits: Rig[] = [];
  // Register the audit before fixture cleanup closes/removes the pinned journals.
  compositionHooks(async () => {
    for (const h of audits.splice(0)) await assertGlobalInvariants(h);
  });
  return (options: Parameters<typeof rig>[0] = {}) => {
    const h = rig(options);
    audits.push(h);
    return h;
  };
}

export function rows(h: Rig, name: Parameters<RunStore['storeDirectory']>[0], child?: string) {
  const a = h.artifacts(h.controller.snapshot().runId);
  if (name === 'control' && child === 'steps') {
    try {
      return a.events() as Record<string, unknown>[];
    } finally {
      a.close();
    }
  }
  const journal = new Journal(path.join(a.store.storeDirectory(name), ...(child ? [child] : [])));
  try {
    return journal.read() as Record<string, unknown>[];
  } finally {
    journal.close();
    a.close();
  }
}

/** Physical `git push` calls the trusted transport made to the fixture fork. */
export function forkPushes(h: Rig) {
  return vi
    .mocked(TrustedGit.prototype.execAsync)
    .mock.calls.filter((c) => c[0][0] === 'push' && c[0].includes(`file://${h.fork.dir}`));
}

/** One audit for every scenario, including refusal paths. Load real supervisor evidence,
 * compare durable write identities and verify each outstanding guest is reported. */
export async function assertGlobalInvariants(h: Rig) {
  // Check physical writes first so mutation controls fail before expensive
  // supervisor evidence revalidation; all checks still run on the positive path.
  assertPushInvariants(h);
  const id = h.controller.snapshot().runId;
  const pushed = rows(h, 'push-ledger')
    .filter((row) => row.type === 'push_verified')
    .map((row) => row.remoteSha);
  const a = h.artifacts(id);
  try {
    const branch = `ztfc/${a.store.contributionId}`;
    const forkRefs = h.fork
      .git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
      .split('\n')
      .filter(Boolean);
    expect(forkRefs.every((ref) => ref === `refs/heads/${branch}`)).toBe(true);
    const remote = h.fork.sha(branch);
    // A commit the scenario wrote out of band must survive untouched; anything else on
    // the fork branch is a write of ours and needs a receipt and a supervised pass.
    if (remote && !h.foreign.has(remote)) {
      expect(pushed).toContain(remote);
      expect(
        a
          .history<receipts.SignedReceipt>('receipt')
          .some(
            (signed) =>
              signed.receipt.schemaVersion === 'ztfc-receipt-v2' &&
              signed.receipt.candidateSha === remote
          )
      ).toBe(true);
      expect(loadVerification(a.dir, remote, { runId: id })).toMatchObject({
        verdict: 'passed',
        boundaryHeld: true,
        regression: 'reproduced_and_fixed',
      });
    }
    const verificationDir = path.join(a.dir, 'verification');
    if (fs.existsSync(verificationDir)) {
      for (const name of fs
        .readdirSync(verificationDir)
        .filter((n) => /^[a-f0-9]{40}\.json$/u.test(n))) {
        let record: ReturnType<typeof loadVerification>;
        try {
          record = loadVerification(a.dir, name.slice(0, -5), { runId: id });
        } catch (error) {
          // An altered record claims nothing; the remote check above loads its own SHA.
          if (error instanceof VerificationRecordError && error.code === 'invalid_record') continue;
          throw error;
        }
        if (record.verdict === 'passed') {
          expect(record.boundaryHeld).toBe(true);
          expect(record.commands.every((command) => command.status === 'passed')).toBe(true);
          for (const command of record.commands) {
            const observed = h.executions.find((execution) => {
              const report = parseJunitReport(execution.result.report);
              const guest = h.vm.vms.get(execution.vmId);
              return (
                execution.request.argv.join(' ') === command.command &&
                execution.request.network === 'none' &&
                execution.result.exitCode === command.exitStatus &&
                !execution.result.timedOut &&
                !execution.result.truncated &&
                report?.suites === command.suites &&
                guest?.files.get('src/duration.js')?.bytes.toString().includes('millis / 1000')
              );
            });
            expect(observed, `supervised command ${command.id}`).toBeDefined();
          }
        }
      }
    }
    for (const key of ['publication', 'tracking']) {
      const observed = a.get<{ ci: string }>(key);
      // This edge has no GitHub checks: it cannot supply a supervised CI pass.
      if (observed) expect(observed.ci).not.toBe('passed');
    }
    for (const guest of h.vm.vms.values())
      if (guest.destroyed)
        expect(h.vm.calls).toContainEqual(
          expect.objectContaining({ op: 'destroy', vmId: guest.handle.vmId })
        );
    const guests = await h.vm.listByRun(id);
    if (guests.length) {
      expect(a.store.run.state).toBe('blocked_cleanup');
      const j = new Journal(path.join(a.store.storeDirectory('control'), 'controller'));
      const cleanup = j.read();
      j.close();
      for (const guest of guests)
        expect(cleanup).toContainEqual(
          expect.objectContaining({ type: 'cleanup', vmId: guest.vmId, kind: 'blocked_cleanup' })
        );
    }
    expect([...h.fake.tokens.values()].filter((token) => token.live)).toEqual([]);
    expect([...h.fake.tokens.values()].filter((token) => token.refreshAlive)).toEqual([]);
    expect([...h.fake.refreshTokens.values()].filter((token) => token.live)).toEqual([]);
    expect(
      h.fake.calls.filter(
        (call) => call.method !== 'GET' && /\/(pulls|issues)(\/|$)/u.test(call.path)
      )
    ).toEqual([]);
  } finally {
    a.close();
  }
}

function assertPushInvariants(h: Rig) {
  const id = h.controller.snapshot().runId;
  const links = rows(h, 'handoff').filter((row) => row.type === 'link_issued');
  const linkKeys = links.map((row) => idempotencyKey(row.input as IntentInput));
  expect(new Set(linkKeys).size).toBe(links.length);
  expect(new Set(links.map((row) => row.bodyFile)).size).toBe(links.length);
  const pushRows = rows(h, 'push-ledger');
  const writes = pushRows.filter((row) => row.type === 'push_verified');
  for (const row of writes) expect(typeof row.key).toBe('string');
  expect(new Set(writes.map((row) => row.key)).size).toBe(writes.length);
  const attempts = pushRows.filter((row) => row.type === 'push_intended');
  if (attempts.length) {
    const authorizations = rows(h, 'nonces');
    const artifacts = h.artifacts(id);
    const signed = artifacts.history<receipts.SignedReceipt>('receipt');
    artifacts.close();
    for (const attempt of attempts) {
      const authorization = authorizations.find(
        (row) => row.operationKey === attempt.key && row.attempt === attempt.attempt
      );
      expect(authorization).toBeDefined();
      const receipt = signed.find((row) => row.digest === authorization?.receiptDigest);
      expect(receipt?.receipt).toMatchObject({
        schemaVersion: 'ztfc-receipt-v2',
        candidateSha: attempt.candidateSha,
      });
      expect(receipt?.receipt.permittedShippingOperations).toContainEqual(
        expect.objectContaining({ kind: 'push_branch', operationKey: attempt.key })
      );
    }
  }
  const unmatched = [...attempts];
  for (const call of forkPushes(h)) {
    const refspec = call[0].at(-1) as string;
    const index = unmatched.findIndex(
      (attempt) =>
        attempt.candidateSha === refspec.split(':')[0] &&
        attempt.branch === refspec.split('refs/heads/')[1]
    );
    expect(index, 'one physical push per authorized attempt').toBeGreaterThanOrEqual(0);
    unmatched.splice(index, 1);
  }
}

export function control(h: Rig, kind: 'pause' | 'cancel') {
  const store = RunStore.open(
    path.join(h.config.executionProfile.stateDir, 'runs'),
    h.controller.snapshot().runId,
    { readOnly: true, observe: true }
  );
  try {
    return requestControl(
      store,
      { kind, reason: 'Contributor lifecycle instruction' },
      new Date(TIME)
    );
  } finally {
    store.close();
  }
}

export function barrier() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async wait() {
      reach();
      await released;
    },
  };
}
