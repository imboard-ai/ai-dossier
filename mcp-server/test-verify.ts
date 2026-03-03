#!/usr/bin/env npx tsx

/**
 * Test script for verify_dossier functionality
 */

import path from 'node:path';
import { verifyDossier } from './dist/tools/verifyDossier.js';

// Test with the git worktree dossier
const dossierPath = path.join(__dirname, '../examples/development/add-git-worktree-support.ds.md');

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
