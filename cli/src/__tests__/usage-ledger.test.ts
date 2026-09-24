/**
 * `ai-dossier usage` ledger (#769): collectors, attribution joins,
 * aggregation and the window/scope reports — all against fixture stores in a
 * temp dir (never the operator's real ~/.claude or opencode.db).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildScopeReport,
  buildWindowReport,
  formatTokens,
  parseDurationSpec,
  parseSince,
  renderScopeReport,
  renderWindowReport,
} from '../commands/usage';
import { collectClaude } from '../usage/collect-claude';
import {
  applyDispatchIndex,
  collectSchedLimitEvents,
  countDossierRuns,
  indexDispatchLogs,
  parseDispatchLogName,
  providerFromText,
  sessionIdsIn,
  sessionsIn,
} from '../usage/collect-dispatch';
import {
  collectOpenCode,
  loadNodeSqlite,
  type OpenCodeMessage,
  type OpenCodeReader,
  type OpenCodeSession,
  openOpenCodeDb,
} from '../usage/collect-opencode';
import {
  ancestorDepth,
  detectHostSession,
  findClaudeTranscript,
  hasPendingDossierRun,
  lastAssistantModel,
} from '../usage/host-session';
import {
  collapseLimitEvents,
  groupRows,
  hourlyBurn,
  type LedgerPaths,
  limitContexts,
  modelCoverage,
  summarizeSessions,
  totalsOf,
} from '../usage/ledger';
import type { LimitEvent, UsageRow } from '../usage/types';
import { forEachLine, issueFromRef, projectOf } from '../usage/util';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function write(file: string, lines: unknown[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`
  );
  // Collectors prefilter by mtime against the (fixed) test clock.
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
  return file;
}

function assistant(opts: {
  ts: string;
  id: string;
  model?: string;
  session: string;
  agentId?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  branch?: string;
  cwd?: string;
}) {
  return {
    type: 'assistant',
    timestamp: opts.ts,
    sessionId: opts.session,
    ...(opts.agentId ? { agentId: opts.agentId, isSidechain: true } : {}),
    requestId: `req_${opts.id}`,
    cwd: opts.cwd ?? '/home/u/projects/ai-dossier/worktrees/feat-769-usage',
    gitBranch: opts.branch ?? 'feat/769-usage',
    message: {
      id: `msg_${opts.id}`,
      model: opts.model ?? 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 20,
        cache_read_input_tokens: opts.cacheRead ?? 1000,
        cache_creation_input_tokens: opts.cacheWrite ?? 100,
      },
    },
  };
}

const SESSION = '11111111-2222-3333-4444-555555555555';

/** A Claude projects dir with one main session, one subagent, and an API-error limit row. */
function claudeFixture(root: string): string {
  const projectsDir = path.join(root, 'claude', 'projects');
  const slugDir = path.join(projectsDir, '-home-u-projects-ai-dossier');
  write(path.join(slugDir, `${SESSION}.jsonl`), [
    { type: 'user', timestamp: iso(90 * MIN), message: { role: 'user', content: 'go' } },
    // same message written twice (one line per content block) — must count once
    assistant({ ts: iso(60 * MIN), id: 'a1', session: SESSION, output: 3 }),
    assistant({ ts: iso(60 * MIN), id: 'a1', session: SESSION }),
    assistant({ ts: iso(30 * MIN), id: 'a2', session: SESSION, model: 'claude-fable-5-1' }),
    // out of a 5h window
    assistant({ ts: iso(9 * HOUR), id: 'old', session: SESSION }),
    {
      type: 'assistant',
      timestamp: iso(10 * MIN),
      sessionId: SESSION,
      isApiErrorMessage: true,
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your limit · resets 7am" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    'not json',
  ]);
  const subFile = path.join(slugDir, SESSION, 'subagents', 'agent-abc123.jsonl');
  write(subFile, [
    assistant({
      ts: iso(20 * MIN),
      id: 's1',
      session: SESSION,
      agentId: 'abc123',
      model: 'claude-sonnet-5',
      input: 5,
      output: 5,
      cacheRead: 500,
      cacheWrite: 0,
    }),
  ]);
  fs.writeFileSync(
    subFile.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'find the thing' })
  );
  return projectsDir;
}

