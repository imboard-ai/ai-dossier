/**
 * Batch-prep token attribution (#796): enqueue-time session capture, the
 * per-session windows, and the ledger join to `batch:<id>`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPrepWindows,
  batchPrepTokens,
  currentSessionId,
  MAX_PREP_LOOKBACK_MS,
  prepWindows,
  readBatchPrep,
  recordBatchPrep,
} from '../usage/batch-prep';
import type { UsageRow } from '../usage/types';

const tmp: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-prep-'));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SESSION = '11111111-2222-3333-4444-555555555555';

function row(over: Partial<UsageRow>): UsageRow {
  return {
    ts: '2026-09-29T10:00:00.000Z',
    host: 'h',
    provider: 'anthropic',
    model: 'claude-x',
    input: 10,
    output: 5,
    reasoning: 0,
    cache_read: 100,
    cache_write: 20,
    cost_usd: null,
    source: 'claude-code',
    session_id: SESSION,
    parent_session_id: null,
    title: null,
    cwd: null,
    project: null,
    branch: null,
    issue: null,
    issue_source: null,
    batch: null,
    unit: null,
    ...over,
  };
}

describe('currentSessionId', () => {
  it('reads CLAUDE_CODE_SESSION_ID and rejects junk', () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: SESSION })).toBe(SESSION);
    expect(currentSessionId({})).toBeNull();
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: '../x' })).toBeNull();
  });
});

describe('recordBatchPrep / prepWindows', () => {
  it('appends one record per distinct batch and reads them back', () => {
    const dir = tmpDir();
    recordBatchPrep(dir, ['b-1', 'b-1', 'b-2'], SESSION, 'env', new Date('2026-09-29T10:00:00Z'));
    const records = readBatchPrep(dir);
    expect(records.map((r) => r.batch)).toEqual(['b-1', 'b-2']);
    expect(records[0]).toMatchObject({ session_id: SESSION, source: 'env' });
  });

  it('bounds a window by the same session previous enqueue, capped by the lookback', () => {
    const rec = (ts: string, batch: string, session_id = SESSION) => ({
      ts,
      batch,
      session_id,
      source: 'env' as const,
    });
    const w = prepWindows([
      rec('2026-09-29T09:00:00Z', 'b-1'),
      rec('2026-09-29T12:00:00Z', 'b-2'),
      rec('2026-09-30T12:00:00Z', 'b-3'),
      rec('2026-09-29T11:00:00Z', 'other', 'other-session-1'),
    ]);
    const by = Object.fromEntries(w.map((x) => [x.batch, x]));
    expect(by['b-2'].fromMs).toBe(Date.parse('2026-09-29T09:00:00Z'));
    expect(by['b-3'].fromMs).toBe(Date.parse('2026-09-30T12:00:00Z') - MAX_PREP_LOOKBACK_MS);
    expect(by.other.fromMs).toBe(Date.parse('2026-09-29T11:00:00Z') - MAX_PREP_LOOKBACK_MS);
  });
});

describe('applyPrepWindows', () => {
  const windows = prepWindows([
    { ts: '2026-09-29T10:30:00Z', batch: 'b-1', session_id: SESSION, source: 'env' },
  ]);

  it('attributes in-window rows of the session and its subagents, keeps dispatch attribution', () => {
    const rows = [
      row({}),
      row({ session_id: `${SESSION}/agent-a`, parent_session_id: SESSION }),
      row({ ts: '2026-09-29T11:00:00.000Z' }), // after the enqueue
      row({ ts: '2026-09-29T03:00:00.000Z' }), // beyond the lookback
      row({ session_id: 'someone-else-1' }),
      row({ unit: 'issue:5', issue: 5 }),
    ];
    applyPrepWindows(rows, windows);
    expect(rows.map((r) => r.unit)).toEqual([
      'batch:b-1',
      'batch:b-1',
      null,
      null,
      null,
      'issue:5',
    ]);
    expect(rows[0]).toMatchObject({ batch: 'b-1', role: 'prep' });
    expect(rows[5].role).toBeUndefined();
  });
});

describe('batchPrepTokens', () => {
  it('sums the prep session transcript tokens for a recorded batch; unrecorded batch is absent', () => {
    const home = tmpDir();
    const schedRoot = path.join(home, 'sched');
    const schedDir = path.join(schedRoot, 'proj');
    const projectsDir = path.join(home, 'claude', 'projects', '-x');
    fs.mkdirSync(projectsDir, { recursive: true });
    const line = (ts: string) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: SESSION,
        timestamp: ts,
        cwd: '/x',
        message: {
          id: `m-${ts}`,
          model: 'claude-x',
          role: 'assistant',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      });
    fs.writeFileSync(
      path.join(projectsDir, `${SESSION}.jsonl`),
      `${line('2026-09-29T10:00:00.000Z')}\n${line('2026-09-29T10:10:00.000Z')}\n${line('2026-09-29T12:00:00.000Z')}\n`
    );
    recordBatchPrep(schedDir, ['b-1'], SESSION, 'env', new Date('2026-09-29T10:30:00Z'));
    const out = batchPrepTokens(schedDir, ['b-1', 'b-none'], {
      claudeProjectsDir: path.join(home, 'claude', 'projects'),
      opencodeDb: path.join(home, 'none.db'),
      schedRoot,
      runsLog: path.join(home, 'runs.jsonl'),
    });
    expect(out.get('b-none')).toBeUndefined();
    expect(out.get('b-1')).toEqual({ billable_tokens: 2 * 135, sessions: 1, messages: 2 });
  });
});
