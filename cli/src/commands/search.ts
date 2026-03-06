import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import { loadCredentials } from '../credentials';
import type { LabeledDossierListItem } from '../multi-registry';
import { multiRegistryList } from '../multi-registry';
import { getClientForRegistry } from '../registry-client';

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
        const page = parseInt(options.page, 10) || 1;
        const perPage = parseInt(options.perPage, 10) || 20;
        const limit = options.limit ? parseInt(options.limit, 10) : undefined;

        let allDossiers: LabeledDossierListItem[];
        try {
          const result = await multiRegistryList({
            category: options.category,
            page: 1,
            perPage: 100,
          });

          if (result.errors.length > 0) {
            for (const e of result.errors) {
              console.error(`⚠️  Registry '${e.registry}': ${e.error}`);
            }
          }

          allDossiers = result.dossiers;
        } catch (err: unknown) {
          console.error(`\n❌ Search failed: ${(err as Error).message}\n`);
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

          return terms.every((term) => fields.includes(term) || fields.indexOf(term) !== -1);
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
                } catch {
                  // Skip dossiers that fail to fetch
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
          const name = d.name || '';
          const version = d.version || '';
          const title = d.title || '';
          const category = Array.isArray(d.category) ? d.category.join(', ') : d.category || '';
          const description = d.description || d.objective || '';
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

        const totalPages = Math.ceil(total / perPage);
        if (totalPages > 1) {
          console.log(`Page ${page}/${totalPages} (${perPage} per page)`);
          if (page < totalPages) {
            console.log(`Use --page ${page + 1} to see more results`);
          }
          console.log('');
        }
      }
    );
}
