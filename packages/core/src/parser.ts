/**
 * Dossier parser - extracts frontmatter and body from dossier files.
 *
 * Supports two frontmatter formats:
 *   1. ---dossier\n{JSON or YAML}\n---  (dossier-specific delimiter)
 *   2. ---\n{YAML}\n---                 (standard markdown frontmatter)
 */

import matter from 'gray-matter';
import type { DossierFrontmatter, ParsedDossier } from './types';
import { getErrorMessage } from './utils/errors';
import { readFileIfExists } from './utils/fs';

/** Required fields for a valid dossier frontmatter. */
export const REQUIRED_FIELDS = ['dossier_schema_version', 'title', 'version'] as const;

/** Recommended (but optional) fields. */
export const RECOMMENDED_FIELDS = ['objective', 'risk_level', 'status'] as const;

/** Valid values for the status field (lowercase for case-insensitive comparison). */
export const VALID_STATUSES = ['draft', 'stable', 'deprecated', 'experimental'] as const;

/** Valid values for the risk_level field. */
export const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Parse dossier content into frontmatter and body.
 *
 * Accepts both `---dossier` (JSON/YAML) and standard `---` (YAML) frontmatter.
 */
export function parseDossierContent(content: string): ParsedDossier {
  if (!content || typeof content !== 'string') {
    throw new Error('Invalid dossier format. Content must be a non-empty string.');
  }

  // Normalize dossier-specific delimiters to standard --- for gray-matter
  let normalized = content;
  if (content.startsWith('---dossier')) {
    normalized = '---' + content.slice('---dossier'.length);
  } else if (content.startsWith('---json')) {
    normalized = '---' + content.slice('---json'.length);
  } else if (!content.startsWith('---')) {
    throw new Error(
      'Invalid dossier format. Expected:\n---dossier\n{...}\n---\n[body]\nor standard YAML frontmatter (---)'
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(normalized);
  } catch (err) {
    throw new Error(`Failed to parse frontmatter: ${getErrorMessage(err)}`);
  }

  // Verify we actually got frontmatter data
  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    // Check if there was frontmatter content at all
    const hasDelimiters = /^---\s*\r?\n[\s\S]*?\r?\n---/.test(normalized);
    if (!hasDelimiters) {
      throw new Error(
        'Invalid dossier format. Expected:\n---dossier\n{...}\n---\n[body]\nor standard YAML frontmatter (---)'
      );
    }
  }

  return {
    frontmatter: parsed.data as DossierFrontmatter,
    body: parsed.content,
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
 * Validate required frontmatter fields.
 *
 * Checks for required fields (dossier_schema_version, title, version),
 * and validates enum values for status and risk_level.
 */
export function validateFrontmatter(frontmatter: DossierFrontmatter): string[] {
  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in frontmatter)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate risk_level enum
  if (
    frontmatter.risk_level &&
    !VALID_RISK_LEVELS.includes(
      frontmatter.risk_level.toLowerCase() as (typeof VALID_RISK_LEVELS)[number]
    )
  ) {
    errors.push(
      `Invalid risk_level: ${frontmatter.risk_level}. Must be one of: ${VALID_RISK_LEVELS.join(', ')}`
    );
  }

  // Validate status enum (case-insensitive)
  if (frontmatter.status) {
    const statusLower = String(frontmatter.status).toLowerCase();
    if (!VALID_STATUSES.includes(statusLower as (typeof VALID_STATUSES)[number])) {
      errors.push(
        `Invalid status: ${frontmatter.status}. Must be one of: ${VALID_STATUSES.join(', ')}`
      );
    }
  }

  return errors;
}
