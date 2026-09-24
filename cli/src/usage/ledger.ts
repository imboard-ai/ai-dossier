/**
 * Ledger assembly + aggregation for `ai-dossier usage` (#769).
 *
 * `collectLedger` runs every collector for a time range and joins the
 * attribution sources; the pure functions below turn rows into the views'
 * numbers (so they are unit-testable without any store on disk).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { runsLogPath } from '@ai-dossier/core';
import { collectClaude, defaultClaudeProjectsDir } from './collect-claude';
import {
  applyDispatchIndex,
  collectSchedLimitEvents,
  countDossierRuns,
  indexDispatchLogs,
} from './collect-dispatch';
import {
  collectOpenCode,
  defaultOpenCodeDbPath,
  type OpenCodeOpenResult,
  openOpenCodeDb,
} from './collect-opencode';
import type { CollectorStatus, Ledger, LimitEvent, UsageRow } from './types';

/** Where each store lives — defaults resolve from the environment; tests point them at fixtures. */
export interface LedgerPaths {
  claudeProjectsDir: string;
  opencodeDb: string;
  schedRoot: string;
  runsLog: string;
}

export function defaultLedgerPaths(env: NodeJS.ProcessEnv = process.env): LedgerPaths {
  return {
    claudeProjectsDir: defaultClaudeProjectsDir(env),
    opencodeDb: defaultOpenCodeDbPath(env),
    schedRoot: path.join(os.homedir(), '.dossier', 'sched'),
    runsLog: runsLogPath(),
  };
}

export interface CollectOptions {
  sinceMs: number;
  untilMs: number;
  paths: LedgerPaths;
  host?: string;
  /** Override how opencode.db is opened (tests). */
  openOpenCode?: (dbFile: string) => OpenCodeOpenResult;
}

/** Run every collector for `[sinceMs, untilMs)` and join attribution. Read-only; never throws for a missing store. */
export function collectLedger(opts: CollectOptions): Ledger {
  const host = opts.host ?? os.hostname();
  const collectors: CollectorStatus[] = [];
  const rows: UsageRow[] = [];
  const limits: LimitEvent[] = [];

  const claude = collectClaude({
    projectsDir: opts.paths.claudeProjectsDir,
    sinceMs: opts.sinceMs,
    untilMs: opts.untilMs,
    host,
  });
  rows.push(...claude.rows);
  limits.push(...claude.limits);
  collectors.push({
    source: 'claude-code',
    status: 'ok',
    rows: claude.rows.length,
    detail: `${claude.files} transcript(s) under ${opts.paths.claudeProjectsDir}`,
  });

  const opened = (opts.openOpenCode ?? openOpenCodeDb)(opts.paths.opencodeDb);
  if (opened.status === 'ok') {
    try {
      const oc = collectOpenCode({
        reader: opened.reader,
        sinceMs: opts.sinceMs,
        untilMs: opts.untilMs,
        host,
      });
      rows.push(...oc);
      collectors.push({ source: 'opencode', status: 'ok', rows: oc.length });
    } catch (err) {
      collectors.push({
        source: 'opencode',
        status: 'error',
        rows: 0,
        detail: (err as Error).message,
      });
    } finally {
      opened.reader.close();
    }
  } else {
    collectors.push({ source: 'opencode', status: opened.status, rows: 0, detail: opened.detail });
  }

  const index = indexDispatchLogs(opts.paths.schedRoot, opts.sinceMs);
  applyDispatchIndex(rows, index);
  collectors.push({ source: 'sched-dispatch-logs', status: 'ok', rows: index.size });

  limits.push(...collectSchedLimitEvents(opts.paths.schedRoot, opts.sinceMs, opts.untilMs, host));
  limits.sort((a, b) => a.ts.localeCompare(b.ts));

  const dossierRuns = countDossierRuns(opts.paths.runsLog, opts.sinceMs, opts.untilMs);
  collectors.push({ source: 'dossier-runs', status: 'ok', rows: dossierRuns.size });

  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  return { rows, limits, collectors, dossierRuns };
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  /** Sum of every token class. */
  total: number;
  /** Sum of recorded costs; null when no row recorded one. */
  cost_usd: number | null;
  messages: number;
}

export function rowTotal(row: UsageRow): number {
  return row.input + row.output + row.reasoning + row.cache_read + row.cache_write;
}

export function totalsOf(rows: readonly UsageRow[]): TokenTotals {
  const t: TokenTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
    cost_usd: null,
    messages: rows.length,
  };
  for (const row of rows) {
    t.input += row.input;
    t.output += row.output;
    t.reasoning += row.reasoning;
    t.cache_read += row.cache_read;
    t.cache_write += row.cache_write;
    t.total += rowTotal(row);
    if (row.cost_usd !== null) t.cost_usd = (t.cost_usd ?? 0) + row.cost_usd;
  }
  return t;
}

export interface GroupTotals extends TokenTotals {
  key: string;
}

