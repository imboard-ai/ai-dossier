import fs from 'node:fs';
import path from 'node:path';

/**
 * Write one `tool_use` line into a dispatch log, in the shape a real headless
 * agent's `stream-json` output carries.
 *
 * The `last_tool` work (#591, #620) spans two rails with separate test files —
 * `engine.test.ts` for full-cycle units, `batch-integration.test.ts` for batch
 * members — and each grew its own copy of this literal, four between them. The
 * point of every one of those tests is that BOTH rails read the same shape, so
 * the fixture drifting between files would quietly make them stop testing that.
 *
 * Appends rather than truncates (a member's log already holds the spawn's own
 * stderr) and creates the runs directory, which the fake spawn does not.
 */
export function writeToolUseLog(logFile: string, tool = 'Monitor'): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: {} }] },
    })}\n`
  );
}
