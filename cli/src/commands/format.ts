import fs from 'node:fs';
import { formatDossierContent, formatDossierFile } from '@ai-dossier/core';
import type { Command } from 'commander';

export function registerFormatCommand(program: Command): void {
  program
    .command('format')
    .description('Format dossier files')
    .argument('<file>', 'Dossier file to format')
    .option('--check', 'Check if file is already formatted (exit 1 if not)')
    .option('--no-checksum', 'Do not update checksum after formatting')
    .option('--no-sort-keys', 'Do not sort frontmatter keys')
    .option('--indent <n>', 'JSON indentation spaces', '2')
    .option('--json', 'Output result as JSON')
    .action(
      (
        file: string,
        options: {
          check?: boolean;
          checksum?: boolean;
          sortKeys?: boolean;
          indent: string;
          json?: boolean;
        }
      ) => {
        const formatOptions = {
          indent: parseInt(options.indent, 10),
          sortKeys: options.sortKeys !== false,
          updateChecksum: options.checksum !== false,
        };

        let exitCode = 0;
        try {
          if (options.check) {
            const content = fs.readFileSync(file, 'utf8');
            const result = formatDossierContent(content, formatOptions);

            if (options.json) {
              console.log(JSON.stringify({ file, formatted: !result.changed }, null, 2));
            } else {
              if (result.changed) {
                console.log(`${file}: needs formatting`);
              } else {
                console.log(`${file}: already formatted`);
              }
            }

            exitCode = result.changed ? 1 : 0;
          } else {
            const result = formatDossierFile(file, formatOptions);

            if (options.json) {
              console.log(JSON.stringify({ file, changed: result.changed }, null, 2));
            } else {
              if (result.changed) {
                console.log(`${file}: formatted`);
              } else {
                console.log(`${file}: already formatted`);
              }
            }

            exitCode = 0;
          }
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          exitCode = 2;
        }

        process.exit(exitCode);
      }
    );
}
