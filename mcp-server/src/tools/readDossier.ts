/**
 * read_dossier tool - Read and return dossier content
 * Thin wrapper around `ai-dossier info --json <path>` + file read for body
 */

import { readFileSync } from 'node:fs';
import {
  collectDeclaredUrls,
  findUndeclaredUrls,
  parseDossierContent,
  scanBodyForUrls,
} from '@ai-dossier/core';
import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';
import { validatePathWithinCwd } from '../utils/paths';

export interface ReadDossierInput {
  path: string;
}

export interface ReadDossierOutput {
  metadata: Record<string, unknown>;
  body: string;
  security_notices?: string[];
}

/**
 * Read and parse a dossier file via CLI
 */
export async function readDossier(input: ReadDossierInput): Promise<ReadDossierOutput> {
  const { path: dossierPath } = input;

  const resolvedPath = validatePathWithinCwd(dossierPath);

  logger.info('Reading dossier via CLI', { dossierFile: dossierPath });

  try {
    const metadata = await execCli<Record<string, unknown>>('info', [dossierPath, '--json']);

    // Read body using core parser (single source of truth for frontmatter extraction)
    const fileContent = readFileSync(resolvedPath, 'utf8');
    let body: string;
    try {
      body = parseDossierContent(fileContent).body;
    } catch {
      body = fileContent;
    }

    logger.info('Dossier read successfully', {
      dossierFile: dossierPath,
      title: metadata.title,
      bodyLength: body.length,
    });

    const securityNotices: string[] = [];
    const bodyUrls = scanBodyForUrls(body);
    if (bodyUrls.length > 0) {
      const declaredUrls = collectDeclaredUrls(
        metadata as import('@ai-dossier/core').DossierFrontmatter
      );
      const undeclared = findUndeclaredUrls(bodyUrls, declaredUrls);
      if (undeclared.length > 0) {
        securityNotices.push(
          `WARNING: ${undeclared.length} undeclared external URL(s) found in body: ${undeclared.join(', ')}. These URLs are NOT covered by the dossier trust chain.`
        );
      }
    }

    return {
      metadata,
      body,
      ...(securityNotices.length > 0 ? { security_notices: securityNotices } : {}),
    };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      throw new Error(error.message);
    }
    throw error;
  }
}
