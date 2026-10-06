/**
 * Batch-prep token attribution (#796): enqueue-time session capture, the
 * per-session windows, and the ledger join to `batch:<id>`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPrepWindows,
  batchPrepTokens,
  currentSessionId,
  MAX_PREP_LOOKBACK_MS,
  prepWindows,
  readBatchPrep,
  readPrepMarkers,
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
  vi.unstubAllEnvs();
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
    expect(out.get('b-1')).toEqual({
      billable_tokens: 2 * 135,
      sessions: 1,
      messages: 2,
      basis: 'lookback-cap',
      split: false,
    });
  });
});

/** A Claude Code transcript with one assistant message per timestamp (135 tokens each). */
function writeTranscript(home: string, stamps: string[]): { projects: string } {
  const projectsDir = path.join(home, 'claude', 'projects', '-x');
  fs.mkdirSync(projectsDir, { recursive: true });
  const lines = stamps.map((ts) =>
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
    })
  );
  fs.writeFileSync(path.join(projectsDir, `${SESSION}.jsonl`), `${lines.join('\n')}\n`);
  return { projects: path.join(home, 'claude', 'projects') };
}

function writeRun(runsLog: string, dossier: string, isoEnd: string, durationMs = 1000): void {
  fs.appendFileSync(
    runsLog,
    `${JSON.stringify({ timestamp: isoEnd, dossier, duration_ms: durationMs, session_id: SESSION })}\n`
  );
}

