/**
 * Persisted, mergeable usage ledger (#782).
 *
 * `ai-dossier usage` (#769) derives rows on demand from stores that rotate
 * (Claude Code transcripts are purged) and that live on one host. The store
 * persists them under `~/.dossier/usage/hosts/<host>.jsonl` — ONE FILE PER HOST,
 * so merging hosts can never conflict: a host's file is only rewritten from that
 * host's own collection, or from an import of that same host's bundle.
 *
 * Records are keyed by a stable content key ({@link rowKey}); re-collecting or
 * re-importing the same rows replaces them in place, so every operation is
 * idempotent. The wire format between hosts ("bundle") is the same JSONL.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LimitEvent, UsageRow } from './types';
import { forEachLine } from './util';

export const BUNDLE_VERSION = 1;

/** Root of the persisted ledger. */
export function usageStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOSSIER_USAGE_DIR || path.join(os.homedir(), '.dossier', 'usage');
}

/** This host's id in rows — `DOSSIER_USAGE_HOST` overrides `os.hostname()` (e.g. to force `wls`). */
export function localHostId(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOSSIER_USAGE_HOST || os.hostname();
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export function isValidHostId(host: string): boolean {
  return HOST_RE.test(host);
}

export function hostFile(dir: string, host: string): string {
  return path.join(dir, 'hosts', `${host}.jsonl`);
}

const sha = (parts: readonly (string | number | null)[]): string =>
  createHash('sha1')
    .update(parts.map((p) => (p === null ? '' : String(p))).join('\u0000'))
    .digest('hex')
    .slice(0, 20);

/**
 * Stable identity of a row: the message it was read from, not the attribution
 * later joined onto it (issue/batch/unit may be refined by a re-collection).
 */
export function rowKey(r: UsageRow): string {
  return sha([
    r.host,
    r.source,
    r.session_id,
    r.ts,
    r.model,
    r.input,
    r.output,
    r.reasoning,
    r.cache_read,
    r.cache_write,
  ]);
}

export function limitKey(l: LimitEvent): string {
  return sha([l.host, l.source, l.ts, l.session_id, l.unit, l.status, l.detail]);
}

/** One host's persisted records, keyed for upsert. */
export interface HostData {
  rows: Map<string, UsageRow>;
  limits: Map<string, LimitEvent>;
}

export function emptyHostData(): HostData {
  return { rows: new Map(), limits: new Map() };
}

type Line =
  | { k: 'row'; key: string; row: UsageRow }
  | { k: 'limit'; key: string; limit: LimitEvent }
  | { k: 'header'; version: number; host: string; exported_at: string };

function isRow(v: unknown): v is UsageRow {
  const r = v as UsageRow | null;
  return (
    !!r &&
    typeof r.ts === 'string' &&
    !Number.isNaN(Date.parse(r.ts)) &&
    typeof r.host === 'string' &&
    isValidHostId(r.host) &&
    typeof r.session_id === 'string' &&
    typeof r.source === 'string' &&
    typeof r.provider === 'string' &&
    [r.input, r.output, r.reasoning, r.cache_read, r.cache_write].every(
      (n) => typeof n === 'number' && Number.isFinite(n)
    )
  );
}

function isLimit(v: unknown): v is LimitEvent {
  const l = v as LimitEvent | null;
  return (
    !!l &&
    typeof l.ts === 'string' &&
    !Number.isNaN(Date.parse(l.ts)) &&
    typeof l.host === 'string' &&
    isValidHostId(l.host) &&
    typeof l.detail === 'string'
  );
}

/** Parse JSONL text/lines into per-host data. Foreign or malformed lines are counted, never thrown. */
export class Parser {
  readonly byHost = new Map<string, HostData>();
  skipped = 0;
  header: { version: number; host: string } | null = null;

  add(line: string): void {
    let rec: Line;
    try {
      rec = JSON.parse(line) as Line;
    } catch {
      this.skipped++;
      return;
    }
    if (rec.k === 'header') {
      this.header = { version: rec.version, host: rec.host };
      return;
    }
    if (rec.k === 'row' && isRow(rec.row)) {
      this.data(rec.row.host).rows.set(rowKey(rec.row), rec.row);
    } else if (rec.k === 'limit' && isLimit(rec.limit)) {
      this.data(rec.limit.host).limits.set(limitKey(rec.limit), rec.limit);
    } else {
      this.skipped++;
    }
  }

  private data(host: string): HostData {
    let d = this.byHost.get(host);
    if (!d) {
      d = emptyHostData();
      this.byHost.set(host, d);
    }
    return d;
  }
}

/** Read one host's file. A missing file is an empty ledger. */
export function readHostFile(file: string): HostData {
  const p = new Parser();
  forEachLine(file, (line) => p.add(line));
  return p.byHost.values().next().value ?? emptyHostData();
}

/** Hosts that have a persisted file. */
export function listHosts(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, 'hosts'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .filter(isValidHostId)
      .sort();
  } catch {
    return [];
  }
}

