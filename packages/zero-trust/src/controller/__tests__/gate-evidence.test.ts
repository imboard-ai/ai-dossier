import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { PolicyAssessment } from '../../policy/classify';
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
  const run = await h.authorize(h.controller.start(h.config));
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
  const resumed = await h.authorize(recovered.resume(run.runId), recovered);
  expect(resumed.state).toBe('awaiting_contributor');
  const c = h.artifacts(run.runId);
  expect(c.get<{ outcome: string }>('gate_assessment').outcome).toBe('proceed');
  c.close();
}, 60000);
