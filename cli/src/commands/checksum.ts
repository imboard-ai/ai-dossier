import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';

export function registerChecksumCommand(program: Command): void {
  program
    .command('checksum')
    .description('Calculate, verify, or update dossier checksum')
    .argument('<file>', 'Dossier file')
    .option('--update', 'Update checksum in frontmatter')
    .option('--verify', 'Verify existing checksum (exit 0 if valid, 1 if invalid)')
    .option('--quiet', 'Only output the hash (for scripting)')
    .action((file: string, options: { update?: boolean; verify?: boolean; quiet?: boolean }) => {
      const dossierFile = path.resolve(file);

      if (!fs.existsSync(dossierFile)) {
        console.log(`❌ File not found: ${dossierFile}`);
        process.exit(1);
      }

      const content = fs.readFileSync(dossierFile, 'utf8');

      let frontmatter: DossierFrontmatter;
      let body: string;
      try {
        const parsed = parseDossierContent(content);
        frontmatter = parsed.frontmatter;
        body = parsed.body;
      } catch (err: unknown) {
        console.log(`❌ ${(err as Error).message}`);
        process.exit(1);
      }
      const calculatedHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
      const existingHash = frontmatter.checksum?.hash;

      if (options.quiet && !options.verify && !options.update) {
        console.log(calculatedHash);
        process.exit(0);
      }

      if (options.verify) {
        if (!existingHash) {
          if (!options.quiet) {
            console.log('❌ No checksum found in frontmatter');
          }
          process.exit(1);
        }

        if (existingHash === calculatedHash) {
          if (!options.quiet) {
            console.log('✅ Checksum valid');
            console.log(`   SHA256: ${calculatedHash}`);
          }
          process.exit(0);
        } else {
          if (!options.quiet) {
            console.log('❌ Checksum mismatch - content has been modified');
            console.log(`   Expected: ${existingHash}`);
            console.log(`   Actual:   ${calculatedHash}`);
          }
          process.exit(1);
        }
      }

      if (options.update) {
        frontmatter.checksum = {
          algorithm: 'sha256',
          hash: calculatedHash,
        };

        const updatedContent = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
        fs.writeFileSync(dossierFile, updatedContent, 'utf8');

        if (!options.quiet) {
          if (existingHash === calculatedHash) {
            console.log('✅ Checksum unchanged');
          } else if (existingHash) {
            console.log('✅ Checksum updated');
            console.log(`   Old: ${existingHash}`);
            console.log(`   New: ${calculatedHash}`);
          } else {
            console.log('✅ Checksum added');
          }
          console.log(`   SHA256: ${calculatedHash}`);
        } else {
          console.log(calculatedHash);
        }
        process.exit(0);
      }

      // Default: just show the checksum
      console.log(`\n📊 Dossier Checksum\n`);
      console.log(`   File: ${path.basename(dossierFile)}`);
      console.log(`   SHA256: ${calculatedHash}`);

      if (existingHash) {
        if (existingHash === calculatedHash) {
          console.log(`\n   ✅ Matches frontmatter checksum`);
        } else {
          console.log(`\n   ⚠️  Does NOT match frontmatter checksum`);
          console.log(`   Frontmatter: ${existingHash}`);
          console.log(`\n   Run 'dossier checksum ${file} --update' to fix`);
        }
      } else {
        console.log(`\n   ⚠️  No checksum in frontmatter`);
        console.log(`\n   Run 'dossier checksum ${file} --update' to add`);
      }

      console.log('');
      process.exit(0);
    });
}
