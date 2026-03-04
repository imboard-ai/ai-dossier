/**
 * Dossier parser - extracts frontmatter and body from dossier files
 */

import type { DossierFrontmatter, ParsedDossier } from './types';
import { getErrorMessage } from './utils/errors';
import { readFileIfExists } from './utils/fs';

/**
 * Parse dossier content into frontmatter and body
 * Format: ---dossier\n{JSON}\n---\n[body]
 */
export function parseDossierContent(content: string): ParsedDossier {
  const frontmatterRegex = /^---dossier\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/m;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid dossier format. Expected:\n---dossier\n{...}\n---\n[body]');
  }

  const frontmatterJson = match[1];
  const body = match[2];

  let frontmatter: DossierFrontmatter;
  try {
    frontmatter = JSON.parse(frontmatterJson);
  } catch (err) {
    throw new Error(`Failed to parse frontmatter JSON: ${getErrorMessage(err)}`);
  }

  return {
    frontmatter,
    body,
    raw: content,
  };
}

/**
 * Read and parse a dossier file
 */
export function parseDossierFile(filePath: string): ParsedDossier {
  const content = readFileIfExists(filePath, 'Dossier file not found: {path}') as string;
  return parseDossierContent(content);
}

/**
 * Validate required frontmatter fields
 */
export function validateFrontmatter(frontmatter: DossierFrontmatter): string[] {
  const errors: string[] = [];
  const required = [
    'version',
    'protocol_version',
    'title',
    'objective',
    'risk_level',
    'risk_factors',
    'destructive_operations',
  ];

  for (const field of required) {
    if (!(field in frontmatter)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate risk_level enum
  const validRiskLevels = ['low', 'medium', 'high', 'critical'];
  if (frontmatter.risk_level && !validRiskLevels.includes(frontmatter.risk_level)) {
    errors.push(
      `Invalid risk_level: ${frontmatter.risk_level}. Must be one of: ${validRiskLevels.join(', ')}`
    );
  }

  // Validate status enum
  const validStatuses = ['draft', 'stable', 'deprecated'];
  if (frontmatter.status && !validStatuses.includes(frontmatter.status)) {
    errors.push(
      `Invalid status: ${frontmatter.status}. Must be one of: ${validStatuses.join(', ')}`
    );
  }

  return errors;
}
