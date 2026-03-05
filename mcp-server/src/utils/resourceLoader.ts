/**
 * Resource file loader utility
 * Loads markdown files from the project with logging
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';

/**
 * Load a markdown resource file with logging
 * @param relativePath - Path relative to project root (e.g., 'PROTOCOL.md', 'security/ARCHITECTURE.md')
 * @param resourceName - Human-readable name for logging (e.g., 'protocol', 'security')
 * @returns File content as string
 * @throws Error if file cannot be loaded
 */
export function loadMarkdownResource(relativePath: string, resourceName: string): string {
  const fullPath = join(__dirname, '../../..', relativePath);

  try {
    const content = readFileSync(fullPath, 'utf8');
    logger.debug(`Loaded ${resourceName} resource`, {
      path: fullPath,
      length: content.length,
    });
    return content;
  } catch (err) {
    logger.error(`Failed to load ${relativePath}`, {
      path: fullPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `Failed to load ${relativePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Factory to create resource loader functions
 * @param relativePath - Path relative to project root
 * @param resourceName - Human-readable name for logging
 * @returns A function that loads the resource when called
 */
export const createResourceLoader =
  (relativePath: string, resourceName: string): (() => string) =>
  (): string =>
    loadMarkdownResource(relativePath, resourceName);
