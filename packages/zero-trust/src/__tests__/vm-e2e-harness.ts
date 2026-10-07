/** Shared real-VM gate limits and timings; production owns boundary measurements. */
import type { VmLimits } from '../vm/adapter';
import { BAKED_DISK_GIB } from '../vm/profile';

export {
  HOST_ENFORCED,
  hex,
  type Listener,
  lanAddress,
  listen,
  type PlantedCanaries,
  plantCanaries,
  rejectedByBroker,
  rootProbeArgv,
} from '../vm/boundary-probe';

export const E2E_LIMITS: VmLimits = {
  vcpus: 2,
  memoryMiB: 4096,
  diskGiB: BAKED_DISK_GIB,
  commandTimeoutMs: 10 * 60_000,
};

export function timer(timings: Record<string, number>) {
  return async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      timings[label] = Date.now() - started;
    }
  };
}
