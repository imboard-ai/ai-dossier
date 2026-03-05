import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateChecksum, Ed25519Signer } from '@ai-dossier/core';
import type { Command } from 'commander';

export function registerFromFileCommand(program: Command): void {
  program
    .command('from-file')
    .description('Create a dossier from a plain text file')
    .argument('<input>', 'Path to text file (body content)')
    .option('--name <name>', 'Dossier name')
    .option('--title <title>', 'Dossier title')
    .option('--dossier-version <version>', 'Dossier version')
    .option('--status <status>', 'Dossier status', 'draft')
    .option('--objective <text>', 'Dossier objective')
    .option('--author <name>', 'Author name (repeatable)', collectValues, [])
    .option('--meta <path>', 'JSON file with frontmatter fields')
    .option('--sign', 'Sign the dossier')
    .option('--key <name-or-path>', 'Key name from ~/.dossier/ or path to private key')
    .option('--signed-by <name>', 'Signer identity')
    .option('-o, --output <path>', 'Output file path')
    .action(
      async (
        input: string,
        options: {
          name?: string;
          title?: string;
          dossierVersion?: string;
          status: string;
          objective?: string;
          author: string[];
          meta?: string;
          sign?: boolean;
          key?: string;
          signedBy?: string;
          output?: string;
        }
      ) => {
        const inputPath = path.resolve(input);
        if (!fs.existsSync(inputPath)) {
          console.error(`\n❌ Input file not found: ${inputPath}\n`);
          process.exit(1);
        }

        const body = fs.readFileSync(inputPath, 'utf8');

        // Load meta file if provided
        let meta: Record<string, unknown> = {};
        if (options.meta) {
          const metaPath = path.resolve(options.meta);
          if (!fs.existsSync(metaPath)) {
            console.error(`\n❌ Meta file not found: ${metaPath}\n`);
            process.exit(1);
          }
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch (err: unknown) {
            console.error(`\n❌ Invalid JSON in meta file: ${(err as Error).message}\n`);
            process.exit(1);
          }
        }

        // Flags override meta
        const name = options.name || (meta.name as string);
        const title = options.title || (meta.title as string);
        const objective = options.objective || (meta.objective as string);
        const authors =
          options.author.length > 0 ? options.author : (meta.authors as string[]) || [];

        // Validate required fields
        const missing: string[] = [];
        if (!name) missing.push('name');
        if (!title) missing.push('title');
        if (!objective) missing.push('objective');
        if (authors.length === 0) missing.push('author');

        if (missing.length > 0) {
          console.error(`\n❌ Missing required fields: ${missing.join(', ')}`);
          console.error('   Provide them via flags or --meta file\n');
          process.exit(1);
        }

        // Build frontmatter
        const version = options.dossierVersion || (meta.version as string) || '1.0.0';
        const frontmatter: Record<string, unknown> = {
          ...meta,
          name,
          title,
          version,
          status: options.status,
          objective,
          authors: authors.map((a) => ({ name: a })),
          checksum: {
            algorithm: 'sha256',
            hash: calculateChecksum(body),
          },
        };

        // Sign if requested
        if (options.sign) {
          if (!options.key) {
            console.error('\n❌ --key is required when using --sign\n');
            process.exit(1);
          }
          let keyPath = path.resolve(options.key);
          // Support name-based lookup from ~/.dossier/
          if (!fs.existsSync(keyPath)) {
            const namedPath = path.join(os.homedir(), '.dossier', `${options.key}.pem`);
            if (fs.existsSync(namedPath)) {
              keyPath = namedPath;
            } else {
              console.error(`\n❌ Key not found: ${options.key}`);
              console.error(`   Checked: ${keyPath}`);
              console.error(`   Checked: ${namedPath}\n`);
              process.exit(1);
            }
          }

          try {
            const signer = new Ed25519Signer(keyPath);
            const sigResult = await signer.sign(body);
            frontmatter.signature = {
              ...sigResult,
              signed_by: options.signedBy || 'unknown',
            };
          } catch (err: unknown) {
            console.error(`\n❌ Signing failed: ${(err as Error).message}\n`);
            process.exit(1);
          }
        }

        const output = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
        const outputPath = options.output
          ? path.resolve(options.output)
          : path.resolve(`${name}.ds.md`);

        fs.writeFileSync(outputPath, output, 'utf8');

        console.log(`\n✅ Dossier created: ${outputPath}`);
        console.log(`   Name:    ${name}`);
        console.log(`   Title:   ${title}`);
        console.log(`   Version: ${version}`);
        if (options.sign) {
          console.log('   Signed:  yes');
        }
        console.log('');

        process.exit(0);
      }
    );
}

function collectValues(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
