import type { Command } from 'commander';
import { readStdin } from '../helpers';
import * as hooks from '../hooks';
import { getClient } from '../registry-client';

export function registerPromptHookCommand(program: Command): void {
  program
    .command('prompt-hook', { hidden: true })
    .description('Process a Claude Code hook event (internal)')
    .action(async () => {
      try {
        const raw = await readStdin(3000);
        if (!raw) process.exit(0);

        let payload: { prompt?: string };
        try {
          payload = JSON.parse(raw);
        } catch {
          process.exit(0);
          return;
        }

        const prompt = payload.prompt || '';
        if (!hooks.matchesHookPattern(prompt)) {
          process.exit(0);
        }

        let dossiers = hooks.getCachedDossierList();

        if (!dossiers) {
          const client = getClient();

          dossiers = [];
          let page = 1;
          const perPage = 100;

          while (true) {
            const result = await client.listDossiers({ page, perPage });
            const items = result.dossiers || result.data || [];
            for (const d of items) {
              dossiers.push({ name: d.name, title: d.title || d.name });
            }
            if (items.length < perPage) break;
            page++;
          }

          hooks.saveDossierListCache(dossiers);
        }

        if (dossiers.length === 0) {
          process.exit(0);
        }

        dossiers.sort((a, b) => a.name.localeCompare(b.name));
        const display = dossiers.slice(0, 15);

        const lines = ['## Available Dossier Workflows', ''];
        lines.push('Consider using one of these dossiers for your task:');
        for (const d of display) {
          lines.push(`- **${d.name}**: ${d.title}`);
        }
        if (dossiers.length > 15) {
          lines.push(`- ... and ${dossiers.length - 15} more (run \`dossier list\` to see all)`);
        }
        lines.push('');
        lines.push('Use `dossier run <name>` to execute a workflow.');

        console.log(lines.join('\n'));
      } catch {
        process.exit(0);
      }
    });
}
