/**
 * list_dossiers tool - Discover dossiers in a directory
 * Thin wrapper around `ai-dossier list --format json [path]`
 */

import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';
import { validatePathWithinCwd } from '../utils/paths';

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

  const resolvedPath = validatePathWithinCwd(searchPath);

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
