import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../__tests__/verifier-fixture';
import { UnsupportedEnvironmentError } from '../../vm/adapter';
import { stopNoticeAction } from '../stop-notice';
import { createController } from '../wiring';
import { rig, TIME } from './composition-fixture';
import { compositionHooks, noShipping } from './composition-hooks';

compositionHooks();

function certificate(root: string, days: string) {
  const file = path.join(root, 'proxy-ca.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      days,
      '-subj',
      '/CN=fixture-proxy',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      path.join(root, 'proxy-ca.key'),
      '-out',
      file,
    ],
    { stdio: 'ignore' }
  );
  return file;
}

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
});
