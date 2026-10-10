/** Existing #1112 composition cases preserved when the edge rig was extracted. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CANDIDATE } from '../../__tests__/verifier-fixture';
import { Journal } from '../../journal';
import { ReasonCode } from '../../state';
import { approveCheckpoint } from '../checkpoints';
import { requestControl } from '../control';
import { applyUserPatch, changeCheckpoints, changeModelProfile } from '../edits';
import { readOutcomeBudget } from '../outcome-records';
import { RunStore } from '../run-store';
import { StepArtifacts } from '../steps';
import { loadVerification } from '../verification-record';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, pushCalls, receiptCalls } from './composition-hooks';

compositionHooks();
describe('contributor edits real composition', () => {
  it('model switch preserves ledger bytes and uses the new adapter under the existing session', async () => {
    const h = rig({ checkpoint: 'plan' });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      runId: string;
      state: string;
    };
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    const file = path.join(a.store.storeDirectory('budget'), 'ledger.json');
    const before = fs.readFileSync(file);
    const profile = {
      ...h.config.modelProfile,
      phases: {
        ...h.config.modelProfile.phases,
        implementing: { ...h.config.modelProfile.phases.implementing, model: 'next' },
      },
      rates: [
        ...h.config.modelProfile.rates,
        { ...h.config.modelProfile.rates[0], resource: 'next' },
      ],
    };
    vi.stubEnv('ZT_MODEL_KEY', 'fixture-key');
    changeModelProfile(a.store, a.store.run, profile, new Date(TIME));
    changeCheckpoints(a.store, a.store.run, [], new Date(TIME));
    expect(fs.readFileSync(file)).toEqual(before);
    const changed = a.store.config;
    a.close();
    const adapter = h.switchModel(changed);
    const complete = vi.spyOn(adapter, 'complete');
    h.advanceClock();
    const resumed = (await h.authorize(h.controller.resume(run.runId))) as { state: string };
    expect(resumed.state).toBe('awaiting_contributor');
    expect(complete).toHaveBeenCalled();
    const b = h.artifacts(run.runId);
    expect(readOutcomeBudget(b.store).sessions).toHaveLength(1);
    expect(
      readOutcomeBudget(b.store).reservations.some((r) =>
        r.estimate.rates.some((rate) => rate.resource === 'next')
      )
    ).toBe(true);
    b.close();
  }, 60000);

  it.each([
    ['implementing', undefined],
    ['verifying', undefined],
    ['implementing', 'candidate'],
    ['implementing', 'user_edit_implementation'],
    ['implementing', 'applied_user_edit'],
  ] as const)(
    'user edit paused from %s ships the edited candidate only after fresh verification (crash=%s)',
    async (origin, crash) => {
      const h = rig(
        origin === 'implementing'
          ? { activeControl: 'exec', signoff: true }
          : { checkpoint: 'patch', signoff: true }
      );
      const running = h.authorize(h.controller.start(h.config));
      if (origin === 'implementing') {
        await h.controlReady;
        const store = RunStore.open(
          path.join(h.config.executionProfile.stateDir, 'runs'),
          h.controller.snapshot().runId,
          { readOnly: true, observe: true }
        );
        try {
          requestControl(store, { kind: 'pause', reason: 'User control' }, new Date(TIME));
        } finally {
          store.close();
        }
      }
      const run = (await running) as { runId: string; state: string };
      expect(run.state).toBe('paused_user');
      const content = Buffer.from(
        CANDIDATE.entries.find((e) => e.path === 'src/duration.js')?.bytes ?? '',
        'base64'
      ).toString('utf8');
      const lines = content.trimEnd().split('\n');
      const changed = ['// Contributor edit retained through fresh verification', ...lines];
      const diff = Buffer.from(
        `diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1,${lines.length} +1,${changed.length} @@\n${lines.map((l) => `-${l}\n`).join('')}${changed.map((l) => `+${l}\n`).join('')}`
      );
      const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), run.runId);
      const candidate = applyUserPatch(store, store.run, diff, new Date(TIME));
      expect(
        h.fork.git(['interpret-trailers', '--parse'], candidate.record.message).toString()
      ).toContain(`Signed-off-by: ${h.config.authorApproval?.name}`);
      store.close();
      h.advanceClock();
      if (crash) {
        const put = StepArtifacts.prototype.put;
        let fired = false;
        const fault = vi.spyOn(StepArtifacts.prototype, 'put').mockImplementation(function (
          this: StepArtifacts,
          key,
          value
        ) {
          put.call(this, key, value);
          if (key === crash && !fired) {
            fired = true;
            throw new Error('simulated contributor edit adoption crash');
          }
        });
        await expect(h.authorize(h.controller.resume(run.runId))).rejects.toThrow();
        expect(fired).toBe(true);
        fault.mockRestore();
      }
      let resumed = (await h.authorize(h.controller.resume(run.runId))) as { state: string };
      if (origin === 'verifying') {
        expect(resumed.state).toBe('paused_user');
        const b = h.artifacts(run.runId);
        const checkpoint = b.store.checkpoint('patch');
        expect(checkpoint?.bindings.candidateSha).toBe(candidate.record.candidateSha);
        expect(checkpoint?.bindings.reviewDigest).toMatch(/^[a-f0-9]{64}$/u);
        const reviewFile = path.join(b.dir, 'candidate.diff');
        const reviewBytes = fs.readFileSync(reviewFile);
        fs.writeFileSync(reviewFile, 'corrupted review');
        const approval = { point: 'patch' as const, digest: checkpoint?.digest as string };
        const at = new Date('2026-10-10T00:01:00.000Z');
        expect(() => approveCheckpoint(b.store, b.store.run, approval, at)).toThrow(
          'checkpoint_stale'
        );
        fs.unlinkSync(reviewFile);
        expect(() => approveCheckpoint(b.store, b.store.run, approval, at)).toThrow(
          'checkpoint_stale'
        );
        fs.writeFileSync(reviewFile, reviewBytes, { mode: 0o600 });
        approveCheckpoint(b.store, b.store.run, approval, at);
        b.close();
        resumed = (await h.authorize(h.controller.resume(run.runId))) as { state: string };
      }
      expect(resumed.state).toBe('awaiting_contributor');
      const b = h.artifacts(run.runId);
      expect(b.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha).toBe(
        candidate.record.candidateSha
      );
      expect(
        loadVerification(b.dir, candidate.record.candidateSha, { runId: run.runId }).verdict
      ).toBe('passed');
      expect(b.store.run.history.map((e) => e.reasonCode)).toContain(
        origin === 'implementing' ? ReasonCode.ResumeImplementing : ReasonCode.ResumeVerifying
      );
      if (origin === 'implementing')
        expect(b.store.run.history.slice(-5).map((e) => e.reasonCode)).toContain(
          ReasonCode.CandidateReady
        );
      const hand = new Journal(b.store.storeDirectory('handoff'));
      expect(JSON.stringify(hand.read())).toContain('Includes contributor edits');
      hand.close();
      b.close();
      expect(receiptCalls().length).toBeGreaterThan(0);
      expect(pushCalls().length).toBeGreaterThan(0);
    },
    60000
  );

  it('model profile change preserves an existing verified candidate and checkpoint authority after reopen', async () => {
    const h = rig({ checkpoint: 'verification' });
    const run = (await h.authorize(h.controller.start(h.config))) as { runId: string };
    const a = h.artifacts(run.runId);
    const candidate = a.get<{ record: { candidateSha: string } }>('candidate');
    const record = loadVerification(a.dir, candidate.record.candidateSha, { runId: run.runId });
    const file = path.join(a.dir, 'verification', `${record.candidateSha}.json`);
    const before = fs.readFileSync(file);
    const ledger = fs.readFileSync(path.join(a.store.storeDirectory('budget'), 'ledger.json'));
    vi.stubEnv('ZT_MODEL_KEY', 'fixture-key');
    changeModelProfile(
      a.store,
      a.store.run,
      {
        ...h.config.modelProfile,
        phases: {
          ...h.config.modelProfile.phases,
          implementing: {
            ...h.config.modelProfile.phases.implementing,
            endpoint: 'https://model.example/v2',
          },
        },
      },
      new Date(TIME)
    );
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readFileSync(path.join(a.store.storeDirectory('budget'), 'ledger.json'))).toEqual(
      ledger
    );
    const checkpoint = a.store.checkpoint('verification');
    a.close();
    const b = h.artifacts(run.runId);
    expect(
      loadVerification(b.dir, record.candidateSha, {
        runId: run.runId,
        expectedDigest: record.recordDigest,
      })
    ).toEqual(record);
    expect(b.store.checkpoint('verification')).toEqual(checkpoint);
    expect(b.store.run.state).toBe('paused_user');
    b.close();
  }, 60000);
});