describe('prep-start marker (#899)', () => {
  const rec = (ts: string, batch: string, members?: number) => ({
    ts,
    batch,
    session_id: SESSION,
    source: 'env' as const,
    ...(members ? { members } : {}),
  });

  it('readPrepMarkers picks only batch-issues-preparation runs and backs out the duration', () => {
    const home = tmpDir();
    const log = path.join(home, 'runs.jsonl');
    writeRun(log, 'imboard-ai/git/batch-issues-preparation', '2026-09-29T09:50:02Z', 2000);
    writeRun(log, 'imboard-ai/git/full-cycle-issue', '2026-09-29T09:00:00Z');
    fs.appendFileSync(log, 'not json batch-issues-preparation "session_id"\n');
    expect(readPrepMarkers(log)).toEqual([
      { session_id: SESSION, startMs: Date.parse('2026-09-29T09:50:00Z') },
    ]);
  });

  it('starts the window at the marker, ignoring markers already spent on an earlier enqueue', () => {
    const marker = (iso: string) => ({ session_id: SESSION, startMs: Date.parse(iso) });
    const [w1, w2] = prepWindows(
      [rec('2026-09-29T10:30:00Z', 'b-1'), rec('2026-09-29T13:00:00Z', 'b-2')],
      [marker('2026-09-29T09:50:00Z'), marker('2026-09-29T12:40:00Z')]
    );
    expect(w1.basis).toBe('marker');
    expect(w1.fromMs).toBeGreaterThanOrEqual(Date.parse('2026-09-29T09:50:00Z') - 1);
    expect(w1.fromMs).toBeLessThan(Date.parse('2026-09-29T09:50:00Z'));
    expect(w2.basis).toBe('marker');
    expect(w2.fromMs).toBeGreaterThan(Date.parse('2026-09-29T10:30:00Z'));
    // A marker from before the previous enqueue does not extend the later window.
    const [, late] = prepWindows(
      [rec('2026-09-29T10:30:00Z', 'b-1'), rec('2026-09-29T13:00:00Z', 'b-2')],
      [marker('2026-09-29T09:50:00Z')]
    );
    expect(late.basis).toBe('prev-enqueue');
    expect(late.fromMs).toBe(Date.parse('2026-09-29T10:30:00Z'));
  });

  it('ignores a marker older than the lookback cap (a prep run days ago is not this batch)', () => {
    const [w] = prepWindows(
      [rec('2026-09-29T10:30:00Z', 'b-1')],
      [{ session_id: SESSION, startMs: Date.parse('2026-09-27T09:00:00Z') }]
    );
    expect(w.basis).toBe('lookback-cap');
    expect(w.fromMs).toBe(Date.parse('2026-09-29T10:30:00Z') - MAX_PREP_LOOKBACK_MS);
  });

  it('excludes unrelated work before the prep started; labels the fallback when there is no marker', () => {
    const home = tmpDir();
    const schedRoot = path.join(home, 'sched');
    const schedDir = path.join(schedRoot, 'proj');
    // Hours of unrelated orchestration (07:00-09:00, 5 msgs), then prep (09:50-10:20, 3 msgs).
    const { projects } = writeTranscript(home, [
      '2026-09-29T07:00:00.000Z',
      '2026-09-29T07:30:00.000Z',
      '2026-09-29T08:00:00.000Z',
      '2026-09-29T08:30:00.000Z',
      '2026-09-29T09:00:00.000Z',
      '2026-09-29T09:51:00.000Z',
      '2026-09-29T10:00:00.000Z',
      '2026-09-29T10:20:00.000Z',
    ]);
    const runsLog = path.join(home, 'runs.jsonl');
    const paths = {
      claudeProjectsDir: projects,
      opencodeDb: path.join(home, 'none.db'),
      schedRoot,
      runsLog,
    };
    recordBatchPrep(schedDir, ['b-1'], SESSION, 'env', new Date('2026-09-29T10:30:00Z'));

    const without = batchPrepTokens(schedDir, ['b-1'], paths).get('b-1');
    expect(without).toMatchObject({ messages: 8, basis: 'lookback-cap' });

    writeRun(runsLog, 'imboard-ai/git/batch-issues-preparation', '2026-09-29T09:50:01Z', 1000);
    const withMarker = batchPrepTokens(schedDir, ['b-1'], paths).get('b-1');
    expect(withMarker).toEqual({
      billable_tokens: 3 * 135,
      sessions: 1,
      messages: 3,
      basis: 'marker',
      split: false,
    });
  });

  it('splits a multi-batch enqueue by member count: per-batch sums equal the window total', () => {
    // The split hashes each row's key, which includes the collecting host. Pin it, or
    // which batch wins each of the 12 rows depends on the machine running the test (#1071).
    vi.stubEnv('DOSSIER_USAGE_HOST', 'h');
    const home = tmpDir();
    const schedRoot = path.join(home, 'sched');
    const schedDir = path.join(schedRoot, 'proj');
    const stamps = Array.from(
      { length: 12 },
      (_, i) => `2026-09-29T10:${String(i).padStart(2, '0')}:00.000Z`
    );
    const { projects } = writeTranscript(home, stamps);
    const paths = {
      claudeProjectsDir: projects,
      opencodeDb: path.join(home, 'none.db'),
      schedRoot,
      runsLog: path.join(home, 'runs.jsonl'),
    };
    recordBatchPrep(
      schedDir,
      ['b-1', 'b-2'],
      SESSION,
      'env',
      new Date('2026-09-29T10:30:00Z'),
      new Map([
        ['b-1', 3],
        ['b-2', 1],
      ])
    );
    const out = batchPrepTokens(schedDir, undefined, paths);
    const a = out.get('b-1');
    const b = out.get('b-2');
    expect((a?.billable_tokens ?? 0) + (b?.billable_tokens ?? 0)).toBe(12 * 135);
    expect((a?.messages ?? 0) + (b?.messages ?? 0)).toBe(12);
    expect(a?.messages).toBeGreaterThan(b?.messages ?? 99); // 3:1 weights (10:2 for host 'h')
    expect(a?.split && b?.split).toBe(true);
    // Asking for one batch must not hand it its sibling's share.
    expect(batchPrepTokens(schedDir, ['b-2'], paths).get('b-2')?.billable_tokens).toBe(
      (b?.messages ?? 0) * 135
    );
  });

  it('applyPrepWindows deals a shared window by weight and leaves single-batch rows whole', () => {
    const windows = prepWindows([
      rec('2026-09-29T10:30:00Z', 'b-1', 1),
      rec('2026-09-29T10:30:00Z', 'b-2', 1),
    ]);
    const rows = Array.from({ length: 6 }, (_, i) => row({ ts: `2026-09-29T10:0${i}:00.000Z` }));
    applyPrepWindows(rows, windows);
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.batch ?? '-', (per.get(r.batch ?? '-') ?? 0) + 1);
    expect([...per.values()].reduce((n, v) => n + v, 0)).toBe(6);
    expect([...per.keys()].every((k) => k === 'b-1' || k === 'b-2')).toBe(true);
    // Deterministic and order-independent: the same rows split the same way in any order.
    const again = [...rows]
      .reverse()
      .map((r) => ({ ...r, unit: null, batch: null, role: undefined }));
    applyPrepWindows(again, windows);
    expect(new Map(again.map((r) => [r.ts, r.batch]))).toEqual(
      new Map(rows.map((r) => [r.ts, r.batch]))
    );
    expect(rows.every((r) => r.prep_split === 2 && r.role === 'prep')).toBe(true);
  });
});
