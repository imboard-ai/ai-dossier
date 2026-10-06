/**
 * `ai-dossier usage` — cross-provider token ledger + quota-window RCA (#769).
 *
 *   ai-dossier usage window [--last 5h] [--provider anthropic]   what ate my window?
 *   ai-dossier usage --batch <id> | --issue <n>                  real model per member
 *   ai-dossier usage watch [--last 1h] [--interval 30s]          live re-render
 *
 * Every view reads the source stores on demand (Claude Code transcripts,
 * opencode.db, sched dispatch logs/events, runs.jsonl) — read-only and
 * idempotent. Multi-host (#782): `usage sync` persists this host's rows under
 * ~/.dossier/usage and exchanges them with other hosts over ssh; the views take
 * `--hosts all|<a,b>` to read the merged ledger.
 *
 *   ai-dossier usage sync [--hosts host-b,host-c]     refresh + exchange with hosts
 *   ai-dossier usage export [--all] [--out f]    this host's bundle (JSONL)
 *   ai-dossier usage import <file|->             merge another host's bundle
 *   ai-dossier usage hosts                       what the merged ledger holds
 */

import * as fs from 'node:fs';
import type { Command } from 'commander';
import { formatCost } from '../cost-format';
import { fail } from '../helpers';
import { renderTable } from '../table';
import {
  type CollectOptions,
  collapseLimitEvents,
  collectLedger,
  defaultLedgerPaths,
  type GroupTotals,
  groupRows,
  hourlyBurn,
  type LedgerPaths,
  limitContexts,
  modelCoverage,
  type SessionSummary,
  summarizeSessions,
  totalsOf,
} from '../usage/ledger';
import {
  buildBundle,
  hostFile,
  importBundle,
  isValidHostId,
  listHosts,
  localHostId,
  mergedView,
  readHostFile,
  usageStoreDir,
} from '../usage/store';
import { refreshLocal, type SshRunner, syncWithRemotes } from '../usage/sync';

/** Test seam: replace the ssh transport used by `usage sync --hosts`. */
export const usageCommandDeps: { ssh?: SshRunner } = {};

import type { Ledger, UsageRow } from '../usage/types';

const MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** `90s` / `30m` / `5h` / `7d` / `2w` → milliseconds, or null when malformed. */
export function parseDurationSpec(spec: string): number | null {
  const match = spec.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!match) return null;
  const ms = Number.parseFloat(match[1]) * MS[match[2].toLowerCase()];
  return ms > 0 ? ms : null;
}

/** `--since` accepts a duration back from now (`30d`) or an absolute ISO date/time. */
export function parseSince(spec: string, nowMs: number): number | null {
  const duration = parseDurationSpec(spec);
  if (duration !== null) return nowMs - duration;
  const abs = Date.parse(spec);
  return Number.isNaN(abs) ? null : abs;
}

/** Compact token count: 950 · 12.3k · 4.5M · 1.2B. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`;
}

function shortSession(id: string): string {
  // Claude subagent ids are `<uuid>/<agentId>` — keep both halves recognisable.
  const [head, sub] = id.split('/');
  const h = head.length > 12 ? head.slice(0, 12) : head;
  return sub ? `${h}…/${sub.slice(0, 10)}` : h;
}

function clip(text: string | null, max: number): string {
  if (!text) return '-';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface FilterOptions {
  provider?: string;
  source?: string;
  /** `all` | `local` | comma-separated host ids — read the merged persisted ledger (#782). */
  hosts?: string;
}

/** `--hosts` → host selection: undefined = live local only (legacy), null = every host, else the listed hosts. */
function parseHostsOption(
  spec: string | undefined,
  local: string
): readonly string[] | null | undefined {
  if (spec === undefined) return undefined;
  const list = spec
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (list.length === 0) fail([`--hosts needs 'all', 'local', or host ids (got '${spec}')`]);
  if (list.includes('all')) return null;
  const hosts = list.map((h) => (h === 'local' ? local : h));
  for (const h of hosts) if (!isValidHostId(h)) fail([`--hosts: invalid host id '${h}'`]);
  return hosts;
}

