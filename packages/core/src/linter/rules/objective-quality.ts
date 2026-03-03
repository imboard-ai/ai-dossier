import type { LintRule } from '../types';

export const objectiveQualityRule: LintRule = {
  id: 'objective-quality',
  description: 'Objective should be a clear, concise statement',
  defaultSeverity: 'info',
  run(context) {
    const objective = context.frontmatter.objective;
    const diagnostics = [];

    if (!objective) {
      return [];
    }

    if (objective.length < 20) {
      diagnostics.push({
        ruleId: 'objective-quality',
        severity: 'info' as const,
        message: `Objective is very short (${objective.length} chars) — consider being more descriptive`,
        field: 'objective',
      });
    }

    if (objective.length > 300) {
      diagnostics.push({
        ruleId: 'objective-quality',
        severity: 'info' as const,
        message: `Objective is very long (${objective.length} chars) — consider being more concise (1-3 sentences)`,
        field: 'objective',
      });
    }

    // Check if objective starts with a verb (common best practice)
    const firstWord = objective.split(/\s+/)[0]?.toLowerCase();
    const commonNonVerbs = ['the', 'this', 'a', 'an', 'it', 'my'];
    if (firstWord && commonNonVerbs.includes(firstWord)) {
      diagnostics.push({
        ruleId: 'objective-quality',
        severity: 'info' as const,
        message:
          'Objective should start with a verb (e.g., "Configure...", "Deploy...", "Set up...")',
        field: 'objective',
      });
    }

    return diagnostics;
  },
};
