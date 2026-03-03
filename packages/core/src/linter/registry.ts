import type {
  LintConfig,
  LintDiagnostic,
  LintRule,
  LintRuleContext,
  LintSeverity,
  RuleSeverityOverride,
} from './types';

export class LintRuleRegistry {
  private rules: Map<string, LintRule> = new Map();

  register(rule: LintRule): void {
    this.rules.set(rule.id, rule);
  }

  registerAll(rules: LintRule[]): void {
    for (const rule of rules) {
      this.register(rule);
    }
  }

  getRules(): LintRule[] {
    return Array.from(this.rules.values());
  }

  getRule(id: string): LintRule | undefined {
    return this.rules.get(id);
  }

  run(context: LintRuleContext, config: LintConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];

    for (const rule of this.rules.values()) {
      const override: RuleSeverityOverride | undefined = config.rules[rule.id];

      if (override === 'off') {
        continue;
      }

      const severity: LintSeverity = override ? (override as LintSeverity) : rule.defaultSeverity;

      const ruleDiagnostics = rule.run(context);

      for (const d of ruleDiagnostics) {
        diagnostics.push({ ...d, severity });
      }
    }

    return diagnostics;
  }
}