/** Live local collection, unioned with the persisted multi-host ledger when `--hosts` is given. */
function collectForReport(
  opts: FilterOptions,
  sinceMs: number,
  untilMs: number,
  deps: WindowDeps
): Ledger & { hosts: string[] } {
  const local = deps.host ?? localHostId();
  const ledger = collectLedger({
    sinceMs,
    untilMs,
    paths: deps.paths ?? defaultLedgerPaths(),
    host: local,
    openOpenCode: deps.openOpenCode,
  });
  const selection = parseHostsOption(opts.hosts, local);
  if (selection === undefined) return { ...ledger, hosts: [local] };
  const merged = mergedView(
    deps.storeDir ?? usageStoreDir(),
    local,
    ledger,
    selection,
    sinceMs,
    untilMs
  );
  return { ...ledger, rows: merged.rows, limits: merged.limits, hosts: merged.hosts };
}

const HOST_SORT = (a: GroupTotals, b: GroupTotals) =>
  b.total - a.total || a.key.localeCompare(b.key);

function filterRows(rows: readonly UsageRow[], f: FilterOptions): UsageRow[] {
  const provider = f.provider?.toLowerCase();
  const sources = f.source
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return rows.filter(
    (r) =>
      (!provider || r.provider.toLowerCase() === provider) &&
      (!sources || sources.length === 0 || sources.includes(r.source))
  );
}

function tokenCells(t: GroupTotals | SessionSummary | ReturnType<typeof totalsOf>): string[] {
  return [
    String(t.messages),
    formatTokens(t.input),
    formatTokens(t.output),
    formatTokens(t.reasoning),
    formatTokens(t.cache_read),
    formatTokens(t.cache_write),
    formatTokens(t.total),
  ];
}
const TOKEN_HEADERS = ['Msgs', 'In', 'Out', 'Reason', 'Cache-R', 'Cache-W', 'Total'];
const TOKEN_ALIGN = Array(TOKEN_HEADERS.length).fill('right') as 'right'[];

// ---------------------------------------------------------------------------
// window view
// ---------------------------------------------------------------------------

export interface WindowOptions extends FilterOptions {
  last?: string;
  until?: string;
  top?: string;
  limitWindow?: string;
  json?: boolean;
}

export interface WindowDeps {
  paths?: LedgerPaths;
  nowMs?: number;
  host?: string;
  /** Persisted-ledger directory (tests); default `~/.dossier/usage`. */
  storeDir?: string;
  openOpenCode?: CollectOptions['openOpenCode'];
}

export interface WindowReport {
  since: string;
  until: string;
  host: string;
  /** Hosts whose rows the report covers (#782). */
  hosts: string[];
  by_host: GroupTotals[];
  collectors: Ledger['collectors'];
  model_coverage: number;
  totals: ReturnType<typeof totalsOf>;
  by_model: (GroupTotals & { provider: string; model: string | null; source: string })[];
  by_project_issue: GroupTotals[];
  top_sessions: (SessionSummary & { dossier_runs: number })[];
  hourly: ReturnType<typeof hourlyBurn>;
  burn_per_hour: number;
  limits: ReturnType<typeof limitContexts>;
}

