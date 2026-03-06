import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { multiRegistryGetContent } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Download a dossier and save to a local file')
    .argument('<name>', 'Dossier name (use name@version for a specific version)')
    .option('-o, --output <path>', 'Output file path')
    .option('--stdout', 'Print to stdout instead of saving to file')
    .action(async (name: string, options: { output?: string; stdout?: boolean }) => {
      const [dossierName, version] = parseNameVersion(name);

      let content: string;
      let digest: string | null;
      try {
        const result = await multiRegistryGetContent(dossierName, version || null);
        if (!result) {
          console.error(`\n❌ Not found: ${name}\n`);
          process.exit(1);
          return;
        }
        content = result.content;
        digest = result.digest;
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message: string };
        if (e.statusCode === 404) {
          console.error(`\n❌ Not found: ${name}\n`);
        } else {
          console.error(`\n❌ Export failed: ${e.message}\n`);
        }
        process.exit(1);
        return;
      }

      if (options.stdout) {
        process.stdout.write(content);
        process.exit(0);
      }

      const outputPath = options.output || `${dossierName.replace(/\//g, '-')}.ds.md`;
      const outputDir = path.dirname(path.resolve(outputPath));

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(path.resolve(outputPath), content, 'utf8');

      console.log(`\n✅ Exported: ${outputPath}`);
      console.log(`   Source: ${dossierName}${version ? `@${version}` : ''}`);
      if (digest) {
        console.log(`   Digest: ${digest}`);
      }
      console.log('');
    });
}
