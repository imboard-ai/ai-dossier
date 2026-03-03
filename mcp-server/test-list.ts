#!/usr/bin/env npx tsx

/**
 * Test script for list_dossiers functionality
 */

import path from 'node:path';
import { listDossiers } from './dist/tools/listDossiers.js';

// Test with the examples directory
const examplesPath = path.join(__dirname, '../examples');

console.log('Testing list_dossiers with:', examplesPath);
console.log('');

try {
  const result = listDossiers({ path: examplesPath, recursive: true });
  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log(`Found ${result.count} dossiers`);
  console.log('Test completed successfully!');
  process.exit(0);
} catch (error) {
  console.error('Test failed:', (error as Error).message);
  console.error((error as Error).stack);
  process.exit(1);
}
