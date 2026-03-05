/**
 * search_dossiers tool - Search the registry for dossiers
 * Thin wrapper around `ai-dossier search --json <query>`
 */

import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';

export interface SearchDossiersInput {
  query: string;
  category?: string;
}

export interface SearchResult {
  name: string;
  title: string;
  version: string;
  description?: string | null;
  category?: string[];
  tags?: string[];
  authors?: Array<{ name: string }>;
}

export interface SearchDossiersOutput {
  dossiers: SearchResult[];
  total: number;
}

/**
 * Search the dossier registry via CLI
 */
export async function searchDossiers(input: SearchDossiersInput): Promise<SearchDossiersOutput> {
  const { query, category } = input;

  logger.info('Searching dossier registry via CLI', { query, category });

  const args = [query, '--json'];
  if (category) {
    args.push('--category', category);
  }

  try {
    const result = await execCli<{ dossiers: SearchResult[]; total: number }>('search', args);

    logger.info('Registry search completed', {
      query,
      total: result.total,
    });

    return {
      dossiers: result.dossiers || [],
      total: result.total || 0,
    };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      throw new Error(error.message);
    }
    throw error;
  }
}
