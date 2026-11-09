/** A mixed npm + Python root selects one ecosystem per run (#1276), at the real composition. */
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ENDPOINTS } from '../../__tests__/verifier-fixture';
import { loadProfileRecord } from '../../ecosystem/profiles';
import type { RunRecord } from '../../state';
import { approveCheckpoint } from '../checkpoints';
import { changeEcosystem } from '../edits';
import { RunStore } from '../run-store';
import { stopNoticeAction } from '../stop-notice';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, noShipping } from './composition-hooks';

compositionHooks();

const LIMITATION_NPM =
  'Mixed npm + Python repository: only the npm side was installed and tested locally; upstream CI covers the rest.';

function runsOf(h: ReturnType<typeof rig>) {
  return path.join(h.config.executionProfile.stateDir, 'runs');
}

it('hands off as ecosystem_ambiguous, then resume --ecosystem records the answer and proceeds', async () => {
  const h = rig({ mixedRoot: true, proxyEcosystem: 'node' });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('paused_user');
  expect(run.history.at(-1)).toMatchObject({ from: 'planning', reasonCode: 'user_paused' });
  // No VM, no model work beyond the gate, and never refused as unsupported.
  expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
  noShipping();
  const a = h.artifacts(run.runId);
  const handoff = a.get<{ reason: string; sourceDigest: string; ecosystems: string[] }>(
    'ecosystem_handoff'
  );
  expect(handoff).toMatchObject({ reason: 'ecosystem_ambiguous', ecosystems: ['node', 'python'] });
  expect(a.get('ecosystem_selection')).toBeUndefined();
  expect(stopNoticeAction(a.get('stop_notice'), a.store.run)).toContain(
    'resume --ecosystem python|node'
  );
  a.close();

  const store = RunStore.open(runsOf(h), run.runId);
  expect(() => changeEcosystem(store, store.run, { ecosystem: 'ruby' })).toThrow(
    'invalid_ecosystem'
  );
  const choice = changeEcosystem(store, store.run, { ecosystem: 'node' });
  expect(choice).toEqual({
    ecosystem: 'node',
    operator: h.config.contributor,
    sourceDigest: handoff.sourceDigest,
  });
  expect(store.userChanges.at(-1)).toMatchObject({ kind: 'ecosystem', value: choice });
  store.close();

  const reopened = h.reopen();
  const resumed = (await h.authorize(reopened.resume(run.runId), reopened)) as RunRecord;
  expect(resumed.state).toBe('awaiting_contributor');
  const b = h.artifacts(run.runId);
  expect(b.get('ecosystem_selection')).toEqual({
    ecosystem: 'node',
    basis: 'operator',
    sourceDigest: handoff.sourceDigest,
  });
  expect(b.get('ecosystem_handoff')).toBeNull();
  expect(loadProfileRecord(b.store.storeDirectory('profile'), run.runId).manager).toBe('npm');
  b.close();
  // The PR discloses the side that was not installed or tested.
  expect(h.linkBody(run.runId, 'pr_create')).toContain(LIMITATION_NPM);
}, 90000);

it('selects Python from Python-only issue paths and provisions with uv', async () => {
  const h = rig({
    mixedRoot: true,
    proxyEcosystem: 'python',
    checkpoint: 'plan',
    issueBody: 'The bug is in `app/duration.py:3`; see tests/test_duration.py.',
  });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('paused_user');
  const a = h.artifacts(run.runId);
  expect(a.get('ecosystem_selection')).toMatchObject({ ecosystem: 'python', basis: 'issue_paths' });
  expect(loadProfileRecord(a.store.storeDirectory('profile'), run.runId).manager).toBe('uv');
  a.close();
  const provisioning = h.executions.filter((e) => e.request.network === 'package_proxy');
  expect(provisioning.length).toBeGreaterThan(0);
  expect(
    provisioning.every(
      (e) => e.request.argv.join(' ').includes('uv') || e.request.argv.join(' ').includes('pip')
    )
  ).toBe(true);
  expect(h.executions.some((e) => e.request.argv.includes('npm'))).toBe(false);
}, 90000);

