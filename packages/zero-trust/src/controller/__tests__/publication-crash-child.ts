/** Real process death after publication persistence but before credential release. */
import { RunController } from '../controller';
import { rig } from './composition-fixture';

async function main() {
  const h = rig({ root: process.argv[2], persistent: true });
  const first = (await h.authorize(h.controller.start(h.config))) as { runId: string };
  h.submit(first.runId);
  const original = RunController.prototype.snapshot;
  // The observer notifies a persisted submitted record before launch finalization.
  // Interrupt that actual boundary in this disposable child, not a journal forgery.
  const observe = Object.getOwnPropertyDescriptor(RunController.prototype, 'notify')?.value;
  if (typeof observe !== 'function') throw new Error('publication observer missing');
  Object.defineProperty(RunController.prototype, 'notify', {
    value: function (this: RunController, run: { state: string }) {
      observe.call(this, run);
      if (run.state === 'submitted') {
        process.send?.({ runId: original.call(this).runId });
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });
  await h.authorize(h.controller.resume(first.runId));
  throw new Error('publication crash boundary was not reached');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
