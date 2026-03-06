import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import { resolveRegistries } from '../config';
import { multiRegistryGetDossier } from '../multi-registry';
import type { DossierInfo } from '../registry-client';
import { parseNameVersion } from '../registry-client';

export function registerInfoCommand(program: Command): void {
  program
    .command('info')
    .description('Show dossier metadata')
    .argument('<file-or-name>', 'Local dossier file path or registry dossier name')
    .option('--json', 'Output as JSON')
    .action(async (fileOrName: string, options: { json?: boolean }) => {
      let frontmatter: DossierInfo;
      let body: string | null;
      let source: string;

      const resolved = path.resolve(fileOrName);
      const isLocal = fs.existsSync(resolved);

      if (isLocal) {
        source = resolved;
        const content = fs.readFileSync(resolved, 'utf8');

        try {
          const parsed = parseDossierContent(content);
          frontmatter = parsed.frontmatter as unknown as DossierInfo;
          body = parsed.body;
        } catch {
          console.error('\n❌ Invalid dossier format: no frontmatter found\n');
          process.exit(1);
        }
      } else {
        try {
          const [dossierName, version] = parseNameVersion(fileOrName);
          const meta = await multiRegistryGetDossier(dossierName, version || null);
          if (!meta) {
            console.error(`\n❌ Not found: ${fileOrName}`);
            console.error('   Not a local file and not found in any registry\n');
            process.exit(1);
          }
          frontmatter = meta;
          body = null;
          const showLabel = resolveRegistries().length > 1;
          source = showLabel
            ? `registry: ${fileOrName} [${meta._registry}]`
            : `registry: ${fileOrName}`;
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          if (e.statusCode === 404) {
            console.error(`\n❌ Not found: ${fileOrName}`);
            console.error('   Not a local file and not found in registry\n');
          } else {
            console.error(`\n❌ Error: ${e.message}\n`);
          }
          process.exit(1);
        }
      }

      if (options.json) {
        console.log(JSON.stringify(frontmatter, null, 2));
        process.exit(0);
      }

      console.log(`\n📄 Dossier Info\n`);
      console.log(`   Source:    ${source}`);

      const fm = frontmatter;
      const fields: [string, string][] = [
        ['Name', fm.name || fm.title || ''],
        ['Title', fm.title || ''],
        ['Version', fm.version || ''],
        ['Status', fm.status || ''],
        ['Category', Array.isArray(fm.category) ? fm.category.join(', ') : fm.category || ''],
        ['Risk Level', fm.risk_level || ''],
        ['Objective', fm.objective || fm.description || ''],
      ];

      for (const [label, value] of fields) {
        if (value) {
          console.log(`   ${label.padEnd(10)} ${value}`);
        }
      }

      const authors = fm.authors;
      if (Array.isArray(authors) && authors.length > 0) {
        const authorStr = authors
          .map((a: string | { name: string }) => {
            if (typeof a === 'string') {
              const nameMatch = a.match(/^name:\s*(.+)$/);
              return nameMatch ? nameMatch[1] : a;
            }
            return a.name || '';
          })
          .filter(Boolean)
          .join(', ');
        if (authorStr) console.log(`   Authors:   ${authorStr}`);
      }

      if (Array.isArray(fm.tags) && fm.tags.length > 0) {
        console.log(`   Tags:      ${fm.tags.join(', ')}`);
      }

      if (body !== null) {
        const checksumInfo = fm.checksum;
        if (checksumInfo?.hash) {
          const actual = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
          const valid = actual === checksumInfo.hash;
          console.log(
            `   Checksum:  ${checksumInfo.hash.slice(0, 16)}... ${valid ? '✅ valid' : '❌ mismatch'}`
          );
        } else {
          console.log(`   Checksum:  missing`);
        }
      }

      if (fm.signature) {
        const sig = fm.signature;
        console.log(`   Signed by: ${sig.signed_by || sig.key_id || 'unknown'}`);
      }

      console.log('');
      process.exit(0);
    });
}
