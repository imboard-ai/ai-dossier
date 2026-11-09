import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { PolicyAssessment } from '../../policy/classify';
import type { RunRecord } from '../../state';
import { requestControl } from '../control';
import { changePolicy } from '../edits';
import { RunStore } from '../run-store';
import { stopNoticeAction } from '../stop-notice';
import { rig } from './composition-fixture';
import { compositionHooks, noShipping } from './composition-hooks';

compositionHooks();

it('retains paid typed policy evidence before ownership hand-off and replaces it on retry', async () => {
  const h = rig({ modelPrice: 1, ceilingMinor: 1000000 });
  const model = h.edges.models.planning;
  const complete = model.complete.bind(model);
  let malformed = true;
  model.complete = async (request) => {
    const result = await complete(request);
    if (
      malformed &&
      request.tools[0]?.function.name === 'report_decision' &&
      /"id":"policy-(assignment|direct-pr)"/u.test(request.system)
    )
      return { kind: 'malformed', reason: 'invalid_response', usage: result.usage };
    return result;
  };
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('gating');
  expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
  noShipping();
  const a = h.artifacts(run.runId);
  const evidence = a.get<{
    assessment: PolicyAssessment;
    outcome: string;
    reasons: string[];
    historyLength: number;
    sessionId: string;
  }>('gate_assessment');
  expect(evidence).toMatchObject({
    outcome: 'hand_off',
    reasons: ['ownership_unclear'],
    historyLength: run.history.length,
    sessionId: a.store.budgetSessionId(1),
    assessment: {
      decisions: {
        ai: { status: 'accepted', reason: 'accepted', model: 'fixture' },
        assignment: { status: 'escalated', reason: 'invalid_pass', citations: [] },
        directPr: { status: 'escalated', reason: 'invalid_pass', citations: [] },
      },
    },
  });
  expect(Object.keys(evidence.assessment.decisions ?? {})).toHaveLength(6);
  expect(evidence.assessment.decisions?.ai?.citations[0]).toMatchObject({
    sourceId: 'CONTRIBUTING.md',
    line: 1,
  });
  const ledger = JSON.parse(
    fs.readFileSync(path.join(a.store.storeDirectory('budget'), 'ledger.json'), 'utf8')
  );
  expect(
    ledger.reservations.filter((r: { purpose: string }) => r.purpose === 'work').length
  ).toBeGreaterThan(0);
  const action = stopNoticeAction(a.get('stop_notice'), a.store.run);
  expect(action).toContain('may already have run and been charged');
  expect(action).not.toContain('no model work');
  expect(a.get<{ gateAssessmentDigest: string }>('stop_notice').gateAssessmentDigest).toMatch(
    /^[a-f0-9]{64}$/u
  );
  a.close();

  // Reopen through the real controller: an early unreadable issue must clear the
  // selected assessment, while its immutable historical bytes remain available.
  h.interceptRead((request) =>
    request === '/repos/upstream/fixture/issues/7' ? { status: 503, body: null } : undefined
  );
  const retry = h.reopen();
  await h.authorize(retry.resume(run.runId), retry);
  const b = h.artifacts(run.runId);
  expect(b.get('gate_assessment')).toBeNull();
  expect(b.history('gate_assessment')).toContainEqual(evidence);
  b.close();

  malformed = false;
  h.interceptRead(() => undefined);
  const recovered = h.reopen();
  const resumed = (await h.authorize(recovered.resume(run.runId), recovered)) as RunRecord;
  expect(resumed.state).toBe('awaiting_contributor');
  const c = h.artifacts(run.runId);
  expect(c.get<{ outcome: string }>('gate_assessment').outcome).toBe('proceed');
  c.close();
}, 60000);

it('finalizes retained policy evidence for a post-assessment real-name hand-off', async () => {
  const h = rig({ realNameOnlyLogin: true });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('gating');
  const a = h.artifacts(run.runId);
  expect(a.get('gate_assessment')).toMatchObject({
    outcome: 'hand_off',
    reasons: ['real_name_required'],
  });
  expect(
    Object.keys(
      a.get<{ assessment: PolicyAssessment }>('gate_assessment').assessment.decisions ?? {}
    )
  ).toHaveLength(6);
  expect(a.get('stop_notice')).toMatchObject({ reason: 'real_name_required' });
  a.close();
  noShipping();
}, 60000);

