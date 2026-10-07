import { describe, expect, it } from 'vitest';
import { BrokerError, DEFAULT_LIMITS, UnsupportedEnvironmentError } from '../vm/adapter';
import { FakeVmAdapter, junit } from './fake-vm';

const spec = { runId: 'r1', limits: DEFAULT_LIMITS, scope: 'container' as const };

describe('FakeVmAdapter', () => {
  it('enforces the phase rules of the real adapter', async () => {
    const adapter = new FakeVmAdapter();
    await expect(adapter.create({ ...spec, phase: 'provisioning' })).rejects.toMatchObject({
      code: 'proxy_required',
    });
    const vm = await adapter.create({
      ...spec,
      phase: 'provisioning',
      proxyTarget: { host: '10.0.0.2', port: 1 },
    });
    expect(
      (await adapter.exec(vm, { profile: 'node', argv: ['x'], network: 'package_proxy' })).exitCode
    ).toBe(0);
    await adapter.endProvisioning(vm);
    await expect(adapter.endProvisioning(vm)).rejects.toMatchObject({ code: 'not_provisioning' });
    await expect(
      adapter.exec(vm, { profile: 'node', argv: ['x'], network: 'package_proxy' })
    ).rejects.toMatchObject({ code: 'network_not_allowed' });
    await adapter.destroy(vm);
    await expect(adapter.exec(vm, { profile: 'node', argv: ['x'] })).rejects.toBeInstanceOf(
      BrokerError
    );
  });

  it('stores files, scripts results per argv, and lists live VMs by run', async () => {
    const adapter = new FakeVmAdapter().on(['a', 'b'], {
      exitCode: 3,
      stdout: 'o',
      report: '<testsuites/>',
    });
    const vm = await adapter.create(spec);
    await adapter.putFile(vm, 'x/y', Buffer.from('bytes'), true);
    expect((await adapter.getFile(vm, 'x/y')).toString()).toBe('bytes');
    await expect(adapter.getFile(vm, 'missing')).rejects.toMatchObject({ code: 'guest_not_found' });
    const result = await adapter.exec(vm, { profile: 'node', argv: ['a', 'b'], report: true });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'o' });
    expect(result.report?.toString()).toBe('<testsuites/>');
    expect('report' in (await adapter.exec(vm, { profile: 'node', argv: ['a', 'b'] }))).toBe(false);
    expect(await adapter.listByRun('r1')).toEqual([
      { vmId: vm.vmId, runId: 'r1', pid: null, alive: true, paths: [] },
    ]);
    adapter.failDestroy = 1;
    await expect(adapter.destroy(vm)).rejects.toThrow(/teardown incomplete/);
    await adapter.destroy(vm);
    await adapter.destroy({ vmId: 'never', runId: 'r1' });
    expect(adapter.liveVms()).toEqual([]);
    expect(await adapter.listByRun('r1')).toEqual([]);
  });

  it('fails create once when asked to, and builds junit reports', async () => {
    const adapter = new FakeVmAdapter();
    adapter.failCreate = new UnsupportedEnvironmentError('kvm_unavailable', 'no kvm');
    await expect(adapter.create(spec)).rejects.toBeInstanceOf(UnsupportedEnvironmentError);
    expect((await adapter.create(spec)).vmId).toMatch(/^fake-/);
    expect(junit(2, true).toString()).toContain('<failure/>');
  });
});