function fakeOpenCode(sessions: OpenCodeSession[], messages: Record<string, OpenCodeMessage[]>) {
  const reader: OpenCodeReader & { closed: boolean } = {
    closed: false,
    sessionsUpdatedSince: () => sessions,
    messagesSince: (id, since) => (messages[id] ?? []).filter((m) => m.time_created >= since),
    close() {
      this.closed = true;
    },
  };
  return reader;
}

function ocMessage(id: string, msAgo: number, data: Record<string, unknown>): OpenCodeMessage {
  return { id, time_created: NOW - msAgo, data: JSON.stringify(data) };
}

function ocAssistant(
  msAgo: number,
  tokens: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    role: 'assistant',
    modelID: 'gpt-5.6-luna',
    providerID: 'openai',
    cost: 0,
    tokens,
    time: { created: NOW - msAgo, completed: NOW - msAgo + 1000 },
    path: { cwd: '/home/u/projects/imboard-monorepo' },
    ...extra,
  };
}

describe('util', () => {
  it('issueFromRef takes a standalone issue number and skips date-like / pool ids', () => {
    expect(issueFromRef('feat/769-usage-ledger')).toBe(769);
    expect(issueFromRef('fix-4360-x')).toBe(4360);
    expect(issueFromRef('issue-12')).toBe(12);
    expect(issueFromRef('main')).toBeNull();
    expect(issueFromRef('b-20260920-01')).toBeNull();
    expect(issueFromRef('pool/spare-pool-1790235070746-3128801')).toBeNull();
    expect(issueFromRef(null)).toBeNull();
  });

  it('projectOf names the repo behind worktrees/ and main/ checkouts', () => {
    expect(projectOf('/h/projects/ai-dossier/worktrees/feat-x')).toBe('ai-dossier');
    expect(projectOf('/h/projects/ai-dossier/main')).toBe('ai-dossier');
    expect(projectOf('/h/projects/imboard-monorepo')).toBe('imboard-monorepo');
    expect(projectOf(null)).toBeNull();
  });

  it('forEachLine yields every line including a final unterminated one', () => {
    const file = path.join(tmpDir(), 'f.jsonl');
    fs.writeFileSync(file, 'a\n\nb\nc');
    const lines: string[] = [];
    expect(forEachLine(file, (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(forEachLine(path.join(tmpDir(), 'missing'), () => {})).toBe(false);
  });

  it('parses durations and --since specs', () => {
    expect(parseDurationSpec('5h')).toBe(5 * HOUR);
    expect(parseDurationSpec('30m')).toBe(30 * MIN);
    expect(parseDurationSpec('bogus')).toBeNull();
    expect(parseSince('1d', NOW)).toBe(NOW - 24 * HOUR);
    expect(parseSince('2026-09-01', NOW)).toBe(Date.parse('2026-09-01'));
    expect(parseSince('nope', NOW)).toBeNull();
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });
});

describe('collectClaude', () => {
  it('dedupes multi-block messages, links subagents to their parent, and records limit rows', () => {
    const projectsDir = claudeFixture(tmpDir());
    const { rows, limits, files } = collectClaude({
      projectsDir,
      sinceMs: NOW - 5 * HOUR,
      untilMs: NOW,
      host: 'h1',
    });
    expect(files).toBe(2);
    const ids = rows.map((r) => `${r.session_id}:${r.model}`).sort();
    expect(ids).toEqual([
      `${SESSION}/abc123:claude-sonnet-5`,
      `${SESSION}:claude-fable-5-1`,
      `${SESSION}:claude-opus-5-5`,
    ]);
    const sub = rows.find((r) => r.session_id.includes('/'));
    expect(sub).toMatchObject({
      parent_session_id: SESSION,
      title: 'Explore: find the thing',
      provider: 'anthropic',
      source: 'claude-code',
      issue: 769,
      issue_source: 'branch',
      project: 'ai-dossier',
      host: 'h1',
    });
    // the first (partial, output 3) line of msg a1 is superseded by the final count
    const main = rows.find((r) => r.model === 'claude-opus-5-5');
    expect(main).toMatchObject({ input: 10, output: 20, cache_read: 1000, cache_write: 100 });
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      source: 'claude-code',
      provider: 'anthropic',
      session_id: SESSION,
    });
  });

  it('skips transcripts last modified before the window without reading them', () => {
    const projectsDir = claudeFixture(tmpDir());
    const { rows, files } = collectClaude({
      projectsDir,
      sinceMs: NOW + HOUR, // every fixture file is older than this
      host: 'h1',
    });
    expect(files).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe('collectOpenCode', () => {
  it('maps assistant messages to provider/model rows, skipping streaming zero-token ones', () => {
    const reader = fakeOpenCode(
      [
        { id: 'ses_parent', parent_id: null, directory: '/w/feat-4178-x', title: 'Full cycle' },
        {
          id: 'ses_child',
          parent_id: 'ses_parent',
          directory: '/w',
          title: 'Explore (@explore subagent)',
        },
      ],
      {
        ses_parent: [
          ocMessage(
            'm1',
            30 * MIN,
            ocAssistant(30 * MIN, {
              input: 100,
              output: 10,
              reasoning: 5,
              cache: { read: 1000, write: 0 },
            })
          ),
          ocMessage(
            'm2',
            20 * MIN,
            ocAssistant(20 * MIN, {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            })
          ),
          ocMessage('m3', 19 * MIN, { role: 'user' }),
          { id: 'bad', time_created: NOW - MIN, data: '{not json' },
        ],
        ses_child: [
          ocMessage('c1', 10 * MIN, ocAssistant(10 * MIN, { input: 7, output: 1, cache: {} })),
        ],
      }
    );
    const rows = collectOpenCode({ reader, sinceMs: NOW - HOUR, host: 'h1' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'opencode',
      provider: 'openai',
      model: 'openai/gpt-5.6-luna',
      input: 100,
      reasoning: 5,
      cache_read: 1000,
      cost_usd: 0,
      cwd: '/home/u/projects/imboard-monorepo',
      title: 'Full cycle',
    });
    expect(rows[1]).toMatchObject({ session_id: 'ses_child', parent_session_id: 'ses_parent' });
  });

  const sqlite = loadNodeSqlite();
  it.skipIf(!sqlite)('reads a real SQLite store read-only through node:sqlite', () => {
    const dbFile = path.join(tmpDir(), 'opencode.db');
    // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
    const db = new sqlite!.DatabaseSync(dbFile);
    db.prepare(
      'CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text NOT NULL, time_updated integer NOT NULL)'
    ).all();
    db.prepare(
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)'
    ).all();
    db.prepare("INSERT INTO session VALUES ('ses_1', NULL, '/w', 't', ?)").all(NOW - MIN);
    db.prepare("INSERT INTO message VALUES ('m1', 'ses_1', ?, ?)").all(
      NOW - 5 * MIN,
      JSON.stringify(ocAssistant(5 * MIN, { input: 3, output: 4, cache: { read: 5, write: 6 } }))
    );
    db.close();
    const before = fs.readFileSync(dbFile);

    const opened = openOpenCodeDb(dbFile);
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    const rows = collectOpenCode({ reader: opened.reader, sinceMs: NOW - HOUR, host: 'h1' });
    opened.reader.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      input: 3,
      output: 4,
      cache_read: 5,
      cache_write: 6,
    });
    expect(fs.readFileSync(dbFile).equals(before)).toBe(true);
  });

  it.skipIf(!sqlite)(
    'reports a store with an unexpected schema as an error instead of throwing',
    () => {
      const dbFile = path.join(tmpDir(), 'other.db');
      // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
      const db = new sqlite!.DatabaseSync(dbFile);
      db.prepare('CREATE TABLE unrelated (x integer)').all();
      db.close();
      const res = openOpenCodeDb(dbFile);
      expect(res.status).toBe('error');
    }
  );

  it('reports a missing database / missing node:sqlite as unavailable instead of throwing', () => {
    expect(openOpenCodeDb(path.join(tmpDir(), 'nope.db')).status).toBe('unavailable');
    const file = path.join(tmpDir(), 'exists.db');
    fs.writeFileSync(file, '');
    const res = openOpenCodeDb(file, null);
    expect(res.status).toBe('unavailable');
  });
});

describe('dispatch attribution', () => {
  function schedFixture(root: string): string {
    const schedRoot = path.join(root, 'sched');
    const runs = path.join(schedRoot, 'imboard-ai-imboard-monorepo', 'runs');
    write(path.join(runs, 'batch-b-20260920-01-m1-4360.log'), [
      {
        type: 'sched-dispatch',
        ts: iso(HOUR),
        cmd: ['opencode', 'run', '-m', 'openai/gpt-5.6-luna', '--'],
      },
      { type: 'step_start', sessionID: 'ses_member', part: { sessionID: 'ses_member' } },
      // a tool result that merely MENTIONS another session id (escaped) must not match
      { type: 'text', part: { text: '{"sessionID":"ses_other"}' } },
    ]);
    write(path.join(runs, 'issue-771.log'), [
      { type: 'sched-dispatch', cmd: ['claude', '-p', '--model', 'opus'] },
      { type: 'system', subtype: 'init', session_id: SESSION },
    ]);
    write(path.join(schedRoot, 'imboard-ai-imboard-monorepo', 'events.jsonl'), [
      {
        ts: iso(15 * MIN),
        event: 'dispatch-failure',
        unit: 'issue:4360',
        detail: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
        api_error_status: 429,
      },
      {
        ts: iso(14 * MIN),
        event: 'dispatch-unhealthy',
        unit: 'issue:4360',
        detail: '2 consecutive failures',
      },
      {
        ts: iso(13 * MIN),
        event: 'dispatch-failure',
        unit: 'issue:9',
        detail: 'ECONNRESET',
        api_error_status: 500,
      },
    ]);
    return schedRoot;
  }

  it('parses every sched log filename shape', () => {
    expect(parseDispatchLogName('batch-b-1-m2-540.log')).toMatchObject({
      unit: 'issue:540',
      batch: 'b-1',
      role: 'member',
    });
    expect(parseDispatchLogName('batch-b1-fix-542.log')).toMatchObject({ issue: 542, role: 'fix' });
    expect(parseDispatchLogName('batch-b1-tail.log')).toMatchObject({
      unit: 'batch:b1',
      issue: null,
      role: 'tail',
    });
    expect(parseDispatchLogName('issue-7.log')).toMatchObject({ unit: 'issue:7', batch: null });
    expect(parseDispatchLogName('notes.txt')).toBeNull();
  });

  it('extracts only top-level session ids, each with its own dispatch model', () => {
    expect(sessionIdsIn('{"sessionID":"ses_A1"}\n{"x":"{\\"sessionID\\":\\"ses_B2\\"}"}')).toEqual([
      'ses_A1',
    ]);
    // a tool call's input naming another session is not this unit's session
    expect(
      sessionIdsIn(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', input: { session_id: SESSION } }] },
        })
      )
    ).toEqual([]);
    const log = [
      { type: 'sched-dispatch', cmd: ['claude', '-p', '--model', 'opus'] },
      { type: 'system', subtype: 'init', session_id: SESSION },
      { type: 'sched-dispatch', cmd: ['opencode', 'run', '-m', 'openai/gpt-5.6-luna'] },
      { type: 'step_start', sessionID: 'ses_retry' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(sessionsIn(log)).toEqual([
      { session_id: SESSION, model: 'opus' },
      { session_id: 'ses_retry', model: 'openai/gpt-5.6-luna' },
    ]);
  });
  it('indexes sessions → unit/batch/model and stamps rows (children inherit)', () => {
    const schedRoot = schedFixture(tmpDir());
    const index = indexDispatchLogs(schedRoot, 0);
    expect([...index.keys()].sort()).toEqual([SESSION, 'ses_member']);
    expect(index.get('ses_member')).toMatchObject({
      issue: 4360,
      batch: 'b-20260920-01',
      model: 'openai/gpt-5.6-luna',
    });

    const base = {
      ts: iso(MIN),
      host: 'h',
      provider: 'openai',
      input: 1,
      output: 1,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost_usd: null,
      source: 'opencode' as const,
      title: null,
      cwd: null,
      project: null,
      branch: null,
      issue: 999,
      issue_source: 'branch' as const,
      batch: null,
      unit: null,
    };
    const rows: UsageRow[] = [
      { ...base, session_id: 'ses_member', parent_session_id: null, model: null },
      { ...base, session_id: 'ses_kid', parent_session_id: 'ses_member', model: 'openai/x' },
      { ...base, session_id: 'ses_unrelated', parent_session_id: null, model: 'openai/x' },
      { ...base, session_id: 'ses_grandkid', parent_session_id: 'ses_kid', model: 'openai/x' },
    ];
    applyDispatchIndex(rows, index);
    expect(rows[0]).toMatchObject({
      issue: 4360,
      issue_source: 'dispatch',
      batch: 'b-20260920-01',
      model: 'openai/gpt-5.6-luna',
    });
    expect(rows[1]).toMatchObject({ issue: 4360, unit: 'issue:4360', model: 'openai/x' });
    expect(rows[2]).toMatchObject({ issue: 999, issue_source: 'branch', unit: null });
    expect(rows[3]).toMatchObject({ issue: 4360, batch: 'b-20260920-01' });
  });

  it('collects only limit-shaped sched failures, inferring the provider from the text', () => {
    const schedRoot = schedFixture(tmpDir());
    const events = collectSchedLimitEvents(schedRoot, NOW - HOUR, NOW, 'h');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'sched',
      provider: 'anthropic',
      status: 429,
      unit: 'issue:4360',
    });
    expect(providerFromText('openai rate limit')).toBe('openai');
    expect(providerFromText('something else')).toBeNull();
  });

  it('counts ai-dossier runs per host session from runs.jsonl', () => {
    const file = write(path.join(tmpDir(), 'runs.jsonl'), [
      { timestamp: iso(MIN), dossier: 'a', session_id: SESSION },
      { timestamp: iso(2 * MIN), dossier: 'b', session_id: SESSION },
      { timestamp: iso(3 * MIN), dossier: 'c' },
      { timestamp: iso(10 * HOUR), dossier: 'd', session_id: SESSION },
    ]);
    expect(countDossierRuns(file, NOW - HOUR, NOW).get(SESSION)).toBe(2);
  });
});

