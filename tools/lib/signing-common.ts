/**
 * Common utilities for dossier signing tools
 * Shared by sign-dossier.ts and sign-dossier-kms.ts
 */

import fs from 'node:fs';
import {
  calculateChecksum,
  type DossierFrontmatter,
  type ParsedDossier,
  parseDossierContent,
  readFileIfExists,
} from '@imboard-ai/dossier-core';

/**
 * Read and parse a dossier file
 */
function readAndParseDossier(dossierFile: string): {
  frontmatter: DossierFrontmatter;
  body: string;
} {
  const content = readFileIfExists(dossierFile);
  if (!content) {
    console.error(`Error: File not found: ${dossierFile}`);
    process.exit(1);
  }

  let parsed: ParsedDossier;
  try {
    parsed = parseDossierContent(content);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  return parsed;
}

/**
 * Calculate and add checksum to frontmatter
 */
function addChecksum(frontmatter: DossierFrontmatter, body: string): string {
  console.log('\n📊 Calculating checksum...');
  const checksum = calculateChecksum(body);
  console.log(`   SHA256: ${checksum}`);

  frontmatter.checksum = {
    algorithm: 'sha256',
    hash: checksum,
  } as DossierFrontmatter['checksum'];

  return checksum;
}

/**
 * Handle dry run - print checksum without signing
 */
function handleDryRun(frontmatter: DossierFrontmatter): void {
  console.log('\n✅ Dry run complete (checksum calculated, no signature)');
  console.log('\nUpdated frontmatter:');
  console.log(JSON.stringify(frontmatter, null, 2));
}

/**
 * Write updated dossier file with new frontmatter
 */
function writeDossier(dossierFile: string, frontmatter: DossierFrontmatter, body: string): void {
  console.log('\n💾 Updating dossier file...');

  const updatedContent = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
  fs.writeFileSync(dossierFile, updatedContent, 'utf8');

  console.log('   ✓ File updated');
}

export { readAndParseDossier, addChecksum, handleDryRun, writeDossier };
