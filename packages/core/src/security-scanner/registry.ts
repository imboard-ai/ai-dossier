import type {
  SecurityFinding,
  SecurityReport,
  SecurityRule,
  SecurityRuleContext,
  SecurityRuleSeverityOverride,
  SecurityScanConfig,
  SecuritySeverity,
} from './types';

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export class SecurityRuleRegistry {
  private rules: Map<string, SecurityRule> = new Map();

  register(rule: SecurityRule): void {
    this.rules.set(rule.id, rule);
  }

  registerAll(rules: SecurityRule[]): void {
    for (const rule of rules) {
      this.register(rule);
    }
  }

  getRules(): SecurityRule[] {
    return Array.from(this.rules.values());
  }

  getRule(id: string): SecurityRule | undefined {
    return this.rules.get(id);
  }

  run(context: SecurityRuleContext, config: SecurityScanConfig): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const minSeverityLevel = SEVERITY_ORDER[config.minSeverity ?? 'info'];

    for (const rule of this.rules.values()) {
      const override: SecurityRuleSeverityOverride | undefined = config.rules[rule.id];

      if (override === 'off') {
        continue;
      }

      const severity: SecuritySeverity = override
        ? (override as SecuritySeverity)
        : rule.defaultSeverity;

      if (SEVERITY_ORDER[severity] < minSeverityLevel) {
        continue;
      }

      const ruleFindings = rule.detect(context);

      for (const f of ruleFindings) {
        // Respect the code-block downgrade: if the rule already lowered the
        // severity for an in-code-block finding, keep that lower severity
        // rather than overriding it with the config/default level.
        const effectiveSeverity = f.inCodeBlock ? f.severity : severity;
        findings.push({ ...f, severity: effectiveSeverity });
      }
    }

    return findings;
  }
}

export function buildReport(findings: SecurityFinding[], file?: string): SecurityReport {
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;
  const lowCount = findings.filter((f) => f.severity === 'low').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  let verdict: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
  if (criticalCount > 0 || highCount > 0) {
    verdict = 'FAIL';
  } else if (mediumCount > 0) {
    verdict = 'WARN';
  }

  return {
    file,
    findings,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    infoCount,
    verdict,
  };
}
