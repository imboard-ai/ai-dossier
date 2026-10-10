/** Vitest recording and cleanup are separate so the edge rig also runs in a real process. */
import os from 'node:os';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { TrustedGit } from '../../canonical/trusted-git';
import * as receipts from '../../receipt/issue';
import { cleanupComposition, fixtureInstrumentation } from './composition-fixture';

let issued: ReturnType<typeof vi.spyOn>;
let syncGit: ReturnType<typeof vi.spyOn>;
let asyncGit: ReturnType<typeof vi.spyOn>;
export function pushCalls() {
  return [...syncGit.mock.calls, ...asyncGit.mock.calls].filter((call) => call[0][0] === 'push');
}
export function noShipping() {
  expect(issued.mock.calls).toHaveLength(0);
  expect(pushCalls()).toHaveLength(0);
}
export function compositionHooks(audit?: () => Promise<void>) {
  beforeEach(() => {
    fixtureInstrumentation(
      (vm) => {
        const exec = vm.exec.bind(vm);
        const putFile = vm.putFile.bind(vm);
        const destroy = vm.destroy.bind(vm);
        vi.spyOn(vm, 'exec').mockImplementation(exec);
        vi.spyOn(vm, 'putFile').mockImplementation(putFile);
        vi.spyOn(vm, 'destroy').mockImplementation(destroy);
      },
      (key, value) => {
        vi.stubEnv(key, value);
      }
    );
    issued = vi.spyOn(receipts, 'issueReceipt');
    syncGit = vi.spyOn(TrustedGit.prototype, 'exec');
    asyncGit = vi.spyOn(TrustedGit.prototype, 'execAsync');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      fixture: [
        { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
      ],
    });
  });
  afterEach(async () => {
    try {
      await audit?.();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      cleanupComposition();
    }
  });
}
