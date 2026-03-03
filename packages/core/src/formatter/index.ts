import { readFileSync, writeFileSync } from 'node:fs';
import { formatDossierContent } from './formatter';
import type { FormatOptions, FormatResult } from './types';

export { formatDossierContent } from './formatter';
export * from './types';

export function formatDossierFile(
  filePath: string,
  options?: Partial<FormatOptions>
): FormatResult {
  const content = readFileSync(filePath, 'utf8');
  const result = formatDossierContent(content, options);

  if (result.changed) {
    writeFileSync(filePath, result.formatted, 'utf8');
  }

  return result;
}
