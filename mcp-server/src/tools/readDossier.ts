/**
 * read_dossier tool - Read and return dossier content
 * Thin wrapper around `ai-dossier info --json <path>` + file read for body
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';

export interface ReadDossierInput {
  path: string;
}

export interface ReadDossierOutput {
  metadata: Record<string, unknown>;
  body: string;
}

/**
 * Extract the body content from a dossier file (everything after the frontmatter).
 */
function extractBody(content: string): string {
  // JSON frontmatter: ---dossier\n...\n---
  const jsonMatch = content.match(/^---dossier\s*\n[\s\S]*?\n---\n?([\s\S]*)$/);
  if (jsonMatch) return jsonMatch[1];

  // YAML frontmatter: ---\n...\n---
  const yamlMatch = content.match(/^---\s*\n[\s\S]*?\n---\n?([\s\S]*)$/);
  if (yamlMatch) return yamlMatch[1];

  return content;
}

/**
 * Read and parse a dossier file via CLI
 */
export async function readDossier(input: ReadDossierInput): Promise<ReadDossierOutput> {
  const { path: dossierPath } = input;

  // Validate path stays within the current working directory
  const resolvedPath = resolve(dossierPath);
  const cwd = process.cwd();
  if (!resolvedPath.startsWith(`${cwd}/`) && resolvedPath !== cwd) {
    throw new Error(`Access denied: path "${dossierPath}" is outside the working directory`);
  }

  logger.info('Reading dossier via CLI', { dossierFile: dossierPath });

  try {
    const metadata = await execCli<Record<string, unknown>>('info', [dossierPath, '--json']);

    // Read body directly from file (info --json returns only metadata)
    const fileContent = readFileSync(resolvedPath, 'utf8');
    const body = extractBody(fileContent);

    logger.info('Dossier read successfully', {
      dossierFile: dossierPath,
      title: metadata.title,
      bodyLength: body.length,
    });

    return { metadata, body };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      throw new Error(error.message);
    }
    throw error;
  }
}
