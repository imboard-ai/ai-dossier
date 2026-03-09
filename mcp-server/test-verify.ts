#!/usr/bin/env npx tsx

/**
 * Test script for verify_dossier functionality
 */

import path from 'node:path';
import { verifyDossier } from './dist/tools/verifyDossier.js';

// Test with the hello-world test fixture
const dossierPath = path.join(__dirname, '../examples/test/hello-world.ds.md');

console.log('Testing verify_dossier with:', dossierPath);
console.log('');

try {
  const result = verifyDossier({ path: dossierPath });
  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log('Test completed successfully!');
  process.exit(0);
} catch (error) {
  console.error('Test failed:', (error as Error).message);
  console.error((error as Error).stack);
  process.exit(1);
}