describe('aggregation', () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({
    ts: iso(MIN),
    host: 'h',
    provider: 'anthropic',
    model: 'm',
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: null,
    source: 'claude-code',
    session_id: 's',
    parent_session_id: null,
    title: null,
    cwd: null,
    project: 'p',
    branch: null,
    issue: null,
    issue_source: null,
    batch: null,
    unit: null,
    ...over,
  });

  it('totals, groups, coverage and sessions', () => {
    const rows = [
      row({ session_id: 'a', input: 90, model: 'x' }),
      row({ session_id: 'a', output: 5, model: 'y' }),
      row({ session_id: 'b', input: 5, model: null, cost_usd: 0.5 }),
    ];
    expect(totalsOf(rows)).toMatchObject({ total: 100, messages: 3, cost_usd: 0.5 });
    expect(modelCoverage(rows)).toBeCloseTo(0.95);
    expect(modelCoverage([])).toBe(1);
    expect(groupRows(rows, (r) => r.model ?? '?').map((g) => g.key)).toEqual(['x', '?', 'y']);
    const sessions = summarizeSessions(rows);
    expect(sessions[0]).toMatchObject({ session_id: 'a', total: 95, models: ['x', 'y'] });
  });

  it('hourly burn buckets by clock hour across the window', () => {
    const rows = [row({ ts: iso(30 * MIN), input: 10 }), row({ ts: iso(90 * MIN), input: 20 })];
    const burn = hourlyBurn(rows, NOW - 2 * HOUR, NOW);
    expect(burn.map((b) => b.total)).toEqual([20, 10]);
  });

  it('explains a limit with the top same-provider consumers of the preceding window', () => {
    const rows = [
      row({ session_id: 'big', input: 1000, ts: iso(2 * HOUR) }),
      row({ session_id: 'small', input: 10, ts: iso(HOUR) }),
      row({ session_id: 'openai', provider: 'openai', input: 99999, ts: iso(HOUR) }),
      row({ session_id: 'after', input: 5000, ts: iso(0) }),
      row({ session_id: 'too-old', input: 5000, ts: iso(8 * HOUR) }),
    ];
    const limit: LimitEvent = {
      ts: iso(30 * MIN),
      host: 'h',
      source: 'claude-code',
      provider: 'anthropic',
      session_id: null,
      unit: null,
      status: 429,
      detail: 'limit',
    };
    const [ctx] = limitContexts([limit], rows, 5 * HOUR);
    expect(ctx.top.map((s) => s.session_id)).toEqual(['big', 'small']);
  });

  it('folds repeats of the same wall into their onset', () => {
    const e = (msAgo: number, detail = 'limit'): LimitEvent => ({
      ts: iso(msAgo),
      host: 'h',
      source: 'claude-code',
      provider: 'anthropic',
      session_id: null,
      unit: null,
      status: null,
      detail,
    });
    const out = collapseLimitEvents([
      e(4 * HOUR),
      e(3.9 * HOUR),
      e(3.8 * HOUR, 'other'),
      e(3.7 * HOUR),
      e(HOUR),
    ]);
    expect(out.map((x) => [x.ts, x.count])).toEqual([
      [iso(4 * HOUR), 3],
      [iso(3.8 * HOUR), 1],
      [iso(HOUR), 1],
    ]);
  });
});

