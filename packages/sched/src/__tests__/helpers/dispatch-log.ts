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

/**
 * Write a `type:"result"` line carrying a confirmed provider API error
 * (ai-dossier#629) — the shape a headless agent's `stream-json` output
 * carries when the PROVIDER rejects a dispatch (e.g. a 429 spend/rate wall),
 * never an agent that ran. Mirrors the real incident's own log line. Shared
 * between `engine.test.ts` (per-issue units) and `batch-integration.test.ts`
 * (batch tail/member/report/fix) for the same reason `writeToolUseLog` is:
 * both rails must read the same shape.
 */
export function writeApiErrorLog(logFile: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({
      type: 'result',
      api_error_status: 429,
      terminal_reason: 'api_error',
      is_error: true,
      num_turns: 1,
      duration_ms: 718,
      modelUsage: {},
      result: "You've hit your monthly spend limit · your session limit resets 8:40pm (UTC)",
      ...overrides,
    })}\n`
  );
}

/**
 * Write the supersession-checkpoint verdict a DEFERRING dispatch carries (#683 AC3) —
 * the exact `runstate check` output shapes the dispatch log captures when an agent
 * finds an owner and steps aside: the human stderr line, and the dedup marker of the
 * abort comment the CLI posted. `parseFenceAbort` keys on these wordings, so the
 * fixture must not drift from the CLI's own strings.
 *
 * Appends, like its siblings, and creates the runs directory.
 */
export function writeFenceAbortLog(
  logFile: string,
  run: string,
  gen: number,
  takeover: string
): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(
    logFile,
    `❌ Run ${run} was SUPERSEDED at generation ${gen} (takeover '${takeover}', fenced at implement on 2026-09-09T15:16:33Z).\n` +
      `   Stop working on the issue and exit: another agent owns it. Do not push, do not open a PR.\n` +
      `<!-- runstate-abort:${run}:${gen} -->\n`
  );
}

/**
 * Write the announce-then-exit signature (#685) — the shape the issue's three
 * incidents (~$52 of discarded work) share: the agent starts (optionally) a
 * background command, its FINAL assistant text announces a wait, and the
 * session ends with a CLEAN `result` event (`is_error: false`,
 * `subtype: "success"`). `parseAnnouncedWait` keys on both halves — the clean
 * exit and the wait announcement in the last text block — so the fixture must
 * carry both. Appends, like its siblings, and creates the runs directory.
 */
export function writeAnnouncedWaitLog(
  logFile: string,
  message: string,
  opts: { backgroundToolUse?: boolean; isError?: boolean } = {}
): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const lines: string[] = [];
  if (opts.backgroundToolUse) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'bash scripts/ci-parity.sh', run_in_background: true },
            },
          ],
        },
      })
    );
  }
  lines.push(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: message }] } })
  );
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: opts.isError ?? false,
      num_turns: 4,
      duration_ms: 25 * 60 * 1000,
      result: message,
    })
  );
  fs.appendFileSync(logFile, `${lines.join('\n')}\n`);
}
