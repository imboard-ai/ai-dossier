import type { FrontmatterShape } from '../spec-shape';
import type { DossierFrontmatter } from '../types';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintDiagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  field?: string;
}

export interface LintRuleContext {
  frontmatter: DossierFrontmatter;
  body: string;
  raw: string;
  /** On-disk layout; absent when a caller builds a context by hand. */
  shape?: FrontmatterShape;
  /** Frontmatter exactly as it sits on disk (spec-shaped files keep `metadata`). */
  rawFrontmatter?: Record<string, unknown>;
}

export interface LintRule {
  id: string;
  description: string;
  defaultSeverity: LintSeverity;
  run(context: LintRuleContext): LintDiagnostic[];
}

export type RuleSeverityOverride = LintSeverity | 'off';

export interface LintConfig {
  rules: Record<string, RuleSeverityOverride>;
}

export interface LintResult {
  file?: string;
  diagnostics: LintDiagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}
