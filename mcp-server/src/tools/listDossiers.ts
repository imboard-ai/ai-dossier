/**
 * list_dossiers tool - Discover dossiers in a directory
 * Thin wrapper around `ai-dossier list --format json [path]`
 */

import { resolve } from 'node:path';
import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';

export interface ListDossiersInput {
  path?: string;
  recursive?: boolean;
}

export interface DossierListItem {
  path: string;
  filename: string;
  title: string;
  version?: string;
  risk_level?: string;
  status?: string;
  signed?: boolean;
  objective?: string;
}

export interface ListDossiersOutput {
  dossiers: DossierListItem[];
  scannedPath: string;
  count: number;
}

/**
 * List all dossiers in a directory via CLI
 */
export async function listDossiers(input: ListDossiersInput): Promise<ListDossiersOutput> {
  const searchPath = input.path || process.cwd();
  const recursive = input.recursive !== false;

  // Validate path stays within the current working directory
  const resolvedPath = resolve(searchPath);
  const cwd = process.cwd();
  if (!resolvedPath.startsWith(`${cwd}/`) && resolvedPath !== cwd) {
    throw new Error(`Access denied: path "${searchPath}" is outside the working directory`);
  }

  logger.info('Scanning for dossiers via CLI', { searchPath, recursive });

  const args = [resolvedPath, '--format', 'json'];
  if (recursive) {
    args.push('--recursive');
  }

  try {
    const result = await execCli<DossierListItem[]>('list', args);

    const dossiers = Array.isArray(result) ? result : [];

    logger.info('Dossier scan completed', {
      searchPath,
      count: dossiers.length,
    });

    return {
      dossiers,
      scannedPath: searchPath,
      count: dossiers.length,
    };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      throw new Error(error.message);
    }
    throw error;
  }
}
