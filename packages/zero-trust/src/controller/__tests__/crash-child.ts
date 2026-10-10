/** Physical process-crash fixture; parent kills this process only after the model
 * transport is actually in flight behind a durably reserved call. No ledger edits. */
import os from 'node:os';
import { rig } from './composition-fixture';

os.networkInterfaces = () => ({
  fixture: [
    { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
  ],
});
let h: ReturnType<typeof rig>;
h = rig({
  root: process.argv[2],
  persistent: true,
  oauthExpiresIn: 1,
  oauthRefreshExpiresIn: 1,
  beforeModel: async (request) => {
    if (
      request.tools[0]?.function.name !== 'report_decision' &&
      !JSON.stringify(request.tools).includes('submit_plan')
    ) {
      process.send?.({ runId: h.controller.snapshot().runId });
      await new Promise<void>(() => {});
    }
  },
});
void h.authorize(h.controller.start(h.config)).catch(() => {
  process.exitCode = 1;
});