/** Build the quota-window RCA report (pure over the collected ledger). */
export function buildWindowReport(opts: WindowOptions, deps: WindowDeps = {}): WindowReport {
  const nowMs = deps.nowMs ?? Date.now();
  const lastMs = parseDurationSpec(opts.last ?? '5h');
  if (lastMs === null) fail([`--last must be a duration like 5h, 30m, 7d (got '${opts.last}')`]);
  const untilMs = opts.until ? Date.parse(opts.until) : nowMs;
  if (Number.isNaN(untilMs)) fail([`--until must be an ISO date/time (got '${opts.until}')`]);
  const sinceMs = untilMs - lastMs;
  const limitWindowMs = parseDurationSpec(opts.limitWindow ?? '5h');
  if (limitWindowMs === null)
    fail([`--limit-window must be a duration (got '${opts.limitWindow}')`]);
  const top = Number.parseInt(opts.top ?? '10', 10);

  // Collect back far enough that a limit hit early in the window still has
  // its full preceding window of consumers.
  const ledger = collectForReport(opts, sinceMs - limitWindowMs, untilMs, deps);
  const allRows = filterRows(ledger.rows, opts);
  const rows = allRows.filter((r) => Date.parse(r.ts) >= sinceMs);
  const limits = collapseLimitEvents(
    ledger.limits.filter((l) => {
      const t = Date.parse(l.ts);
      if (t < sinceMs || t >= untilMs) return false;
      return !opts.provider || l.provider === null || l.provider === opts.provider.toLowerCase();
    })
  );

  const byModel = groupRows(
    rows,
    (r) => `${r.provider}\u0000${r.model ?? ''}\u0000${r.source}`
  ).map((g) => {
    const [provider, model, source] = g.key.split('\u0000');
    return { ...g, provider, model: model || null, source };
  });
  const sessions = summarizeSessions(rows)
    .slice(0, top)
    .map((s) => ({ ...s, dossier_runs: ledger.dossierRuns.get(s.session_id) ?? 0 }));
  const totals = totalsOf(rows);

  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    host: deps.host ?? localHostId(),
    hosts: ledger.hosts,
    by_host: groupRows(rows, (r) => r.host).sort(HOST_SORT),
    collectors: ledger.collectors,
    model_coverage: modelCoverage(rows),
    totals,
    by_model: byModel,
    by_project_issue: groupRows(
      rows,
      (r) => `${r.project ?? '-'} ${r.issue !== null ? `#${r.issue}` : '(no issue)'}`
    ),
    top_sessions: sessions,
    hourly: hourlyBurn(rows, sinceMs, untilMs),
    burn_per_hour: totals.total / (lastMs / MS.h),
    limits: limitContexts(limits, allRows, limitWindowMs),
  };
}

