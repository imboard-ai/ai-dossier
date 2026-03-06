import type { LintRule } from '../types';

export const riskLevelConsistencyRule: LintRule = {
  id: 'risk-level-consistency',
  description:
    'Risk level should be consistent with destructive operations and external references',
  defaultSeverity: 'warning',
  run(context) {
    const { risk_level, destructive_operations, external_references, risk_factors } =
      context.frontmatter;
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

    if (Array.isArray(external_references) && external_references.length > 0) {
      if (!Array.isArray(risk_factors) || !risk_factors.includes('network_access')) {
        diagnostics.push({
          ruleId: 'risk-level-consistency',
          severity: 'warning' as const,
          message:
            'external_references declared but risk_factors does not include "network_access"',
          field: 'risk_factors',
        });
      }
    }

    return diagnostics;
  },
};
