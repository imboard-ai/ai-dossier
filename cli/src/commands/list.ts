import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import type { DossierMetadata } from '../helpers';
import {
  fetchDossierMetadata,
  findDossierFilesGitHub,
  findDossierFilesLocal,
  formatTable,
  parseDossierMetadataLocal,
  parseListSource,
} from '../helpers';
import { multiRegistryList } from '../multi-registry';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description(
      'List available dossiers from registry, directory, or repository. With --source registry, queries all configured registries in parallel.'
    )
    .argument('[source]', 'Directory, GitHub repo (github:owner/repo), or URL', '.')
    .option('-r, --recursive', 'Search subdirectories recursively (default for remote)')
    .option('--signed-only', 'Only show signed dossiers')
    .option('--risk <level>', 'Filter by risk level (low, medium, high, critical)')
    .option('--category <category>', 'Filter by category')
    .option('--json', 'Output as JSON')
    .option('--format <fmt>', 'Output format (table, json, simple)', 'table')
    .option('--show-path', 'Show full path instead of filename')
    .option('--source <type>', 'Source type: registry, local, github')
    .option('--page <number>', 'Page number (registry only)', '1')
    .option('--per-page <number>', 'Results per page (registry only)', '20')
    .addHelpText(
      'after',
      `
Multi-registry note:
  When multiple registries are configured, --page and --per-page apply to each
  registry independently. For consistent results across registries, use
  --per-page with a value large enough to capture all dossiers per registry,
  or use 'search' for filtered queries.
`
    )
    .action(
      async (
        source: string,
        options: {
          json?: boolean;
          format?: string;
          source?: string;
          page?: string;
          perPage?: string;
          recursive?: boolean;
          signedOnly?: boolean;
          risk?: string;
          category?: string;
          showPath?: boolean;
        }
      ) => {
        if (options.json) {
          options.format = 'json';
        }

        if (options.source === 'registry') {
          const page = parseInt(options.page || '1', 10) || 1;
          const perPage = parseInt(options.perPage || '20', 10) || 20;
          const showRegistryLabel = resolveRegistries().length > 1;

          try {
            const result = await multiRegistryList({
              category: options.category,
              page,
              perPage,
            });

            if (result.errors.length > 0) {
              for (const e of result.errors) {
                console.error(`⚠️  Registry '${e.registry}': ${e.error}`);
              }
              const totalRegistries = resolveRegistries().length;
              const failed = result.errors.length;
              console.error(
                `⚠️  Showing partial results (${totalRegistries - failed}/${totalRegistries} registries responded)\n`
              );
            }

            const dossiers = result.dossiers;

            if (options.format === 'json') {
              console.log(
                JSON.stringify({ dossiers, total: result.total, page, perPage }, null, 2)
              );
              process.exit(0);
            }

            if (options.format === 'simple') {
              for (const d of dossiers) {
                const label = showRegistryLabel ? ` [${d._registry}]` : '';
                console.log(`${d.name || ''}${label}`);
              }
              process.exit(0);
            }

            if (dossiers.length === 0) {
              console.log('\n⚠️  No dossiers found in registry\n');
              process.exit(0);
            }

            console.log(`\n📋 Registry dossiers (${result.total} total):\n`);

            for (const d of dossiers) {
              const name = d.name || '';
              const version = d.version || '';
              const title = d.title || '';
              const category = Array.isArray(d.category) ? d.category.join(', ') : d.category || '';
              const label = showRegistryLabel ? ` [${d._registry}]` : '';
              console.log(
                `  ${name.padEnd(30)} ${(`v${version}`).padEnd(10)} ${category.padEnd(12)} ${title}${label}`
              );
            }

            const totalPages = Math.ceil(result.total / perPage);
            if (totalPages > 1) {
              console.log(`\nPage ${page}/${totalPages}`);
              if (page < totalPages) {
                console.log(`Use --page ${page + 1} to see more results`);
              }
            }
            console.log('');
          } catch (err: unknown) {
            console.error(`\n❌ Registry list failed: ${(err as Error).message}\n`);
            process.exit(1);
          }
          process.exit(0);
        }

        const parsed = parseListSource(source);
        let dossiers: DossierMetadata[] = [];

        if (parsed.type === 'github') {
          console.log(`\n🔍 Fetching dossiers from GitHub: ${parsed.owner}/${parsed.repo}`);
          if (parsed.path) {
            console.log(`   Path: ${parsed.path}`);
          }
          console.log(`   Branch: ${parsed.branch}\n`);

          try {
            const files = await findDossierFilesGitHub(
              parsed.owner ?? '',
              parsed.repo ?? '',
              parsed.path || '',
              parsed.branch ?? 'main'
            );

            if (files.length === 0) {
              console.log('⚠️  No dossiers found (*.ds.md files)');
              process.exit(0);
            }

            console.log(`   Found ${files.length} dossier file(s)\n`);
            console.log('📥 Fetching metadata...\n');

            const batchSize = 5;
            for (let i = 0; i < files.length; i += batchSize) {
              const batch = files.slice(i, i + batchSize);
              const results = await Promise.all(
                batch.map((f) => fetchDossierMetadata(f.rawUrl, f.path))
              );
              dossiers.push(...results);
            }
          } catch (err: unknown) {
            console.log(`❌ Error: ${(err as Error).message}`);
            process.exit(1);
          }
        } else {
          const searchDir = path.resolve(parsed.path || '.');

          if (!fs.existsSync(searchDir)) {
            console.log(`❌ Directory not found: ${searchDir}`);
            process.exit(1);
          }

          if (!fs.statSync(searchDir).isDirectory()) {
            console.log(`❌ Not a directory: ${searchDir}`);
            process.exit(1);
          }

          console.log(`\n🔍 Searching for dossiers in: ${searchDir}`);
          if (options.recursive) {
            console.log('   (recursive search enabled)');
          }

          const files = findDossierFilesLocal(searchDir, options.recursive);

          if (files.length === 0) {
            console.log('\n⚠️  No dossiers found (*.ds.md files)');
            console.log('\nTips:');
            console.log('  - Use --recursive to search subdirectories');
            console.log('  - Ensure files have the .ds.md extension');
            console.log('  - Try: dossier list github:owner/repo\n');
            process.exit(0);
          }

          console.log(`   Found ${files.length} dossier file(s)\n`);
          dossiers = files.map((f) => parseDossierMetadataLocal(f));
        }

        if (options.signedOnly) {
          dossiers = dossiers.filter((d) => d.signed === true);
        }
        if (options.risk) {
          const riskLevel = options.risk.toLowerCase();
          dossiers = dossiers.filter((d) => (d.risk_level || '').toLowerCase() === riskLevel);
        }
        if (options.category) {
          const category = options.category.toLowerCase();
          dossiers = dossiers.filter((d) => (d.category || '').toLowerCase().includes(category));
        }

        if (options.format === 'json') {
          console.log(JSON.stringify(dossiers, null, 2));
        } else if (options.format === 'simple') {
          for (const d of dossiers) {
            console.log(d.path);
          }
        } else {
          console.log(formatTable(dossiers, options.showPath));

          console.log(`\nTotal: ${dossiers.length} dossier(s)`);

          const signed = dossiers.filter((d) => d.signed).length;
          const unsigned = dossiers.length - signed;
          if (signed > 0 || unsigned > 0) {
            console.log(`   Signed: ${signed}  |  Unsigned: ${unsigned}`);
          }

          const riskCounts: Record<string, number> = {};
          for (const d of dossiers) {
            const risk = (d.risk_level || 'unknown').toLowerCase();
            riskCounts[risk] = (riskCounts[risk] || 0) + 1;
          }
          const riskSummary = Object.entries(riskCounts)
            .map(([k, v]) => `${k}: ${v}`)
            .join('  |  ');
          if (riskSummary) {
            console.log(`   Risk: ${riskSummary}`);
          }

          console.log('');
        }

        process.exit(0);
      }
    );
}