export function renderWindowReport(report: WindowReport): string {
  const out: string[] = [];
  const t = report.totals;
  out.push(
    `Usage window ${report.since} → ${report.until}  [${report.hosts.length > 1 ? `hosts ${report.hosts.join(', ')}` : `host ${report.host}`}]`
  );
  out.push(
    `Collectors: ${report.collectors.map((c) => `${c.source}=${c.status === 'ok' ? c.rows : c.status}`).join('  ')}`
  );
  for (const c of report.collectors) {
    if (c.status !== 'ok')
      out.push(`  ⚠ ${c.source}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  out.push(
    `Total: ${formatTokens(t.total)} tokens in ${t.messages} messages · ${formatTokens(Math.round(report.burn_per_hour))}/h · model attributed: ${pct(report.model_coverage, 1)}${t.cost_usd ? ` · recorded cost ${formatCost(t.cost_usd)}` : ''}`
  );
  if (t.messages === 0) {
    out.push('\nNo usage recorded in this window.');
  } else {
    if (report.by_host.length > 1) {
      out.push('\nBy host:');
      out.push(
        renderTable(
          ['Host', ...TOKEN_HEADERS, 'Share'],
          report.by_host.map((g) => [g.key, ...tokenCells(g), pct(g.total, t.total)]),
          { align: ['left', ...TOKEN_ALIGN, 'right'], separator: true }
        )
      );
    }
    out.push('\nBy model × source:');
    out.push(
      renderTable(
        ['Provider', 'Model', 'Source', ...TOKEN_HEADERS, 'Share'],
        report.by_model.map((g) => [
          g.provider,
          g.model ?? '(unknown)',
          g.source,
          ...tokenCells(g),
          pct(g.total, t.total),
        ]),
        { align: ['left', 'left', 'left', ...TOKEN_ALIGN, 'right'], separator: true }
      )
    );
    out.push('\nBy project × issue:');
    out.push(
      renderTable(
        ['Project / issue', 'Msgs', 'Total', 'Share'],
        report.by_project_issue.map((g) => [
          g.key,
          String(g.messages),
          formatTokens(g.total),
          pct(g.total, t.total),
        ]),
        { align: ['left', 'right', 'right', 'right'], separator: true }
      )
    );
    out.push('\nTop sessions:');
    out.push(renderSessionTable(report.top_sessions, t.total));
    out.push('\nBurn by hour:');
    out.push(
      renderTable(
        ['Hour (UTC)', 'Msgs', 'Total'],
        report.hourly.map((h) => [
          `${h.hour.slice(0, 13).replace('T', ' ')}h`,
          String(h.messages),
          formatTokens(h.total),
        ]),
        { align: ['left', 'right', 'right'], separator: true }
      )
    );
  }
  if (report.limits.length > 0) {
    out.push('\nLimit events:');
    for (const ctx of report.limits) {
      const e = ctx.event;
      out.push(
        `  ⛔ ${e.ts} ${e.source}${e.provider ? `/${e.provider}` : ''}${e.status !== null ? ` ${e.status}` : ''}${e.unit ? ` ${e.unit}` : ''} — ${e.detail}${(e.count ?? 1) > 1 ? `  (×${e.count}, last ${e.last_ts})` : ''}`
      );
      if (ctx.top.length === 0) {
        out.push('     (no recorded consumers in the preceding window)');
      } else {
        out.push(`     top consumers in the preceding ${Math.round(ctx.window_ms / MS.h)}h:`);
        for (const s of ctx.top) {
          out.push(
            `       ${formatTokens(s.total).padStart(7)}  ${shortSession(s.session_id)}  ${s.source}  ${s.models.join(',') || '(unknown)'}  ${s.project ?? '-'}${s.issue !== null ? ` #${s.issue}` : ''}${s.title ? `  "${clip(s.title, 50)}"` : ''}`
          );
        }
      }
    }
  } else {
    out.push('\nLimit events: none recorded in this window.');
  }
  return out.join('\n');
}

function renderSessionTable(
  sessions: readonly (SessionSummary & { dossier_runs?: number })[],
  whole: number
): string {
  return renderTable(
    [
      'Session',
      'Source',
      'Model',
      'Project',
      'Issue',
      'Unit',
      'Title',
      ...TOKEN_HEADERS,
      'Share',
      'Runs',
    ],
    sessions.map((s) => [
      shortSession(s.session_id),
      s.source,
      s.models.join(',') || '(unknown)',
      s.project ?? '-',
      s.issue !== null ? `#${s.issue}` : '-',
      s.unit ?? '-',
      clip(s.title, 40),
      ...tokenCells(s),
      pct(s.total, whole),
      String(s.dossier_runs ?? 0),
    ]),
    {
      align: [
        'left',
        'left',
        'left',
        'left',
        'right',
        'left',
        'left',
        ...TOKEN_ALIGN,
        'right',
        'right',
      ],
      separator: true,
    }
  );
}

// ---------------------------------------------------------------------------
// --batch / --issue view
// ---------------------------------------------------------------------------

export interface ScopeOptions extends FilterOptions {
  batch?: string;
  issue?: string;
  since?: string;
  json?: boolean;
}

export interface ScopeReport {
  scope: { batch: string | null; issue: number | null };
  since: string;
  until: string;
  hosts: string[];
  by_host: GroupTotals[];
  collectors: Ledger['collectors'];
  model_coverage: number;
  totals: ReturnType<typeof totalsOf>;
  by_model: GroupTotals[];
  sessions: SessionSummary[];
}

export function buildScopeReport(opts: ScopeOptions, deps: WindowDeps = {}): ScopeReport {
  const nowMs = deps.nowMs ?? Date.now();
  const sinceMs = parseSince(opts.since ?? '30d', nowMs);
  if (sinceMs === null)
    fail([`--since must be a duration (30d) or ISO date (got '${opts.since}')`]);
  const issue = opts.issue !== undefined ? Number.parseInt(opts.issue, 10) : null;
  if (opts.issue !== undefined && (issue === null || Number.isNaN(issue))) {
    fail([`--issue must be an issue number (got '${opts.issue}')`]);
  }
  const ledger = collectForReport(opts, sinceMs, nowMs, deps);
  const rows = filterRows(ledger.rows, opts).filter(
    (r) => (!opts.batch || r.batch === opts.batch) && (issue === null || r.issue === issue)
  );
  return {
    scope: { batch: opts.batch ?? null, issue },
    since: new Date(sinceMs).toISOString(),
    until: new Date(nowMs).toISOString(),
    hosts: ledger.hosts,
    by_host: groupRows(rows, (r) => r.host).sort(HOST_SORT),
    collectors: ledger.collectors,
    model_coverage: modelCoverage(rows),
    totals: totalsOf(rows),
    by_model: groupRows(rows, (r) => r.model ?? '(unknown)'),
    sessions: summarizeSessions(rows),
  };
}

