#!/usr/bin/env npx tsx

/**
 * Dossier Schema Validator (Node.js)
 *
 * Validates Dossier frontmatter against the JSON Schema.
 *
 * Usage:
 *   npm install ajv ajv-formats
 *   npx tsx validate-dossier.ts /path/to/dossier.md
 */

import fs from 'node:fs';
import path from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

// Load schema
const schemaPath = path.join(__dirname, '../../dossier-schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// Initialize Ajv validator
const ajv = new Ajv({ allErrors: true, verbose: true });
addFormats(ajv);
const validate = ajv.compile(schema);

/**
 * Extract JSON frontmatter from a Dossier markdown file
 */
function extractFrontmatter(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, 'utf8');

  // Match ---dossier\n{...}\n---
  const frontmatterRegex = /^---dossier\s*\n([\s\S]*?)\n---/m;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('No dossier frontmatter found. Expected:\n---dossier\n{...}\n---');
  }

  const jsonString = match[1];

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Failed to parse frontmatter JSON: ${(err as Error).message}`);
  }
}

/**
 * Validate a Dossier file
 */
function validateDossier(filePath: string): boolean {
  console.log(`\n🔍 Validating: ${filePath}\n`);

  try {
    // Extract frontmatter
    const frontmatter = extractFrontmatter(filePath) as {
      title?: string;
      version?: string;
      status?: string;
    };
    console.log('✓ Frontmatter extracted successfully');
    console.log(`  Title: ${frontmatter.title}`);
    console.log(`  Version: ${frontmatter.version}`);
    console.log(`  Status: ${frontmatter.status}`);
    console.log();

    // Validate against schema
    const valid = validate(frontmatter);

    if (valid) {
      console.log('✅ VALID - Dossier schema is compliant\n');
      return true;
    } else {
      console.log('❌ INVALID - Schema validation failed:\n');
      (validate.errors as ErrorObject[]).forEach((err, i) => {
        console.log(`  Error ${i + 1}:`);
        console.log(`    Path: ${err.instancePath || '(root)'}`);
        console.log(`    Message: ${err.message}`);
        if (err.params) {
          console.log(`    Details: ${JSON.stringify(err.params)}`);
        }
        console.log();
      });
      return false;
    }
  } catch (err) {
    console.log(`❌ ERROR: ${(err as Error).message}\n`);
    return false;
  }
}

/**
 * Main
 */
function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx validate-dossier.ts <dossier-file.md>');
    console.log('Example: npx tsx validate-dossier.ts ../../examples/devops/deploy-to-aws.md');
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const valid = validateDossier(filePath);
  process.exit(valid ? 0 : 1);
}

// Run if called directly
main();

export { extractFrontmatter, validateDossier };
