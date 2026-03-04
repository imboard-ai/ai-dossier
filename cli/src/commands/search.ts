import type { Command } from 'commander';
import { getClient } from '../registry-client';

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search the registry for dossiers')
    .argument('<query>', 'Search keywords')
    .option(
      '--category <category>',
      'Filter by category (devops, database, development, security, etc.)'
    )
    .option('--page <number>', 'Page number', '1')
    .option('--per-page <number>', 'Results per page', '20')
    .option('-c, --content', 'Also search dossier body content')
    .option('--json', 'Output as JSON')
    .action(
      async (
        query: string,
        options: {
          category?: string;
          page: string;
          perPage: string;
          json?: boolean;
          content?: boolean;
        }
      ) => {
        const page = parseInt(options.page, 10) || 1;
        const perPage = parseInt(options.perPage, 10) || 20;

        let allDossiers: any[];
        try {
          const client = getClient();
          const result = (await client.listDossiers({
            category: options.category,
            page: 1,
            perPage: 100,
          })) as any;
          allDossiers = result.dossiers || [];
        } catch (err: unknown) {
          console.error(`\n❌ Search failed: ${(err as Error).message}\n`);
          process.exit(1);
          return;
        }

        const queryLower = query.toLowerCase();
        const terms = queryLower.split(/\s+/).filter(Boolean);

        let matched = allDossiers.filter((d: any) => {
          const fields = [
            d.name || '',
            d.title || '',
            d.description || d.objective || '',
            ...(Array.isArray(d.category) ? d.category : [d.category || '']),
            ...(d.tags || []),
          ]
            .map((f: string) => String(f).toLowerCase())
            .join(' ');

          return terms.every((term) => fields.includes(term) || fields.indexOf(term) !== -1);
        });

        // Content search: fetch body and filter by content match
        if (options.content) {
          const client = getClient();
          const CONCURRENCY = 5;
          const contentMatches: Map<string, string> = new Map();

          // Process in batches for concurrency limiting
          for (let i = 0; i < matched.length; i += CONCURRENCY) {
            const batch = matched.slice(i, i + CONCURRENCY);
            const results = await Promise.all(
              batch.map(async (d: any) => {
                try {
                  const { content } = await client.getDossierContent(d.name, d.version || null);
                  const bodyLower = content.toLowerCase();
                  if (terms.some((term) => bodyLower.includes(term))) {
                    // Extract snippet around first match
                    const firstTerm = terms.find((t) => bodyLower.includes(t))!;
                    const idx = bodyLower.indexOf(firstTerm);
                    const start = Math.max(0, idx - 50);
                    const end = Math.min(content.length, idx + firstTerm.length + 50);
                    const snippet =
                      (start > 0 ? '...' : '') +
                      content.slice(start, end).replace(/\n/g, ' ') +
                      (end < content.length ? '...' : '');
                    contentMatches.set(d.name, snippet);
                    return d;
                  }
                  return null;
                } catch {
                  return null;
                }
              })
            );
            // We don't filter here yet; we collect results
            for (const r of results) {
              if (r === null) {
                // Mark for removal
              }
            }
          }

          // Keep only dossiers that matched in content
          matched = matched.filter((d: any) => contentMatches.has(d.name));

          // Attach snippets for display
          for (const d of matched) {
            (d as any)._contentSnippet = contentMatches.get(d.name);
          }
        }

        const total = matched.length;
        const start = (page - 1) * perPage;
        const dossiers = matched.slice(start, start + perPage);

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

          console.log(`  ${name} (v${version})${category ? '  [' + category + ']' : ''}`);
          if (title) {
            console.log(`  ${title}`);
          }
          if (description) {
            const snippet =
              description.length > 100 ? description.slice(0, 100) + '...' : description;
            console.log(`  ${snippet}`);
          }
          if ((d as any)._contentSnippet) {
            console.log(`  Content match: ${(d as any)._contentSnippet}`);
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
