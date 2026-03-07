import type { LintRule } from '../types';

export const toolsCheckCommandRule: LintRule = {
  id: 'tools-check-command',
  description: 'tools_required entries should have a check_command',
  defaultSeverity: 'warning',
  run(context) {
    const tools = context.frontmatter.tools_required;

    if (!Array.isArray(tools) || tools.length === 0) {
      return [];
    }

    const diagnostics = [];

    for (const tool of tools) {
      if (!tool.check_command) {
        diagnostics.push({
          ruleId: 'tools-check-command',
          severity: 'warning' as const,
          message: `Tool "${tool.name}" is missing check_command — users cannot verify availability`,
          field: 'tools_required',
        });
      }
    }

    return diagnostics;
  },
};
