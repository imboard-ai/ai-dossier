import { calculateChecksum } from '../checksum';
import { parseDossierContent } from '../parser';
import type { FormatOptions, FormatResult } from './types';
import { defaultFormatOptions } from './types';

/**
 * Conventional key ordering for dossier frontmatter.
 * Keys not in this list are sorted alphabetically after the known keys.
 * checksum and signature are always last.
 */
const KEY_ORDER: string[] = [
  'dossier_schema_version',
  'title',
  'version',
  'protocol_version',
  'status',
  'last_updated',
  'objective',
  'category',
  'tags',
  'tools_required',
  'estimated_duration',
  'risk_level',
  'risk_factors',
  'requires_approval',
  'destructive_operations',
  'content_scope',
  'external_references',
  'prerequisites',
  'inputs',
  'outputs',
  'relationships',
  'coupling',
  'validation',
  'rollback',
  'authors',
  'license',
  'homepage',
  'repository',
  'custom',
  'mcp_integration',
  // Always last:
  'checksum',
  'signature',
];

function sortFrontmatterKeys(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const knownSet = new Set(KEY_ORDER);

  // Add known keys in order
  for (const key of KEY_ORDER) {
    if (key in frontmatter) {
      sorted[key] = frontmatter[key];
    }
  }

  // Add unknown keys alphabetically
  const unknownKeys = Object.keys(frontmatter)
    .filter((k) => !knownSet.has(k))
    .sort();
  for (const key of unknownKeys) {
    // Insert before checksum/signature
    sorted[key] = frontmatter[key];
  }

  // If we added unknown keys, we need to re-order to ensure checksum/signature are last
  if (unknownKeys.length > 0) {
    const result: Record<string, unknown> = {};
    const tailKeys = ['checksum', 'signature'];

    for (const [k, v] of Object.entries(sorted)) {
      if (!tailKeys.includes(k)) {
        result[k] = v;
      }
    }
    for (const k of tailKeys) {
      if (k in sorted) {
        result[k] = sorted[k];
      }
    }
    return result;
  }

  return sorted;
}

function trimTrailingWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

function ensureFinalNewline(text: string): string {
  if (!text.endsWith('\n')) {
    return `${text}\n`;
  }
  return text;
}

export function formatDossierContent(
  content: string,
  options?: Partial<FormatOptions>
): FormatResult {
  const opts: FormatOptions = { ...defaultFormatOptions, ...options };
  const parsed = parseDossierContent(content);

  let frontmatter: Record<string, unknown> = parsed.frontmatter as Record<string, unknown>;

  if (opts.sortKeys) {
    frontmatter = sortFrontmatterKeys(frontmatter);
  }

  // Normalize body: trim trailing whitespace per line, then trim trailing newlines from body
  const body = trimTrailingWhitespace(parsed.body).replace(/\n+$/, '');

  // Update checksum if enabled
  if (opts.updateChecksum && frontmatter.checksum) {
    const checksumObj = frontmatter.checksum as Record<string, unknown>;
    if (checksumObj && typeof checksumObj === 'object') {
      const newHash = calculateChecksum(body);
      frontmatter.checksum = { ...checksumObj, hash: newHash };
    }
  }

  // Serialize frontmatter with controlled indentation
  const jsonStr = JSON.stringify(frontmatter, null, opts.indent);

  // Build the formatted output
  let result = `---dossier\n${jsonStr}\n---\n${body}`;

  // Ensure final newline
  result = ensureFinalNewline(result);

  return {
    formatted: result,
    changed: result !== content,
  };
}
