import { isRecord } from '../state';
import { refuse } from './files';

export function parsePortfolio(raw: unknown, runId: string) {
  if (
    !isRecord(raw) ||
    raw.runId !== runId ||
    typeof raw.disclosure !== 'string' ||
    !Array.isArray(raw.policyCitations) ||
    raw.policyCitations.length > 128
  )
    refuse();
  const policyCitations = raw.policyCitations.map((citation) => {
    if (
      !isRecord(citation) ||
      typeof citation.path !== 'string' ||
      !Number.isSafeInteger(citation.line) ||
      Number(citation.line) < 1 ||
      typeof citation.ruleId !== 'string' ||
      typeof citation.excerpt !== 'string'
    )
      refuse();
    return {
      path: citation.path,
      line: Number(citation.line),
      ruleId: citation.ruleId,
      excerpt: citation.excerpt,
    };
  });
  return { disclosure: raw.disclosure, policyCitations };
}
