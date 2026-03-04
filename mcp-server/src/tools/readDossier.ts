/**
 * read_dossier tool - Read and return dossier content
 * Should be called AFTER verify_dossier passes
 */

import { resolve } from 'node:path';
import { type DossierFrontmatter, parseDossierFile } from '@imboard-ai/dossier-core';
import { logger } from '../utils/logger';

export interface ReadDossierInput {
  path: string;
}

export interface ReadDossierOutput {
  metadata: {
    title: string;
    version: string;
    protocol: string;
    status: string;
    risk_level: string;
    objective: string;
    path: string;
  };
  frontmatter: DossierFrontmatter;
  body: string;
}

/**
 * Read and parse a dossier file
 * Returns metadata and content for LLM execution
 */
export function readDossier(input: ReadDossierInput): ReadDossierOutput {
  const { path } = input;

  // Validate path stays within the current working directory
  const resolvedPath = resolve(path);
  const cwd = process.cwd();
  if (!resolvedPath.startsWith(`${cwd}/`) && resolvedPath !== cwd) {
    throw new Error(`Access denied: path "${path}" is outside the working directory`);
  }

  logger.info('Reading dossier', { dossierFile: path });

  const parsed = parseDossierFile(path);
  const { frontmatter, body } = parsed;

  const output: ReadDossierOutput = {
    metadata: {
      title: frontmatter.title,
      version: frontmatter.version,
      protocol: frontmatter.protocol_version,
      status: frontmatter.status,
      risk_level: frontmatter.risk_level,
      objective: frontmatter.objective,
      path,
    },
    frontmatter,
    body,
  };

  logger.info('Dossier read successfully', {
    dossierFile: path,
    title: frontmatter.title,
    bodyLength: body.length,
  });

  return output;
}