export function renderScopeReport(report: ScopeReport): string {
  const label = report.scope.batch
    ? `batch ${report.scope.batch}${report.scope.issue !== null ? ` issue #${report.scope.issue}` : ''}`
    : `issue #${report.scope.issue}`;
  const out: string[] = [`Usage for ${label} (${report.since} → ${report.until})`];
  for (const c of report.collectors) {
    if (c.status !== 'ok')
      out.push(`  ⚠ ${c.source}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (report.sessions.length === 0) {
    out.push(
      'No sessions attributed to it. Batch/dispatch attribution comes from sched dispatch logs; interactive sessions are matched by branch/worktree name.'
    );
    return out.join('\n');
  }
  const t = report.totals;
  out.push(
    `Total: ${formatTokens(t.total)} tokens · model attributed: ${pct(report.model_coverage, 1)}${t.cost_usd ? ` · recorded cost ${formatCost(t.cost_usd)}` : ''}`
  );
  if (report.by_host.length > 1) {
    out.push('\nBy host:');
    out.push(
      renderTable(
        ['Host', ...TOKEN_HEADERS, 'Share'],
        report.by_host.map((g) => [g.key, ...tokenCells(g), pct(g.total, t.total)]),
        { align: ['left', ...TOKEN_ALIGN, 'right'], separator: true }
      )
    );
  }
  out.push('\nSessions:');
  out.push(renderSessionTable(report.sessions, t.total));
  out.push('\nBy model:');
  out.push(
    renderTable(
      ['Model', ...TOKEN_HEADERS, 'Share'],
      report.by_model.map((g) => [g.key, ...tokenCells(g), pct(g.total, t.total)]),
      { align: ['left', ...TOKEN_ALIGN, 'right'], separator: true }
    )
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerUsageCommand(program: Command): void {
  const cmd = program
    .command('usage')
    .description(
      'Cross-provider token ledger (Claude Code, opencode, sched dispatches): quota-window RCA, per-batch/issue model attribution'
    )
    .option('--batch <id>', "Show a sched batch's sessions with the real model per member")
    .option('--issue <n>', 'Show every session attributed to an issue')
    .option(
      '--since <when>',
      'How far back --batch/--issue look: a duration or ISO date (default 30d)'
    )
    .option('--provider <name>', 'Only this provider (anthropic, openai, zai, …)')
    .option('--source <list>', 'Only these sources: claude-code,opencode')
    .option(
      '--hosts <list>',
      "Read the merged multi-host ledger: 'all', 'local', or host ids (a,b)"
    )
    .option('--json', 'Output JSON')
    .action((opts: ScopeOptions) => {
      if (!opts.batch && opts.issue === undefined) {
        cmd.outputHelp();
        return;
      }
      const report = buildScopeReport(opts);
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderScopeReport(report));
    });

  cmd
    .command('window')
    .description(
      'Quota-window RCA: tokens by model × source × project × issue, top sessions, burn rate, limit events'
    )
    .option('--last <duration>', 'Window length ending now (or at --until)', '5h')
    .option('--until <iso>', 'Window end (default: now)')
    .option('--provider <name>', 'Only this provider (anthropic, openai, zai, …)')
    .option('--source <list>', 'Only these sources: claude-code,opencode')
    .option('--top <n>', 'How many top sessions to list', '10')
    .option('--limit-window <duration>', 'Look-back used to explain each limit event', '5h')
    .option(
      '--hosts <list>',
      "Read the merged multi-host ledger: 'all', 'local', or host ids (a,b)"
    )
    .option('--json', 'Output JSON')
    .action((_opts: WindowOptions, command: Command) => {
      // optsWithGlobals: without positional options on the root program,
      // Commander hands `--json`/`--provider`/`--source` given after `window`
      // to the parent `usage` command (which defines the same flags).
      const opts = command.optsWithGlobals<WindowOptions>();
      const report = buildWindowReport(opts);
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderWindowReport(report));
    });

  cmd
    .command('watch')
    .description('Live view: re-render the window report on an interval (Ctrl-C to stop)')
    .option('--last <duration>', 'Window length', '1h')
    .option('--provider <name>', 'Only this provider')
    .option('--source <list>', 'Only these sources: claude-code,opencode')
    .option('--top <n>', 'How many top sessions to list', '10')
    .option(
      '--hosts <list>',
      "Read the merged multi-host ledger: 'all', 'local', or host ids (a,b)"
    )
    .option('--interval <duration>', 'Refresh interval', '30s')
    .option('--iterations <n>', 'Stop after this many renders (default: until interrupted)')
    .action(async (_opts: WindowOptions, command: Command) => {
      const opts = command.optsWithGlobals<
        WindowOptions & { interval?: string; iterations?: string }
      >();
      const intervalMs = parseDurationSpec(opts.interval ?? '30s');
      if (intervalMs === null) fail([`--interval must be a duration (got '${opts.interval}')`]);
      const max = opts.iterations ? Number.parseInt(opts.iterations, 10) : Number.POSITIVE_INFINITY;
      for (let i = 0; i < max; i++) {
        const report = buildWindowReport(opts);
        if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
        console.log(renderWindowReport(report));
        console.log(`\n(refreshing every ${opts.interval ?? '30s'} — Ctrl-C to stop)`);
        if (i + 1 < max) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    });

  registerLedgerCommands(cmd);
}

// ---------------------------------------------------------------------------
// persisted ledger + multi-host merge (#782)
// ---------------------------------------------------------------------------

function readStdin(): string {
  return fs.readFileSync(0, 'utf-8');
}

function sinceOrFail(spec: string | undefined, nowMs: number): number | undefined {
  if (spec === undefined) return undefined;
  const ms = parseSince(spec, nowMs);
  if (ms === null) fail([`--since must be a duration (30d) or ISO date (got '${spec}')`]);
  return ms;
}

function registerLedgerCommands(cmd: Command): void {
  cmd
    .command('sync')
    .description(
      "Refresh this host's persisted ledger (~/.dossier/usage); with --hosts, exchange it with those hosts over ssh (pull + push, idempotent)"
    )
    .option('--hosts <list>', 'Other hosts to exchange with over ssh (e.g. host-b,host-c)')
    .option(
      '--since <when>',
      'Re-collect / exchange from here (default: incremental cursor, first run 30d)'
    )
    .option('--no-push', 'Only pull remote rows')
    .option('--no-pull', 'Only push local rows')
    .option('--json', 'Output JSON')
    .action((_o, command: Command) => {
      const opts = command.optsWithGlobals<{
        hosts?: string;
        since?: string;
        push?: boolean;
        pull?: boolean;
        json?: boolean;
      }>();
      const nowMs = Date.now();
      const sinceMs = sinceOrFail(opts.since, nowMs);
      const local = refreshLocal({ nowMs }, sinceMs);
      const remoteHosts = (opts.hosts ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      const remotes = remoteHosts.length
        ? syncWithRemotes(
            { hosts: remoteHosts, sinceMs, push: opts.push, pull: opts.pull },
            { nowMs, ssh: usageCommandDeps.ssh }
          )
        : [];
      if (opts.json) {
        console.log(JSON.stringify({ local, remotes }, null, 2));
      } else {
        console.log(
          `local ${local.host}: collected ${local.collected} rows since ${local.since} (+${local.added} new, ${local.updated} refreshed records) — ledger holds ${local.total}`
        );
        for (const r of remotes) {
          if (!r.ok) {
            console.log(`  ${r.host}: FAILED — ${r.error}`);
            continue;
          }
          const p = r.pulled;
          console.log(
            `  ${r.host}: pulled ${p ? `${p.added} new / ${p.updated} refreshed / ${p.unchanged} unchanged (hosts: ${p.hosts.join(',') || '-'})` : 'skipped'}; pushed ${r.pushed_rows ?? 'skipped'} rows${r.push ? ` (+${r.push.added} new on ${r.host})` : ''}`
          );
        }
      }
      if (remotes.some((r) => !r.ok)) process.exitCode = 1;
    });

  cmd
    .command('export')
    .description("Write a JSONL bundle of this host's ledger (or --all hosts) to stdout or --out")
    .option('--all', 'Include every persisted host, not just this one (what sync pulls)')
    .option('--since <when>', 'Only rows at or after this (duration or ISO date)')
    .option('--no-refresh', 'Do not re-collect local stores first')
    .option('--out <file>', 'Write to a file instead of stdout')
    .action((_o, command: Command) => {
      const opts = command.optsWithGlobals<{
        all?: boolean;
        since?: string;
        refresh?: boolean;
        out?: string;
      }>();
      const nowMs = Date.now();
      const host = localHostId();
      if (opts.refresh !== false) refreshLocal({ nowMs });
      const bundle = buildBundle(
        usageStoreDir(),
        host,
        opts.all ? null : [host],
        sinceOrFail(opts.since, nowMs) ?? 0
      );
      if (opts.out) {
        fs.writeFileSync(opts.out, bundle.text);
        console.error(`exported ${bundle.rows} rows to ${opts.out}`);
      } else {
        process.stdout.write(bundle.text);
      }
    });

  cmd
    .command('import <file>')
    .description(
      "Merge another host's bundle (a file, or '-' for stdin) into the ledger — idempotent"
    )
    .option('--json', 'Output JSON')
    .action((file: string, _o, command: Command) => {
      const opts = command.optsWithGlobals<{ json?: boolean }>();
      let text: string;
      try {
        text = file === '-' ? readStdin() : fs.readFileSync(file, 'utf-8');
      } catch (err) {
        return fail([`cannot read ${file}: ${(err as Error).message}`]);
      }
      let result: ReturnType<typeof importBundle>;
      try {
        result = importBundle(usageStoreDir(), text, localHostId());
      } catch (err) {
        return fail([(err as Error).message]);
      }
      console.log(
        opts.json
          ? JSON.stringify(result)
          : `imported: +${result.added} new, ${result.updated} refreshed, ${result.unchanged} unchanged, ${result.skipped} skipped, ${result.ignored_local} ignored (own host) — hosts: ${result.hosts.join(', ') || '-'}`
      );
    });

  cmd
    .command('hosts')
    .description('List the hosts in the persisted ledger with row counts and time range')
    .option('--json', 'Output JSON')
    .action((_o, command: Command) => {
      const opts = command.optsWithGlobals<{ json?: boolean }>();
      const dir = usageStoreDir();
      const hosts = listHosts(dir).map((host) => {
        const d = readHostFile(hostFile(dir, host));
        const ts = [...d.rows.values()].map((r) => r.ts).sort();
        return {
          host,
          rows: d.rows.size,
          limits: d.limits.size,
          first: ts[0] ?? null,
          last: ts[ts.length - 1] ?? null,
          total_tokens: totalsOf([...d.rows.values()]).total,
        };
      });
      if (opts.json) {
        console.log(JSON.stringify({ local: localHostId(), dir, hosts }, null, 2));
        return;
      }
      console.log(`Persisted usage ledger: ${dir} (this host: ${localHostId()})`);
      console.log(
        hosts.length === 0
          ? 'No hosts yet — run `ai-dossier usage sync`.'
          : renderTable(
              ['Host', 'Rows', 'Tokens', 'First', 'Last'],
              hosts.map((h) => [
                h.host,
                String(h.rows),
                formatTokens(h.total_tokens),
                h.first?.slice(0, 16) ?? '-',
                h.last?.slice(0, 16) ?? '-',
              ]),
              { align: ['left', 'right', 'right', 'left', 'left'], separator: true }
            )
      );
    });
}
