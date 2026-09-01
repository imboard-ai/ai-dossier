/**
 * ai-dossier history — show persistent run log
 */

import type { Command } from 'commander';
import { formatCost, formatTokenPair as formatTokens } from '../cost-format';
import { formatDurationMs } from '../duration';
import { clearRunLog, readRunLog } from '../run-log';
import { renderTable } from '../table';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Show dossier run history')
    .option('--limit <n>', 'Number of entries to show', '20')
    .option('--dossier <name>', 'Filter by dossier name')
    .option('--json', 'Output as JSON')
    .option('--clear', 'Clear run history')
    .option('--yes', 'Skip confirmation for --clear')
    .action(
      async (options: {
        limit?: string;
        dossier?: string;
        json?: boolean;
        clear?: boolean;
        yes?: boolean;
      }) => {
        if (options.clear) {
          if (!options.yes) {
            console.error('Use --yes to confirm clearing run history');
            process.exit(1);
            return;
          }
          clearRunLog();
          console.log('Run history cleared.');
          process.exit(0);
          return;
        }

        const limit = Number.parseInt(options.limit || '20', 10);
        const entries = readRunLog({ limit, dossier: options.dossier });

        if (entries.length === 0) {
          console.log('No run history found.');
          process.exit(0);
        }

        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          process.exit(0);
        }

        // Table output — columns auto-size to the widest cell, so long token
        // counts widen the column instead of being silently truncated.
        const headers = [
          'TIMESTAMP',
          'DOSSIER',
          'VERSION',
          'SOURCE',
          'VERIFIED',
          'DURATION',
          'TOKENS(in/out)',
          'COST',
        ];
        const rows = entries.map((entry) => [
          entry.timestamp
            .replace('T', ' ')
            .replace(/\.\d+Z$/, '')
            .slice(0, 19),
          entry.dossier,
          entry.resolved_version,
          entry.source,
          entry.verification,
          formatDurationMs(entry.duration_ms),
          formatTokens(entry.input_tokens, entry.output_tokens),
          formatCost(entry.total_cost_usd),
        ]);

        console.log(renderTable(headers, rows, { separator: true }));

        // Deprecated pre-#401 field: surface it after the table rather than
        // interleaving, keyed by the row's timestamp.
        for (const entry of entries) {
          if (entry.update_available) {
            console.log(`  ↑ ${entry.timestamp}: update available: ${entry.update_available}`);
          }
        }

        process.exit(0);
      }
    );
}
