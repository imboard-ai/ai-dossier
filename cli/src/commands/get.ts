import type { Command } from 'commander';
import type { DossierInfo } from '../registry-client';
import { getClient, parseNameVersion } from '../registry-client';

export function registerGetCommand(program: Command): void {
  program
    .command('get')
    .description('Get dossier metadata from the registry')
    .argument('<name>', 'Dossier name (optionally with @version, e.g., my-dossier@1.0.0)')
    .option('--json', 'Output as JSON')
    .action(async (nameArg: string, options: { json?: boolean }) => {
      const [dossierName, version] = parseNameVersion(nameArg);

      let meta: DossierInfo;
      try {
        const client = getClient();
        meta = await client.getDossier(dossierName, version || null);
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message: string };
        if (e.statusCode === 404) {
          console.error(`\n❌ Not found in registry: ${nameArg}\n`);
        } else {
          console.error(`\n❌ Registry error: ${e.message}\n`);
        }
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(meta, null, 2));
        process.exit(0);
      }

      console.log(`\n📄 Dossier: ${meta.name || dossierName}\n`);

      const fields: [string, string][] = [
        ['Name', meta.name || ''],
        ['Title', meta.title || ''],
        ['Version', meta.version || ''],
        ['Status', meta.status || ''],
        ['Category', Array.isArray(meta.category) ? meta.category.join(', ') : meta.category || ''],
        ['Risk Level', meta.risk_level || ''],
        ['Objective', meta.objective || meta.description || ''],
      ];

      for (const [label, value] of fields) {
        if (value) {
          console.log(`   ${label.padEnd(12)} ${value}`);
        }
      }

      const authors = meta.authors;
      if (Array.isArray(authors) && authors.length > 0) {
        const authorStr = authors
          .map((a) => (typeof a === 'string' ? a : a.name || ''))
          .filter(Boolean)
          .join(', ');
        if (authorStr) console.log(`   Authors      ${authorStr}`);
      }

      if (Array.isArray(meta.tags) && meta.tags.length > 0) {
        console.log(`   Tags         ${meta.tags.join(', ')}`);
      }

      if (meta.signature) {
        console.log(
          `   Signed by    ${meta.signature.signed_by || meta.signature.key_id || 'unknown'}`
        );
      }

      console.log('');
      process.exit(0);
    });
}
