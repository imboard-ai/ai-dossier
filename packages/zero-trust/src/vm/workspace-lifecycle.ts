import { BrokerError, type VmAdapter, type VmHandle } from './adapter';

const PROVEN = new WeakMap<VmHandle, VmAdapter>();
const HANDLES = new WeakMap<object, Map<string, VmHandle>>();
const LEASED = new WeakSet<VmHandle>();

/** Internal lifecycle bookkeeping shared by provisioning and VM destruction. */
export function registerProvisionedVm(adapter: VmAdapter, vm: VmHandle): void {
  let handles = HANDLES.get(adapter);
  if (!handles) {
    handles = new Map();
    HANDLES.set(adapter, handles);
  }
  const old = handles.get(vm.vmId);
  if (old) PROVEN.delete(old);
  handles.set(vm.vmId, vm);
  PROVEN.set(vm, adapter);
}

export function isProvisionedVm(adapter: VmAdapter, vm: VmHandle): boolean {
  return PROVEN.get(vm) === adapter;
}

/** Call before every supported destruction path begins, including failed teardown. */
export function invalidateProvisionedVm(
  adapter: Pick<VmAdapter, 'destroy'>,
  vm: Pick<VmHandle, 'vmId'>
): void {
  const handles = HANDLES.get(adapter);
  const handle = handles?.get(vm.vmId);
  if (handle) {
    PROVEN.delete(handle);
    handles?.delete(vm.vmId);
  }
}

export function acquireWorkspaceLease(adapter: VmAdapter, vm: VmHandle): () => void {
  if (!isProvisionedVm(adapter, vm) || LEASED.has(vm)) throw new BrokerError('workspace_unproven');
  LEASED.add(vm);
  return () => LEASED.delete(vm);
}
