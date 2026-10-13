import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../__tests__/verifier-fixture';
import { UnsupportedEnvironmentError } from '../../vm/adapter';
import { stopNoticeAction } from '../stop-notice';
import { createController } from '../wiring';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, noShipping } from './composition-hooks';
import { createProxyCaFixture as certificate } from './proxy-ca-fixture';

compositionHooks();

describe('recoverable provisioning at the real composition boundary', () => {
  it('expired CA refuses allocation, retains a notice and resumes after CA replacement', async () => {
    const h = rig();
    const file = certificate(h.config.executionProfile.stateDir, '1');
    const ca = new X509Certificate(fs.readFileSync(file));
    h.advanceClock(Date.parse(ca.validTo) + 1000 - Date.parse(TIME));
    fs.writeFileSync(
      h.config.executionProfile.proxyEndpointsFile,
      JSON.stringify({
        endpoints: ENDPOINTS,
        target: { host: '10.0.0.2', port: 4873 },
        caCertificateFile: file,
      })
    );
    const controller = createController(h.config, h.edges);
    const run = (await h.authorize(controller.start(h.config), controller)) as {
      runId: string;
      state: string;
    };
    expect(run.state).toBe('paused_user');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toEqual([]);
    expect(h.executions).toEqual([]);
    const a = h.artifacts(run.runId);
    expect(a.get('diagnostic')).toMatchObject({ code: 'proxy_ca_expired', phase: 'acquire' });
    expect(stopNoticeAction(a.get('stop_notice'), a.store.run)).toContain('proxy_ca_expired');
    a.close();
    noShipping();
    certificate(h.config.executionProfile.stateDir, '365');
    const resumed = (await h.authorize(controller.resume(run.runId), controller)) as {
      state: string;
    };
    expect(resumed.state).toBe('awaiting_contributor');
    const b = h.artifacts(run.runId);
    expect(b.get('stop_notice')).toBeNull();
    b.close();
  }, 60000);

  it.each([
    ['404 no such package available; certificate has expired', false],
    ['Authorization: Bearer fixture-secret-value', true],
  ])(
    'mirror failure retains a bounded redacted diagnostic: %s',
    async (stderr, secret) => {
      const h = rig();
      h.overrideExec((request) =>
        request.network === 'package_proxy' ? { exitCode: 1, stderr } : undefined
      );
      const run = (await h.authorize(h.controller.start(h.config))) as {
        runId: string;
        state: string;
      };
      expect(run.state).toBe('paused_user');
      expect(h.vm.liveVms()).toEqual([]);
      expect(h.executions).toHaveLength(1);
      expect(h.executions[0].request.network).toBe('package_proxy');
      const a = h.artifacts(run.runId);
      const diagnostic = a.get<{ log: { excerpt: string; redacted: boolean } }>('diagnostic');
      expect(diagnostic).toMatchObject({ code: 'provisioning_failed', phase: 'acquire' });
      expect(diagnostic.log.redacted).toBe(secret);
      expect(diagnostic.log.excerpt).toContain(secret ? '[redacted]' : stderr);
      expect(stopNoticeAction(a.get('stop_notice'), a.store.run)).toContain('provisioning_failed');
      a.close();
      noShipping();
      h.overrideExec(undefined);
      expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
        'awaiting_contributor'
      );
    },
    60000
  );

  it('a genuine host environment refusal stays terminal', async () => {
    const h = rig();
    h.vm.create = async () => {
      throw new UnsupportedEnvironmentError('kvm_unavailable');
    };
    const run = (await h.authorize(h.controller.start(h.config))) as { state: string };
    expect(run.state).toBe('unsupported');
    noShipping();
  }, 60000);

  it.each([
    1, 2, 3, 4, 5, 6, 7,
  ])('provisioning workspace %s can resume after correction and controller reopen', async (failureAt) => {
    const h = rig();
    let provisions = 0;
    h.overrideExec((request) => {
      if (request.network === 'package_proxy' && ++provisions === failureAt)
        return { exitCode: 1, stderr: 'temporary mirror outage' };
      return undefined;
    });
    const run = (await h.authorize(h.controller.start(h.config))) as {
      runId: string;
      state: string;
    };
    expect(run.state).toBe('paused_user');
    expect(h.vm.liveVms()).toEqual([]);
    const a = h.artifacts(run.runId);
    expect(a.get('diagnostic')).toMatchObject({
      code: 'provisioning_failed',
      log: { excerpt: expect.stringContaining('temporary mirror outage') },
    });
    expect(
      a.store.run.history.some((entry) => entry.reasonCode === 'unsupported_environment')
    ).toBe(false);
    a.close();
    noShipping();
    h.overrideExec(undefined);
    const reopened = h.reopen();
    expect(
      ((await h.authorize(reopened.resume(run.runId), reopened)) as { state: string }).state
    ).toBe('awaiting_contributor');
  }, 60000);

  it('CA expiry at final verification allocation does not consume a verification attempt', async () => {
    const h = rig();
    const file = certificate(h.config.executionProfile.stateDir, '1');
    const expired = fs.readFileSync(file);
    const ca = new X509Certificate(expired);
    certificate(h.config.executionProfile.stateDir, '365');
    const valid = fs.readFileSync(file);
    h.advanceClock(Date.parse(ca.validTo) + 1000 - Date.parse(TIME));
    fs.writeFileSync(
      h.config.executionProfile.proxyEndpointsFile,
      JSON.stringify({
        endpoints: ENDPOINTS,
        target: { host: '10.0.0.2', port: 4873 },
        caCertificateFile: file,
      })
    );
    let provisions = 0;
    h.overrideExec((request) => {
      if (request.network === 'package_proxy' && ++provisions === 6)
        fs.writeFileSync(file, expired);
      return undefined;
    });
    const controller = h.reopen();
    const run = (await h.authorize(controller.start(h.config), controller)) as {
      runId: string;
      state: string;
    };
    expect(run.state).toBe('paused_user');
    expect(h.vm.calls.filter((call) => call.op === 'create')).toHaveLength(6);
    expect(h.vm.liveVms()).toEqual([]);
    const a = h.artifacts(run.runId);
    expect(a.get('diagnostic')).toMatchObject({ phase: 'verify', code: 'proxy_ca_expired' });
    expect(stopNoticeAction(a.get('stop_notice'), a.store.run)).toContain('proxy_ca_expired');
    a.close();
    noShipping();
    fs.writeFileSync(file, valid);
    h.overrideExec(undefined);
    const reopened = h.reopen();
    expect(
      ((await h.authorize(reopened.resume(run.runId), reopened)) as { state: string }).state
    ).toBe('awaiting_contributor');
  }, 60000);
});