it('refuses a proxy that does not serve the selected ecosystem before any VM', async () => {
  const h = rig({
    mixedRoot: true,
    proxyEcosystem: 'node',
    checkpoint: 'plan',
    issueBody: 'Fix app/duration.py.',
  });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('paused_user');
  expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
  const a = h.artifacts(run.runId);
  expect(a.get('diagnostic')).toMatchObject({ code: 'proxy_ecosystem_mismatch', phase: 'acquire' });
  expect(stopNoticeAction(a.get('stop_notice'), a.store.run)).toContain(
    '"targetEcosystem": "python"'
  );
  a.close();
  // An undeclared mirror is refused the same way for a narrowed mixed root.
  fs.writeFileSync(
    h.config.executionProfile.proxyEndpointsFile,
    JSON.stringify({ endpoints: ENDPOINTS, target: { host: '10.0.0.2', port: 5000 } })
  );
  const undeclared = h.reopen();
  expect(((await h.authorize(undeclared.resume(run.runId), undeclared)) as RunRecord).state).toBe(
    'paused_user'
  );
  expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
  // Corrected: the run continues to its plan checkpoint.
  fs.writeFileSync(
    h.config.executionProfile.proxyEndpointsFile,
    JSON.stringify({
      endpoints: ENDPOINTS,
      target: { host: '10.0.0.2', port: 5000 },
      targetEcosystem: 'python',
    })
  );
  const fixed = h.reopen();
  expect(((await h.authorize(fixed.resume(run.runId), fixed)) as RunRecord).state).toBe(
    'paused_user'
  );
  const b = h.artifacts(run.runId);
  expect(b.get('diagnostic')).toMatchObject({ code: 'proxy_ecosystem_mismatch' });
  expect(stopNoticeAction(b.get('stop_notice'), b.store.run) ?? '').not.toContain(
    'proxy_ecosystem_mismatch'
  );
  b.close();
  expect(h.vm.calls.filter((call) => call.op === 'create').length).toBeGreaterThan(0);
}, 90000);

it('single-ecosystem repositories are unaffected: no selection, no limitation line', async () => {
  const h = rig({ issueBody: 'See api/handler.py and web/app.ts.' });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('awaiting_contributor');
  const a = h.artifacts(run.runId);
  expect(a.get('ecosystem_selection')).toBeUndefined();
  expect(a.get('ecosystem_handoff') ?? null).toBeNull();
  a.close();
  expect(h.linkBody(run.runId, 'pr_create')).not.toContain('Mixed npm + Python');
}, 90000);

it('a declared mirror for the other ecosystem refuses a single-ecosystem run too', async () => {
  const h = rig({ proxyEcosystem: 'python' });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('paused_user');
  expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
  const a = h.artifacts(run.runId);
  expect(a.get('diagnostic')).toMatchObject({ code: 'proxy_ecosystem_mismatch' });
  a.close();
}, 90000);

it('refuses --ecosystem outside an ecosystem hand-off', async () => {
  const h = rig({ proxyEcosystem: 'node', mixedRoot: true, issueBody: 'Fix a.py' });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  // Paused from planning by the proxy refusal, not by ambiguity: nothing to answer.
  expect(run.state).toBe('paused_user');
  const store = RunStore.open(runsOf(h), run.runId);
  expect(() => changeEcosystem(store, store.run, { ecosystem: 'node' })).toThrow(
    'ecosystem_not_at_handoff'
  );
  expect(store.userChanges).toEqual([]);
  store.close();
}, 90000);

it('a recorded profile pins the ecosystem: re-acquisition never hands off or re-selects', async () => {
  // Paused at the plan checkpoint with the npm profile recorded. Retiring the selection
  // stands in for a run that recorded its profile on a single-ecosystem root and was then
  // rebased onto a mixed one: re-acquisition must narrow to the profile, not ask again.
  const h = rig({
    mixedRoot: true,
    proxyEcosystem: 'node',
    checkpoint: 'plan',
    issueBody: 'Fix web/app.ts',
  });
  const run = (await h.authorize(h.controller.start(h.config))) as RunRecord;
  expect(run.state).toBe('paused_user');
  const a = h.artifacts(run.runId);
  expect(a.get('ecosystem_selection')).toMatchObject({ ecosystem: 'node', basis: 'issue_paths' });
  a.put('ecosystem_selection', null);
  const checkpoint = a.store.checkpoint('plan');
  approveCheckpoint(
    a.store,
    a.store.run,
    { point: 'plan', digest: checkpoint?.digest as string },
    new Date(Date.parse(TIME) + 60000)
  );
  h.advanceClock(120000);
  a.close();
  // Undeclared proxy: a pinned run is not a newly narrowed one, so it is not refused.
  fs.writeFileSync(
    h.config.executionProfile.proxyEndpointsFile,
    JSON.stringify({ endpoints: ENDPOINTS, target: { host: '10.0.0.2', port: 4873 } })
  );
  const reopened = h.reopen();
  const resumed = (await h.authorize(reopened.resume(run.runId), reopened)) as RunRecord;
  expect(resumed.state).toBe('awaiting_contributor');
  const b = h.artifacts(run.runId);
  expect(b.get('ecosystem_handoff') ?? null).toBeNull();
  expect(b.get('ecosystem_selection')).toBeNull();
  b.close();
  expect(h.linkBody(run.runId, 'pr_create')).not.toContain('Mixed npm + Python');
}, 90000);
