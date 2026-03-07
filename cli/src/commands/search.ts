import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import { loadCredentials } from '../credentials';
import {
  formatDossierFields,
  logPaginationInfo,
  parsePaginationParams,
  printRegistryErrors,
} from '../helpers';
import type { LabeledDossierListItem } from '../multi-registry';
import { multiRegistryList } from '../multi-registry';
import { getClientForRegistry } from '../registry-client';

/** Registers the `search` command — searches for dossiers across all configured registries. */
export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search for dossiers across all configured registries')
    .argument('<query>', 'Search keywords')
    .option(
      '--category <category>',
      'Filter by category (devops, database, development, security, etc.)'
    )
    .option('--page <number>', 'Page number', '1')
    .option('--per-page <number>', 'Results per page', '20')
    .option('--limit <number>', 'Maximum total results')
    .option('-c, --content', 'Also search dossier body content')
    .option('--json', 'Output as JSON')
    .action(
      async (
        query: string,
        options: {
          category?: string;
          page: string;
          perPage: string;
          limit?: string;
          json?: boolean;
          content?: boolean;
        }
      ) => {
        const { page, perPage } = parsePaginationParams(options.page, options.perPage);
        const limit = options.limit ? Math.max(1, parseInt(options.limit, 10) || 1) : undefined;

        let allDossiers: LabeledDossierListItem[];
        try {
          const result = await multiRegistryList({
            category: options.category,
            page: 1,
            perPage: 100,
          });

          if (result.errors.length > 0) {
            printRegistryErrors(result.errors, 'warning');
          }

          allDossiers = result.dossiers;
        } catch (err: unknown) {
          const registryNames = resolveRegistries()
            .map((r) => r.name)
            .join(', ');
          console.error(
            `\n❌ Search failed across registries [${registryNames}]: ${(err as Error).message}\n`
          );
          process.exit(1);
          return;
        }

        const queryLower = query.toLowerCase();
        const terms = queryLower.split(/\s+/).filter(Boolean);

        let matched = allDossiers.filter((d) => {
          const fields = [
            d.name || '',
            d.title || '',
            d.description || d.objective || '',
            ...(Array.isArray(d.category) ? d.category : [d.category || '']),
            ...(d.tags || []),
          ]
            .map((f) => String(f).toLowerCase())
            .join(' ');

          return terms.every((term) => fields.includes(term));
        });

        // Content search: fetch body and filter by content match
        let contentMatches: Map<string, string> | null = null;
        if (options.content) {
          const registries = resolveRegistries();
          const CONCURRENCY = 5;
          contentMatches = new Map();

          // Process in batches for concurrency limiting
          for (let i = 0; i < matched.length; i += CONCURRENCY) {
            const batch = matched.slice(i, i + CONCURRENCY);
            await Promise.all(
              batch.map(async (d) => {
                try {
                  const reg = registries.find((r) => r.name === d._registry) || registries[0];
                  const token = loadCredentials(reg.name)?.token || null;
                  const client = getClientForRegistry(reg.url, token);
                  const { content } = await client.getDossierContent(d.name, d.version || null);
                  const bodyLower = content.toLowerCase();
                  if (terms.some((term) => bodyLower.includes(term))) {
                    // Extract snippet around first match
                    const firstTerm = terms.find((t) => bodyLower.includes(t)) ?? terms[0];
                    const idx = bodyLower.indexOf(firstTerm);
                    const start = Math.max(0, idx - 50);
                    const end = Math.min(content.length, idx + firstTerm.length + 50);
                    const snippet =
                      (start > 0 ? '...' : '') +
                      content.slice(start, end).replace(/\n/g, ' ') +
                      (end < content.length ? '...' : '');
                    contentMatches?.set(d.name, snippet);
                  }
                } catch (fetchErr: unknown) {
                  console.error(
                    `⚠️  Failed to fetch content for '${d.name}' from '${d._registry}': ${(fetchErr as Error).message}`
                  );
                }
              })
            );
          }

          // Keep only dossiers that matched in content
          matched = matched.filter((d) => contentMatches?.has(d.name));
        }

        if (limit && limit > 0) {
          matched = matched.slice(0, limit);
        }

        const total = matched.length;
        const start = (page - 1) * perPage;
        const dossiers = matched.slice(start, start + perPage);
        const showRegistryLabel = resolveRegistries().length > 1;

        if (options.json) {
          console.log(JSON.stringify({ dossiers, total, page, perPage }, null, 2));
          process.exit(0);
        }

        if (dossiers.length === 0) {
          console.log(`\nNo dossiers found matching "${query}".\n`);
          process.exit(0);
        }

        console.log(`\n🔍 Found ${total} dossier(s) matching "${query}":\n`);

        for (const d of dossiers) {
          const { name, version, title, category, description } = formatDossierFields(d);
          const label = showRegistryLabel ? ` [${d._registry}]` : '';

          console.log(`  ${name} (v${version})${category ? `  [${category}]` : ''}${label}`);
          if (title) {
            console.log(`  ${title}`);
          }
          if (description) {
            const snippet =
              description.length > 100 ? `${description.slice(0, 100)}...` : description;
            console.log(`  ${snippet}`);
          }
          const snippet = contentMatches?.get(d.name);
          if (snippet) {
            console.log(`  Content match: ${snippet}`);
          }
          console.log('');
        }

        logPaginationInfo(total, page, perPage);
      }
    );
}
