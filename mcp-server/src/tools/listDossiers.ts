/**
 * list_dossiers tool - Discover dossiers in a directory
 * Scans for *.ds.md files and returns metadata
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { type DossierListItem, getErrorMessage, parseDossierFile } from '@imboard-ai/dossier-core';
import { logger } from '../utils/logger';

export interface ListDossiersInput {
  path?: string;
  recursive?: boolean;
}

export interface ListDossiersOutput {
  dossiers: DossierListItem[];
  scannedPath: string;
  count: number;
}

/**
 * Recursively find all .ds.md files in a directory
 */
function findDossierFiles(dir: string, basePath: string, recursive: boolean): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      try {
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules, .git, etc.
          if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
            continue;
          }

          if (recursive) {
            files.push(...findDossierFiles(fullPath, basePath, recursive));
          }
        } else if (stat.isFile() && entry.endsWith('.ds.md')) {
          files.push(fullPath);
        }
      } catch (err) {
        // Skip files we can't stat (permission errors, etc.)
        logger.warn('Could not stat file', { path: fullPath, error: getErrorMessage(err) });
      }
    }
  } catch (err) {
    logger.error('Could not read directory', { dir, error: getErrorMessage(err) });
  }

  return files;
}

/**
 * List all dossiers in a directory
 */
export function listDossiers(input: ListDossiersInput): ListDossiersOutput {
  const searchPath = input.path || process.cwd();
  const recursive = input.recursive !== false; // default true

  // Validate path stays within the current working directory
  const resolvedPath = resolve(searchPath);
  const cwd = process.cwd();
  if (!resolvedPath.startsWith(`${cwd}/`) && resolvedPath !== cwd) {
    throw new Error(`Access denied: path "${searchPath}" is outside the working directory`);
  }

  logger.info('Scanning for dossiers', { searchPath, recursive });

  const dossierFiles = findDossierFiles(searchPath, searchPath, recursive);
  const dossiers: DossierListItem[] = [];

  for (const filePath of dossierFiles) {
    try {
      const parsed = parseDossierFile(filePath);
      const { frontmatter } = parsed;

      // Extract name from filename (without .ds.md)
      const fileName = filePath.split('/').pop();
      if (!fileName) continue;
      const name = fileName.replace('.ds.md', '');

      dossiers.push({
        name,
        path: relative(searchPath, filePath),
        version: frontmatter.version,
        protocol: frontmatter.protocol_version,
        status: frontmatter.status,
        objective: frontmatter.objective,
        riskLevel: frontmatter.risk_level,
      });

      logger.debug('Found dossier', {
        name,
        path: filePath,
        title: frontmatter.title,
      });
    } catch (err) {
      logger.warn('Could not parse dossier file', {
        path: filePath,
        error: getErrorMessage(err),
      });
    }
  }

  logger.info('Dossier scan completed', {
    searchPath,
    count: dossiers.length,
    foundFiles: dossierFiles.length,
  });

  return {
    dossiers,
    scannedPath: searchPath,
    count: dossiers.length,
  };
}
