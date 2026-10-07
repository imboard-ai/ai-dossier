import { parseDossierContent, parseDossierFile } from '../parser';
import { DOSSIER_METADATA_PREFIX, SPEC_TOP_LEVEL_FIELDS } from '../spec-shape';
import type { ParsedDossier } from '../types';
import { loadLintConfig } from './config';
import { LintRuleRegistry } from './registry';
import { defaultRules } from './rules';
import type { LintConfig, LintDiagnostic, LintResult, LintRuleContext } from './types';

export { loadLintConfig } from './config';
export { LintRuleRegistry } from './registry';
export { defaultRules } from './rules';
export * from './types';

function createRegistry(): LintRuleRegistry {
  const registry = new LintRuleRegistry();
  registry.registerAll(defaultRules);
  return registry;
}

const SPEC_TOP_LEVEL = new Set<string>(SPEC_TOP_LEVEL_FIELDS);

/**
 * Rules read the logical (flat) frontmatter, so they name fields like
 * `risk_level`. In a spec-shaped file that field sits at
 * `metadata["dossier.risk_level"]`; the message says so, or the author goes
 * looking for a top-level key that is not there.
 */
function locateOnDisk(diagnostic: LintDiagnostic, shape: ParsedDossier['shape']): LintDiagnostic {
  const field = diagnostic.field;
  if (shape !== 'spec' || !field || diagnostic.ruleId === 'spec-shape') {
    return diagnostic;
  }
  const top = field.split(/[.[]/)[0];
  if (top === 'metadata' || SPEC_TOP_LEVEL.has(top)) {
    return diagnostic;
  }
  // `field` stays the logical name: editors and other consumers map it onto the
  // file themselves. Only the human-readable message gains the on-disk key.
  return {
    ...diagnostic,
    message: `${diagnostic.message} (in metadata["${DOSSIER_METADATA_PREFIX}${top}"])`,
  };
}

function lintParsed(parsed: ParsedDossier, config: LintConfig | undefined): LintDiagnostic[] {
  const resolvedConfig = config || loadLintConfig();
  const registry = createRegistry();

  const context: LintRuleContext = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    raw: parsed.raw,
    shape: parsed.shape,
    rawFrontmatter: parsed.rawFrontmatter,
  };

  return registry.run(context, resolvedConfig).map((d) => locateOnDisk(d, parsed.shape));
}

function buildResult(diagnostics: LintDiagnostic[], file?: string): LintResult {
  return {
    file,
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    infoCount: diagnostics.filter((d) => d.severity === 'info').length,
  };
}

export function lintDossier(content: string, config?: LintConfig): LintResult {
  return buildResult(lintParsed(parseDossierContent(content), config));
}

export function lintDossierFile(filePath: string, config?: LintConfig): LintResult {
  return buildResult(lintParsed(parseDossierFile(filePath), config), filePath);
}