/** Group rows by `keyOf`, largest total first. */
export function groupRows(
  rows: readonly UsageRow[],
  keyOf: (row: UsageRow) => string
): GroupTotals[] {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...totalsOf(list) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/** Share of tokens (0..1) attributed to a concrete model id; 1 for an empty set. */
export function modelCoverage(rows: readonly UsageRow[]): number {
  let all = 0;
  let known = 0;
  for (const row of rows) {
    const n = rowTotal(row);
    all += n;
    if (row.model) known += n;
  }
  return all === 0 ? 1 : known / all;
}

export interface SessionSummary extends TokenTotals {
  session_id: string;
  parent_session_id: string | null;
  source: string;
  models: string[];
  project: string | null;
  issue: number | null;
  batch: string | null;
  unit: string | null;
  title: string | null;
  first_ts: string;
  last_ts: string;
}

/** Per-session totals, largest first. */
export function summarizeSessions(rows: readonly UsageRow[]): SessionSummary[] {
  const bySession = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id);
    if (list) list.push(row);
    else bySession.set(row.session_id, [row]);
  }
  const out: SessionSummary[] = [];
  for (const [session_id, list] of bySession) {
    const first = list[0];
    const models = [...new Set(list.map((r) => r.model).filter((m): m is string => !!m))].sort();
    const withIssue = list.find((r) => r.issue !== null);
    out.push({
      session_id,
      parent_session_id: first.parent_session_id,
      source: first.source,
      models,
      project: first.project,
      issue: withIssue?.issue ?? null,
      batch: list.find((r) => r.batch)?.batch ?? null,
      unit: list.find((r) => r.unit)?.unit ?? null,
      title: first.title,
      first_ts: list.reduce((m, r) => (r.ts < m ? r.ts : m), first.ts),
      last_ts: list.reduce((m, r) => (r.ts > m ? r.ts : m), first.ts),
      ...totalsOf(list),
    });
  }
  return out.sort((a, b) => b.total - a.total || a.session_id.localeCompare(b.session_id));
}

/** Tokens per clock hour across `[sinceMs, untilMs)`, oldest first — the burn-rate series. */
export function hourlyBurn(
  rows: readonly UsageRow[],
  sinceMs: number,
  untilMs: number
): { hour: string; total: number; messages: number }[] {
  const HOUR = 3_600_000;
  const start = Math.floor(sinceMs / HOUR) * HOUR;
  const buckets = new Map<number, { total: number; messages: number }>();
  for (let h = start; h < untilMs; h += HOUR) buckets.set(h, { total: 0, messages: 0 });
  for (const row of rows) {
    const h = Math.floor(Date.parse(row.ts) / HOUR) * HOUR;
    const bucket = buckets.get(h);
    if (!bucket) continue;
    bucket.total += rowTotal(row);
    bucket.messages += 1;
  }
  return [...buckets.entries()].map(([h, b]) => ({ hour: new Date(h).toISOString(), ...b }));
}

/** Repeats closer than this fold into one limit event (agents/cron retry a wall every few minutes). */
export const LIMIT_REPEAT_GAP_MS = 60 * 60 * 1000;

/**
 * Fold repeats of the same wall (same source, unit and message) into their
 * first occurrence — `count`/`last_ts` record what was folded. A wall hit by a
 * cron every 15 minutes is one event, not twenty; its onset is what needs
 * explaining. Input must be sorted by `ts`.
 */
export function collapseLimitEvents(
  events: readonly LimitEvent[],
  gapMs = LIMIT_REPEAT_GAP_MS
): LimitEvent[] {
  const open = new Map<string, LimitEvent>();
  const out: LimitEvent[] = [];
  for (const event of events) {
    const key = `${event.source}\u0000${event.unit ?? ''}\u0000${event.detail}`;
    const current = open.get(key);
    const lastMs = current ? Date.parse(current.last_ts ?? current.ts) : Number.NaN;
    if (current && Date.parse(event.ts) - lastMs <= gapMs) {
      current.count = (current.count ?? 1) + 1;
      current.last_ts = event.ts;
      continue;
    }
    const fresh = { ...event, count: 1, last_ts: event.ts };
    open.set(key, fresh);
    out.push(fresh);
  }
  return out;
}

export interface LimitContext {
  event: LimitEvent;
  /** Top consumers (by session) in the window that ended at the event. */
  top: SessionSummary[];
  window_ms: number;
}

/** For each limit event, the top `n` sessions by tokens in the `windowMs` before it. */
export function limitContexts(
  limits: readonly LimitEvent[],
  rows: readonly UsageRow[],
  windowMs: number,
  n = 3
): LimitContext[] {
  return limits.map((event) => {
    const end = Date.parse(event.ts);
    const start = end - windowMs;
    const inWindow = rows.filter((r) => {
      const t = Date.parse(r.ts);
      if (t < start || t > end) return false;
      // Claude limit events can only be explained by Anthropic spend.
      return event.provider === null || r.provider === event.provider;
    });
    return { event, top: summarizeSessions(inWindow).slice(0, n), window_ms: windowMs };
  });
}
