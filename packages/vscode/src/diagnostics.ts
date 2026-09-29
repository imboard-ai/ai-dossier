/**
 * Maps @ai-dossier/core validation + lint output onto editor ranges. Pure: takes file text,
 * returns plain objects; extension.ts converts them to vscode.Diagnostic.
 */
import {
  type LintConfig,
  lintDossier,
  parseDossierContent,
  validateFrontmatter,
} from '@ai-dossier/core';
import {
  type FrontmatterBlock,
  findFieldRange,
  lineRange,
  locateFrontmatter,
  type Range,
} from './frontmatter';

export type Severity = 'error' | 'warning' | 'info';

export interface DossierDiagnostic {
  message: string;
  severity: Severity;
  range: Range;
  /** Lint rule id, or 'parse' / 'frontmatter' for non-lint sources. */
  code: string;
}

/** Pulls the `(line:col)` js-yaml appends to parse errors; line is 1-based within the block. */
function parseErrorLine(message: string): number | null {
  const m = message.match(/\((\d+):(\d+)\)/) ?? message.match(/at line (\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * gray-matter reads a `{...}` block as YAML flow syntax, which forgives a lot of broken JSON
 * (`"title": ,` parses to null). When the block is object-shaped, JSON.parse gives the exact
 * syntax error instead. Non-object blocks (YAML inside ---dossier) are left to the core parser.
 */
function strictJsonError(block: FrontmatterBlock): DossierDiagnostic | null {
  const text = block.lines.slice(block.openLine + 1, block.closeLine).join('\n');
  if (!text.trimStart().startsWith('{')) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pos = Number(message.match(/position (\d+)/)?.[1] ?? NaN);
    const rel = Number.isNaN(pos) ? 0 : text.slice(0, pos).split('\n').length - 1;
    return {
      message: `Invalid JSON in frontmatter: ${message}`,
      severity: 'error',
      range: lineRange(block.lines, block.openLine + 1 + rel),
      code: 'parse',
    };
  }
}

function rangeForField(block: FrontmatterBlock, field: string | undefined): Range {
  if (field) {
    const r = findFieldRange(block, field);
    if (r) return r;
  }
  // No key to point at (e.g. a missing required field): anchor on the opener.
  return lineRange(block.lines, block.openLine);
}

export function computeDiagnostics(content: string, lintConfig?: LintConfig): DossierDiagnostic[] {
  const block = locateFrontmatter(content);
  if (!block) {
    return [
      {
        message:
          'No dossier frontmatter found. Expected the file to start with ---dossier (JSON) or --- (YAML).',
        severity: 'error',
        range: lineRange(content.split('\n'), 0),
        code: 'frontmatter',
      },
    ];
  }

  if (block.closeLine === -1) {
    return [
      {
        message: 'Frontmatter is never closed: add a line containing only --- after the metadata.',
        severity: 'error',
        range: lineRange(block.lines, block.openLine),
        code: 'frontmatter',
      },
    ];
  }

  const strict = strictJsonError(block);
  if (strict) return [strict];

  let parsed: ReturnType<typeof parseDossierContent>;
  try {
    parsed = parseDossierContent(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rel = parseErrorLine(message);
    // Error positions count from the first line after the opener.
    const line = rel === null ? block.openLine : Math.min(block.openLine + rel, block.closeLine);
    return [{ message, severity: 'error', range: lineRange(block.lines, line), code: 'parse' }];
  }

  const out: DossierDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: DossierDiagnostic, field?: string) => {
    const key = `${field ?? ''}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  const lint = lintDossier(content, lintConfig ?? { rules: {} });
  for (const d of lint.diagnostics) {
    push(
      {
        message: d.message,
        severity: d.severity,
        range: rangeForField(block, d.field),
        code: d.ruleId,
      },
      d.field
    );
  }

  // validateFrontmatter overlaps the schema rule but also covers case-insensitive enum checks;
  // only add its complaints for fields the lint pass did not already flag.
  const flagged = new Set(lint.diagnostics.filter((x) => x.field).map((x) => x.field));
  for (const msg of validateFrontmatter(parsed.frontmatter)) {
    const field = msg.match(/^(?:Missing required field|Invalid) ([A-Za-z_]+)/)?.[1];
    if (field && flagged.has(field)) continue;
    push(
      { message: msg, severity: 'error', range: rangeForField(block, field), code: 'frontmatter' },
      field
    );
  }

  return out;
}
