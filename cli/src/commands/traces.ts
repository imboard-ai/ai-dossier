import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import { isExpired, loadCredentials } from '../credentials';
import {
  getClientForRegistry,
  type ListTracesResult,
  RegistryError,
  type TraceListItem,
} from '../registry-client';

interface ListOptions {
  status?: string;
  dossier?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
  org?: string;
  json?: boolean;
  registry?: string;
}

interface ShowOptions {
  org?: string;
  json?: boolean;
  registry?: string;
}

/** Registers the `traces` command tree (list, show). */
export function registerTracesCommand(program: Command): void {
  const tracesCmd = program
    .command('traces')
    .description('Inspect execution traces in the registry');

  tracesCmd
    .command('list')
    .description('List your execution traces (or org traces with --org)')
    .option('--status <status>', 'Filter: running, success, failed, cancelled')
    .option('--dossier <name>', 'Filter by dossier title')
    .option('--from <date>', 'Only traces started at or after this ISO date')
    .option('--to <date>', 'Only traces started at or before this ISO date')
    .option('--org <name>', 'Show traces from anyone in this org (must be a member)')
    .option('--limit <n>', 'Page size (max 200)', '50')
    .option('--offset <n>', 'Pagination offset', '0')
    .option('--registry <name>', 'Registry to query', 'public')
    .option('--json', 'Output raw JSON')
    .action(async (options: ListOptions) => {
      const client = mustGetAuthedClient(options.registry);

      let result: ListTracesResult;
      try {
        result = await client.listTraces({
          status: options.status,
          dossier: options.dossier,
          from: options.from,
          to: options.to,
          org: options.org,
          limit: options.limit ? Math.max(1, Number.parseInt(options.limit, 10)) : undefined,
          offset: options.offset ? Math.max(0, Number.parseInt(options.offset, 10)) : undefined,
        });
      } catch (err) {
        handleRegistryError(err);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.traces.length === 0) {
        const where = options.org ? ` for org '${options.org}'` : '';
        console.log(`\n  No traces found${where}.\n`);
        return;
      }

      printTracesTable(result.traces);
      const { total, offset, limit } = result.pagination;
      const shown = Math.min(limit, result.traces.length);
      console.log(
        `\n  ${shown} of ${total} traces  (offset ${offset}, limit ${limit})${
          result.pagination.next ? '  — more available' : ''
        }\n`
      );
    });

  tracesCmd
    .command('show')
    .description('Show a single execution trace with its steps')
    .argument('<trace_id>', 'Trace UUID')
    .option('--org <name>', "Read a teammate's trace via org membership")
    .option('--registry <name>', 'Registry to query', 'public')
    .option('--json', 'Output raw JSON')
    .action(async (traceId: string, options: ShowOptions) => {
      const client = mustGetAuthedClient(options.registry);

      let trace: Record<string, unknown>;
      try {
        trace = await client.getTrace(traceId, { org: options.org });
      } catch (err) {
        handleRegistryError(err);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(trace, null, 2));
        return;
      }

      printTraceDetail(trace);
    });
}

function mustGetAuthedClient(
  registryName: string | undefined
): ReturnType<typeof getClientForRegistry> {
  const name = registryName || 'public';
  const creds = loadCredentials(name);
  if (!creds) {
    console.error(`\n❌ Not logged in to registry '${name}'. Run \`ai-dossier login\` first.\n`);
    process.exit(1);
  }
  if (isExpired(creds)) {
    console.error(
      `\n❌ Credentials for '${name}' have expired. Run \`ai-dossier login\` to refresh.\n`
    );
    process.exit(1);
  }
  const registry = resolveRegistries().find((r) => r.name === name);
  if (!registry) {
    console.error(`\n❌ Registry '${name}' not configured.\n`);
    process.exit(1);
  }
  return getClientForRegistry(registry.url, creds.token);
}

function handleRegistryError(err: unknown): never {
  if (err instanceof RegistryError) {
    const codeStr = err.code ? ` [${err.code}]` : '';
    console.error(`\n❌ ${err.message}${codeStr}\n`);
  } else if (err instanceof Error) {
    console.error(`\n❌ ${err.message}\n`);
  } else {
    console.error('\n❌ Unknown error\n');
  }
  process.exit(1);
}

function printTracesTable(rows: TraceListItem[]): void {
  // Compute column widths
  const headers = ['STATUS', 'DOSSIER', 'STARTED', 'DURATION', 'TRACE_ID'];
  const data = rows.map((t) => [
    statusIcon(t.status),
    `${t.dossier.title}@${t.dossier.version}`,
    shortDate(t.started_at),
    durationLabel(t.duration_ms),
    t.trace_id.slice(0, 8),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));

  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n  ${fmt(headers)}`);
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of data) console.log(`  ${fmt(row)}`);
}

function printTraceDetail(trace: Record<string, unknown>): void {
  const dossier = trace.dossier as { title?: string; version?: string } | undefined;
  const agent = trace.agent as { name?: string; host?: string; version?: string } | undefined;
  const steps = Array.isArray(trace.steps) ? trace.steps : [];

  console.log(`\n  Trace ${trace.trace_id}`);
  if (dossier) console.log(`    Dossier:    ${dossier.title}@${dossier.version}`);
  if (agent) {
    const parts: string[] = [];
    if (agent.name) parts.push(agent.name);
    if (agent.version) parts.push(`v${agent.version}`);
    if (agent.host) parts.push(`(${agent.host})`);
    console.log(`    Agent:      ${parts.join(' ')}`);
  }
  console.log(`    Status:     ${statusIcon(trace.status as string)} ${trace.status}`);
  console.log(`    Started:    ${shortDate(trace.started_at as string)}`);
  if (trace.completed_at) console.log(`    Completed:  ${shortDate(trace.completed_at as string)}`);
  if (trace.duration_ms != null)
    console.log(`    Duration:   ${durationLabel(trace.duration_ms as number)}`);

  if (steps.length > 0) {
    console.log(`\n  Steps (${steps.length}):`);
    for (const step of steps as Array<Record<string, unknown>>) {
      const ts = step.timestamp ? shortDate(step.timestamp as string) : '';
      console.log(`    ${ts}  ${step.type ?? '?'}  ${step.step_id ?? ''}`);
    }
  }
  console.log('');
}

function statusIcon(status: string): string {
  switch (status) {
    case 'success':
      return 'OK   ';
    case 'failed':
      return 'FAIL ';
    case 'running':
      return '...  ';
    case 'cancelled':
      return 'X    ';
    default:
      return status.padEnd(5);
  }
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  // 2026-05-13T14:32:00Z → 2026-05-13 14:32
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function durationLabel(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}