async function answeredHandoff() {
  const h = rig({ modelPrice: 1, ceilingMinor: 1000000 });
  const model = h.edges.models.planning;
  const complete = model.complete.bind(model);
  // Ownership stays unreadable on every attempt: only the human answer can clear it.
  model.complete = async (request) => {
    const result = await complete(request);
    if (
      request.tools[0]?.function.name === 'report_decision' &&
      /"id":"policy-(assignment|direct-pr)"/u.test(request.system)
    )
      return { kind: 'malformed', reason: 'invalid_response', usage: result.usage };
    return result;
  };
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('gating');
  const runs = path.join(h.config.executionProfile.stateDir, 'runs');
  const answer = {
    decisions: { directPr: 'welcomed' as const },
    note: 'CONTRIBUTING.md:3 says fork and open a PR',
  };

  // Not paused yet: refused before anything is journaled.
  const early = RunStore.open(runs, run.runId);
  expect(() => changePolicy(early, early.run, answer)).toThrow('edit_not_paused');
  early.close();

  const observer = RunStore.open(runs, run.runId, { readOnly: true, observe: true });
  requestControl(observer, { kind: 'pause', reason: 'Record policy reading' }, new Date());
  observer.close();
  const paused = (await h.authorize(h.reopen().resume(run.runId))) as RunRecord;
  expect(paused.state).toBe('paused_user');

  const store = RunStore.open(runs, run.runId);
  expect(() => changePolicy(store, store.run, { decisions: answer.decisions, note: ' ' })).toThrow(
    'invalid_policy_decision'
  );
  // AI was settled by the gate: an answer must only touch what it left unclear.
  expect(() =>
    changePolicy(store, store.run, { decisions: { ai: 'welcomed' }, note: answer.note })
  ).toThrow('invalid_policy_decision');
  const policy = changePolicy(store, store.run, answer);
  expect(policy).toMatchObject({ operator: h.config.contributor, decisions: answer.decisions });
  expect(store.userChanges.at(-1)).toMatchObject({ kind: 'policy', value: policy });
  store.close();
  return { h, run, policy };
}

it('applies a journaled operator answer to an ownership hand-off and proceeds (#1268)', async () => {
  const { h, run, policy } = await answeredHandoff();
  const reopened = h.reopen();
  const resumed = (await h.authorize(reopened.resume(run.runId), reopened)) as RunRecord;
  expect(resumed.state).toBe('awaiting_contributor');
  const a = h.artifacts(run.runId);
  expect(a.get('gate_assessment')).toMatchObject({
    outcome: 'proceed',
    assessment: { directPr: 'welcomed', assignment: 'unclear' },
    operatorPolicy: { ...policy, applied: ['directPr'], stale: false },
  });
  expect(a.get<{ policy: PolicyAssessment }>('gate').policy.directPr).toBe('welcomed');
  a.close();
}, 60000);

it('retires an operator answer when the policy text changed before the gate re-ran (#1268)', async () => {
  const { h, run, policy } = await answeredHandoff();
  const text = 'Fork the repository and open a pull request against main.\n';
  const sha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
  h.interceptRead((request) =>
    request.startsWith('/repos/upstream/fixture/contents/CONTRIBUTING.md?')
      ? {
          status: 200,
          body: {
            path: 'CONTRIBUTING.md',
            type: 'file',
            sha,
            size: Buffer.byteLength(text),
            encoding: 'base64',
            content: Buffer.from(text).toString('base64'),
          },
        }
      : undefined
  );
  const reopened = h.reopen();
  const resumed = (await h.authorize(reopened.resume(run.runId), reopened)) as RunRecord;
  expect(resumed.state).toBe('gating');
  const a = h.artifacts(run.runId);
  const stale = a.get<{ reasons: string[]; operatorPolicy: unknown }>('gate_assessment');
  expect(stale).toMatchObject({
    outcome: 'hand_off',
    operatorPolicy: { ...policy, applied: [], stale: true },
  });
  expect(stale.reasons).toContain('ownership_unclear');
  expect(stale.reasons.at(-1)).toBe('operator_policy_stale');
  expect(a.get<{ reason: string }>('stop_notice').reason).toContain('operator_policy_stale');
  a.close();

  // Not a dead end: a fresh answer against the new text is accepted and proceeds.
  const runs = path.join(h.config.executionProfile.stateDir, 'runs');
  const observer = RunStore.open(runs, run.runId, { readOnly: true, observe: true });
  requestControl(observer, { kind: 'pause', reason: 'Record policy reading' }, new Date());
  observer.close();
  const again = h.reopen();
  expect(((await h.authorize(again.resume(run.runId), again)) as RunRecord).state).toBe(
    'paused_user'
  );
  const store = RunStore.open(runs, run.runId);
  const fresh = changePolicy(store, store.run, {
    decisions: { directPr: 'welcomed' },
    note: 'CONTRIBUTING.md:1 says fork and open a pull request',
  });
  expect(fresh.inputDigest).not.toBe(policy.inputDigest);
  store.close();
  const last = h.reopen();
  expect(((await h.authorize(last.resume(run.runId), last)) as RunRecord).state).toBe(
    'awaiting_contributor'
  );
  const b = h.artifacts(run.runId);
  expect(b.get('gate_assessment')).toMatchObject({
    outcome: 'proceed',
    operatorPolicy: { decisions: { directPr: 'welcomed' }, applied: ['directPr'], stale: false },
  });
  b.close();
}, 90000);
