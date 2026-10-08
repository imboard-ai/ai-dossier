import { describe, expect, it } from 'vitest';
import { FakeVmAdapter } from '../__tests__/fake-vm';
import { DEFAULT_LIMITS } from './adapter';
import {
  acquireWorkspaceLease,
  invalidateProvisionedVm,
  isProvisionedVm,
  registerProvisionedVm,
} from './workspace-lifecycle';

describe('provisioned workspace lifecycle proof', () => {
  it('binds exact adapter/handle identity, excludes owners and invalidates before direct destruction', async () => {
    const adapter = new FakeVmAdapter();
    const vm = await adapter.create({
      runId: 'run-proof',
      limits: DEFAULT_LIMITS,
      scope: 'container',
    });
    expect(isProvisionedVm(adapter, vm)).toBe(false);
    registerProvisionedVm(adapter, vm);
    expect(isProvisionedVm(adapter, vm)).toBe(true);
    expect(isProvisionedVm(new FakeVmAdapter(), vm)).toBe(false);
    expect(isProvisionedVm(adapter, { ...vm })).toBe(false);
    const release = acquireWorkspaceLease(adapter, vm);
    expect(() => acquireWorkspaceLease(adapter, vm)).toThrow('workspace_unproven');
    release();
    acquireWorkspaceLease(adapter, vm)();
    adapter.failDestroy = 1;
    await expect(adapter.destroy(vm)).rejects.toThrow();
    expect(isProvisionedVm(adapter, vm)).toBe(false);
    expect(() => acquireWorkspaceLease(adapter, vm)).toThrow('workspace_unproven');
    invalidateProvisionedVm(adapter, vm);
    await adapter.destroy(vm);
  });
  it('replacement of a VM identity revokes the original handle', async () => {
    const adapter = new FakeVmAdapter();
    const vm = await adapter.create({
      runId: 'run-proof',
      limits: DEFAULT_LIMITS,
      scope: 'container',
    });
    registerProvisionedVm(adapter, vm);
    const replacement = { ...vm };
    registerProvisionedVm(adapter, replacement);
    expect(isProvisionedVm(adapter, vm)).toBe(false);
    expect(isProvisionedVm(adapter, replacement)).toBe(true);
    invalidateProvisionedVm(adapter, { vmId: vm.vmId });
    expect(isProvisionedVm(adapter, replacement)).toBe(false);
  });
});
