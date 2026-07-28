import type { LintDiagnostic, LintRule } from '../types';

/**
 * Risk factors whose consequences are hard to undo — merging to a shared branch,
 * deleting files, changing cloud resources. A dossier declaring one of these is
 * describing a high-consequence action, whatever level it claims.
 */
const HIGH_CONSEQUENCE_FACTORS = ['merges_code', 'deletes_files', 'modifies_cloud_resources'];

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const riskLevelConsistencyRule: LintRule = {
  id: 'risk-level-consistency',
  description:
    'Risk level should be consistent with destructive operations and external references',
  defaultSeverity: 'warning',
  run(context) {
    const { risk_level, destructive_operations, external_references, risk_factors } =
      context.frontmatter;
    const diagnostics: LintDiagnostic[] = [];

    if (
      risk_level === 'low' &&
      Array.isArray(destructive_operations) &&
      destructive_operations.length > 0
    ) {
      diagnostics.push({
        ruleId: 'risk-level-consistency',
        severity: 'warning',
        message: `risk_level is "low" but ${destructive_operations.length} destructive operation(s) declared — consider "medium" or higher`,
        field: 'risk_level',
      });
    }

    // A dossier that declares it merges code, deletes files, or changes cloud
    // resources but rates itself below "high" is under-describing its consequences.
    // This is deliberately silent about requires_approval: running a high-consequence
    // dossier autonomously is a legitimate policy choice, and conflating the two would
    // flag correctly-configured workflows forever.
    if (Array.isArray(risk_factors) && typeof risk_level === 'string') {
      const declared = risk_factors.filter((f) => HIGH_CONSEQUENCE_FACTORS.includes(f as string));
      const rank = RISK_RANK[risk_level.toLowerCase()];
      if (declared.length > 0 && rank !== undefined && rank < RISK_RANK.high) {
        diagnostics.push({
          ruleId: 'risk-level-consistency',
          severity: 'warning',
          message: `risk_level is "${risk_level}" but risk_factors declares ${declared.map((f) => `"${f}"`).join(', ')} — consider "high"`,
          field: 'risk_level',
        });
      }
    }

    if (Array.isArray(external_references) && external_references.length > 0) {
      if (!Array.isArray(risk_factors) || !risk_factors.includes('network_access')) {
        diagnostics.push({
          ruleId: 'risk-level-consistency',
          severity: 'warning',
          message:
            'external_references declared but risk_factors does not include "network_access"',
          field: 'risk_factors',
        });
      }
    }

    return diagnostics;
  },
};
