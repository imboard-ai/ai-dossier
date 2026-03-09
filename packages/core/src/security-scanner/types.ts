import type { DossierFrontmatter } from '../types';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type SecurityCategory =
  | 'prompt-injection'
  | 'agent-hijacking'
  | 'dangerous-execution'
  | 'unicode-attacks'
  | 'data-exfiltration'
  | 'xss-html-injection'
  | 'url-threats'
  | 'supply-chain';

export interface SecurityFinding {
  ruleId: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  message: string;
  /** The matched text or pattern that triggered the finding */
  evidence?: string;
  /** Approximate line number in the body (1-based) */
  line?: number;
  /** Whether the finding is inside a fenced code block (lower confidence) */
  inCodeBlock: boolean;
}

export interface SecurityRuleContext {
  frontmatter: DossierFrontmatter;
  body: string;
  raw: string;
}

export interface SecurityRule {
  id: string;
  category: SecurityCategory;
  description: string;
  defaultSeverity: SecuritySeverity;
  detect(context: SecurityRuleContext): SecurityFinding[];
}

export type SecurityRuleSeverityOverride = SecuritySeverity | 'off';

export interface SecurityScanConfig {
  rules: Record<string, SecurityRuleSeverityOverride>;
  /** Minimum severity to include in results (default: 'info') */
  minSeverity?: SecuritySeverity;
}

export interface SecurityReport {
  file?: string;
  findings: SecurityFinding[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  /** Overall risk verdict */
  verdict: 'PASS' | 'WARN' | 'FAIL';
}