describe('host session (#769 fix at the source)', () => {
  it('picks the transcript with the pending `ai-dossier run` call among concurrent subagents', () => {
    const projectsDir = claudeFixture(tmpDir());
    expect(findClaudeTranscript(projectsDir, SESSION)).not.toBeNull();
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION };
    // main (fable last) and subagent (sonnet) are equally recent and disagree → null, not a guess
    expect(detectHostSession({ env, claudeProjectsDir: projectsDir })).toEqual({
      agent: 'claude-code',
      session_id: SESSION,
      model: null,
    });
    // the subagent issues `ai-dossier run …` and its tool_result is not written yet → it is the caller
    const sub = path.join(
      projectsDir,
      '-home-u-projects-ai-dossier',
      SESSION,
      'subagents',
      'agent-abc123.jsonl'
    );
    const call = assistant({
      ts: iso(MIN),
      id: 's2',
      session: SESSION,
      agentId: 'abc123',
      model: 'claude-sonnet-5',
    });
    (call.message as { content: unknown }).content = [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ai-dossier run imboard-ai/git/x' },
      },
    ];
    fs.appendFileSync(sub, `${JSON.stringify(call)}\n`);
    fs.utimesSync(sub, NOW / 1000, NOW / 1000);
    expect(hasPendingDossierRun(sub)).toBe(true);
    expect(detectHostSession({ env, claudeProjectsDir: projectsDir }).model).toBe(
      'claude-sonnet-5'
    );
    // once answered, it is no longer pending
    fs.appendFileSync(
      sub,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } })}\n`
    );
    expect(hasPendingDossierRun(sub)).toBe(false);
  });

  it('prefers the nearest host ancestor when both host markers are inherited', () => {
    const selfDepth = ancestorDepth(String(process.pid));
    expect(selfDepth === 0 || selfDepth === Number.MAX_SAFE_INTEGER).toBe(true);
    expect(ancestorDepth(undefined)).toBe(Number.MAX_SAFE_INTEGER);
    if (fs.existsSync('/proc/self/stat')) {
      expect(ancestorDepth(String(process.ppid))).toBe(1);
      // a pid that is not our ancestor → the marker was inherited from an unrelated host
      expect(ancestorDepth('999999999')).toBeNull();
      const host = detectHostSession({
        env: {
          CLAUDECODE: '1',
          CLAUDE_CODE_SESSION_ID: SESSION,
          CLAUDE_PID: '999999999',
          OPENCODE: '1',
          OPENCODE_PID: String(process.ppid),
        },
        opencodeDb: path.join(tmpDir(), 'none.db'),
      });
      expect(host.agent).toBe('opencode');
    }
  });

  it('skips synthetic models and returns nulls outside an agent host', () => {
    const file = write(path.join(tmpDir(), 't.jsonl'), [
      assistant({ ts: iso(MIN), id: 'x', session: SESSION, model: 'claude-opus-5-5' }),
      { type: 'assistant', message: { model: '<synthetic>' } },
    ]);
    expect(lastAssistantModel(file)).toBe('claude-opus-5-5');
    expect(detectHostSession({ env: {} })).toEqual({ agent: null, session_id: null, model: null });
    expect(
      detectHostSession({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '../evil' } })
    ).toEqual({
      agent: 'claude-code',
      session_id: null,
      model: null,
    });
  });
});

describe('reports', () => {
  function paths(root: string): LedgerPaths {
    const schedRoot = path.join(root, 'sched');
    const runs = path.join(schedRoot, 'proj', 'runs');
    write(path.join(runs, 'batch-b1-m1-4360.log'), [
      { type: 'sched-dispatch', cmd: ['opencode', 'run', '-m', 'openai/gpt-5.6-luna', '--'] },
      { type: 'step_start', sessionID: 'ses_member' },
    ]);
    return {
      claudeProjectsDir: claudeFixture(root),
      opencodeDb: path.join(root, 'unused.db'),
      schedRoot,
      runsLog: path.join(root, 'runs.jsonl'),
    };
  }
  const openOpenCode = () => ({
    status: 'ok' as const,
    reader: fakeOpenCode(
      [{ id: 'ses_member', parent_id: null, directory: '/w', title: 'member' }],
      {
        ses_member: [
          ocMessage(
            'm',
            40 * MIN,
            ocAssistant(40 * MIN, { input: 50, output: 5, cache: { read: 500 } })
          ),
        ],
      }
    ),
  });

  it('window report attributes >= 95% of tokens to a concrete model and renders every section', () => {
    const report = buildWindowReport(
      { last: '5h' },
      { paths: paths(tmpDir()), nowMs: NOW, host: 'h1', openOpenCode }
    );
    expect(report.model_coverage).toBeGreaterThanOrEqual(0.95);
    expect(report.by_model.map((g) => g.model)).toContain('openai/gpt-5.6-luna');
    expect(report.top_sessions.find((s) => s.session_id === 'ses_member')).toMatchObject({
      issue: 4360,
      batch: 'b1',
    });
    expect(report.limits).toHaveLength(1);
    const text = renderWindowReport(report);
    for (const heading of [
      'By model × source',
      'By project × issue',
      'Top sessions',
      'Burn by hour',
      'Limit events',
    ]) {
      expect(text).toContain(heading);
    }
    const anthropicOnly = buildWindowReport(
      { last: '5h', provider: 'anthropic' },
      { paths: paths(tmpDir()), nowMs: NOW, host: 'h1', openOpenCode }
    );
    expect(anthropicOnly.by_model.every((g) => g.provider === 'anthropic')).toBe(true);
  });

  it('--batch report lists the real model per member session', () => {
    const report = buildScopeReport(
      { batch: 'b1', since: '1d' },
      { paths: paths(tmpDir()), nowMs: NOW, openOpenCode }
    );
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      session_id: 'ses_member',
      models: ['openai/gpt-5.6-luna'],
    });
    expect(renderScopeReport(report)).toContain('openai/gpt-5.6-luna');

    const byIssue = buildScopeReport(
      { issue: '769', since: '1d' },
      { paths: paths(tmpDir()), nowMs: NOW, openOpenCode }
    );
    expect(byIssue.sessions.every((s) => s.issue === 769)).toBe(true);
    expect(byIssue.sessions.length).toBeGreaterThan(0);
  });
});
