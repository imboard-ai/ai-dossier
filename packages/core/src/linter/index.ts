import { parseDossierContent, parseDossierFile } from '../parser';
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
  const parsed = parseDossierContent(content);
  const resolvedConfig = config || loadLintConfig();
  const registry = createRegistry();

  const context: LintRuleContext = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    raw: parsed.raw,
  };

  const diagnostics = registry.run(context, resolvedConfig);
  return buildResult(diagnostics);
}

export function lintDossierFile(filePath: string, config?: LintConfig): LintResult {
  const parsed = parseDossierFile(filePath);
  const resolvedConfig = config || loadLintConfig();
  const registry = createRegistry();

  const context: LintRuleContext = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    raw: parsed.raw,
  };

  const diagnostics = registry.run(context, resolvedConfig);
  return buildResult(diagnostics, filePath);
}
