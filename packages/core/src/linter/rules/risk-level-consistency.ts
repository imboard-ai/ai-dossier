import type { LintRule } from '../types';

export const riskLevelConsistencyRule: LintRule = {
  id: 'risk-level-consistency',
  description: 'Risk level should be consistent with destructive operations',
  defaultSeverity: 'warning',
  run(context) {
    const { risk_level, destructive_operations } = context.frontmatter;
    const diagnostics = [];

    if (
      risk_level === 'low' &&
      Array.isArray(destructive_operations) &&
      destructive_operations.length > 0
    ) {
      diagnostics.push({
        ruleId: 'risk-level-consistency',
        severity: 'warning' as const,
        message: `risk_level is "low" but ${destructive_operations.length} destructive operation(s) declared — consider "medium" or higher`,
        field: 'risk_level',
      });
    }

    return diagnostics;
  },
};
