import type { DossierFrontmatter } from '@ai-dossier/core';
import { parseDossierContent } from '@ai-dossier/core';
import { MAX_NAME_LENGTH, MAX_NAMESPACE_DEPTH } from './constants';
import type { DossierValidation, NamespaceValidation } from './types';

/**
 * Parse frontmatter from dossier content.
 * Delegates to @ai-dossier/core's parseDossierContent.
 */
export function parseFrontmatter(content: string): {
  frontmatter: DossierFrontmatter;
  body: string;
} {
  const result = parseDossierContent(content);
  return { frontmatter: result.frontmatter, body: result.body };
}

/**
 * Validate dossier has required fields for registry publishing.
 */
export function validateDossier(frontmatter: DossierFrontmatter): DossierValidation {
  const errors: string[] = [];

  const required = ['name', 'title', 'version'] as const;
  for (const field of required) {
    if (!frontmatter[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (frontmatter.name) {
    if (typeof frontmatter.name !== 'string') {
      errors.push(`Name must be a string, got ${typeof frontmatter.name}`);
    } else {
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(frontmatter.name)) {
        errors.push(
          `Invalid name "${frontmatter.name}": must be lowercase alphanumeric with hyphens, cannot start/end with hyphen`
        );
      }
      if (frontmatter.name.length > MAX_NAME_LENGTH) {
        errors.push(
          `Name too long (${frontmatter.name.length} chars): must be ${MAX_NAME_LENGTH} characters or less`
        );
      }
    }
  }

  if (frontmatter.version) {
    if (typeof frontmatter.version !== 'string') {
      errors.push(
        `Version must be a string, got ${typeof frontmatter.version} (use quotes: version: "1.0.0")`
      );
    } else if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(frontmatter.version)) {
      errors.push(`Invalid version "${frontmatter.version}": must be in semver format (x.y.z)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function buildFullName(namespace: string, name: string): string {
  const normalizedNamespace = namespace.replace(/\/+$/, '');
  return `${normalizedNamespace}/${name}`;
}

export function getRootNamespace(namespace: string): string {
  return namespace.split('/')[0];
}

export function validateNamespace(namespace: string): NamespaceValidation {
  if (!namespace) {
    return { valid: false, error: 'Namespace is required' };
  }

  if (namespace.includes('..')) {
    return { valid: false, error: 'Invalid namespace: contains ..' };
  }

  const segments = namespace.split('/');
  if (segments.length > MAX_NAMESPACE_DEPTH) {
    return { valid: false, error: `Namespace too deep (max ${MAX_NAMESPACE_DEPTH} levels)` };
  }

  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(segment)) {
      return { valid: false, error: `Invalid namespace segment: ${segment}` };
    }
  }

  return { valid: true, error: null };
}