function serialize(data: HostData): string {
  const rows = [...data.rows.entries()].sort(
    (a, b) => a[1].ts.localeCompare(b[1].ts) || a[0].localeCompare(b[0])
  );
  const limits = [...data.limits.entries()].sort(
    (a, b) => a[1].ts.localeCompare(b[1].ts) || a[0].localeCompare(b[0])
  );
  const out: string[] = [];
  for (const [key, row] of rows) out.push(JSON.stringify({ k: 'row', key, row }));
  for (const [key, limit] of limits) out.push(JSON.stringify({ k: 'limit', key, limit }));
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Atomic rewrite (tmp + rename) so a concurrent reader never sees a torn file. */
export function writeHostFile(file: string, data: HostData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serialize(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface MergeStats {
  added: number;
  updated: number;
  unchanged: number;
}

/** Upsert `incoming` into `target` (incoming wins). */
export function mergeHostData(target: HostData, incoming: HostData): MergeStats {
  const stats: MergeStats = { added: 0, updated: 0, unchanged: 0 };
  const upsert = <T>(into: Map<string, T>, from: Map<string, T>) => {
    for (const [key, value] of from) {
      const prior = into.get(key);
      if (prior === undefined) stats.added++;
      else if (JSON.stringify(prior) === JSON.stringify(value)) stats.unchanged++;
      else stats.updated++;
      if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(value)) {
        into.set(key, value);
      }
    }
  };
  upsert(target.rows, incoming.rows);
  upsert(target.limits, incoming.limits);
  return stats;
}

/** Persist a fresh collection of THIS host's rows/limits into its file (idempotent). */
export function persistLocal(
  dir: string,
  host: string,
  rows: readonly UsageRow[],
  limits: readonly LimitEvent[]
): MergeStats & { total: number } {
  const file = hostFile(dir, host);
  const data = readHostFile(file);
  const fresh = emptyHostData();
  for (const r of rows) if (r.host === host) fresh.rows.set(rowKey(r), r);
  for (const l of limits) if (l.host === host) fresh.limits.set(limitKey(l), l);
  const stats = mergeHostData(data, fresh);
  if (stats.added > 0 || stats.updated > 0 || !fs.existsSync(file)) writeHostFile(file, data);
  return { ...stats, total: data.rows.size };
}

/** Newest persisted row time for a host, or null — the incremental-sync cursor. */
export function newestTs(dir: string, host: string): number | null {
  let max: number | null = null;
  for (const r of readHostFile(hostFile(dir, host)).rows.values()) {
    const t = Date.parse(r.ts);
    if (max === null || t > max) max = t;
  }
  return max;
}

/**
 * Bundle text: a header line then every record of the chosen hosts with
 * `ts >= sinceMs`. `hosts` null = every persisted host.
 */
export function buildBundle(
  dir: string,
  from: string,
  hosts: readonly string[] | null,
  sinceMs: number
): { text: string; rows: number } {
  const out: string[] = [
    JSON.stringify({
      k: 'header',
      version: BUNDLE_VERSION,
      host: from,
      exported_at: new Date().toISOString(),
    }),
  ];
  let rows = 0;
  for (const host of hosts ?? listHosts(dir)) {
    const data = readHostFile(hostFile(dir, host));
    for (const [key, row] of data.rows) {
      if (Date.parse(row.ts) < sinceMs) continue;
      out.push(JSON.stringify({ k: 'row', key, row }));
      rows++;
    }
    for (const [key, limit] of data.limits) {
      if (Date.parse(limit.ts) < sinceMs) continue;
      out.push(JSON.stringify({ k: 'limit', key, limit }));
    }
  }
  return { text: `${out.join('\n')}\n`, rows };
}

export interface ImportResult extends MergeStats {
  hosts: string[];
  skipped: number;
  /** Records claiming this host — ignored: a host's own files come only from its own collection. */
  ignored_local: number;
}

/**
 * Merge a bundle into the store, one file per source host. Records for
 * `localHost` are ignored (the local collection is authoritative, and it stops a
 * pushed bundle echoing our own rows back). Idempotent.
 */
export function importBundle(dir: string, text: string, localHost: string): ImportResult {
  const parser = new Parser();
  for (const line of text.split('\n')) if (line) parser.add(line);
  if (parser.header && parser.header.version > BUNDLE_VERSION) {
    throw new Error(
      `bundle version ${parser.header.version} is newer than this CLI understands (${BUNDLE_VERSION}) — upgrade @ai-dossier/cli`
    );
  }
  const result: ImportResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    hosts: [],
    skipped: parser.skipped,
    ignored_local: 0,
  };
  for (const [host, incoming] of parser.byHost) {
    if (host === localHost) {
      result.ignored_local += incoming.rows.size + incoming.limits.size;
      continue;
    }
    const file = hostFile(dir, host);
    const data = readHostFile(file);
    const stats = mergeHostData(data, incoming);
    if (stats.added > 0 || stats.updated > 0) writeHostFile(file, data);
    result.added += stats.added;
    result.updated += stats.updated;
    result.unchanged += stats.unchanged;
    result.hosts.push(host);
  }
  result.hosts.sort();
  return result;
}

/**
 * Rows/limits for a report: the fresh local collection unioned with everything
 * persisted (fresh wins per key), restricted to `hosts` (null = all).
 */
export function mergedView(
  dir: string,
  localHost: string,
  fresh: { rows: readonly UsageRow[]; limits: readonly LimitEvent[] },
  hosts: readonly string[] | null,
  sinceMs: number,
  untilMs: number
): { rows: UsageRow[]; limits: LimitEvent[]; hosts: string[] } {
  const inRange = (ts: string) => {
    const t = Date.parse(ts);
    return t >= sinceMs && t < untilMs;
  };
  const want = (h: string) => hosts === null || hosts.includes(h);
  const rows = new Map<string, UsageRow>();
  const limits = new Map<string, LimitEvent>();
  for (const h of listHosts(dir)) {
    if (!want(h)) continue;
    const d = readHostFile(hostFile(dir, h));
    for (const [k, r] of d.rows) if (inRange(r.ts)) rows.set(k, r);
    for (const [k, l] of d.limits) if (inRange(l.ts)) limits.set(k, l);
  }
  for (const r of fresh.rows) if (want(r.host) && inRange(r.ts)) rows.set(rowKey(r), r);
  for (const l of fresh.limits) if (want(l.host) && inRange(l.ts)) limits.set(limitKey(l), l);
  const outRows = [...rows.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const outLimits = [...limits.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const present = [...new Set([...outRows.map((r) => r.host), localHost])].sort();
  return { rows: outRows, limits: outLimits, hosts: present };
}
