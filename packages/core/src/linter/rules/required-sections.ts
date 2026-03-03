import type { LintRule } from '../types';

export const requiredSectionsRule: LintRule = {
  id: 'required-sections',
  description: 'Markdown body should contain at least one ## heading',
  defaultSeverity: 'warning',
  run(context) {
    const body = context.body;

    if (!body || body.trim().length === 0) {
      return [
        {
          ruleId: 'required-sections',
          severity: 'warning',
          message: 'Dossier body is empty — add markdown content with ## sections',
        },
      ];
    }

    const headingRegex = /^##\s+.+/m;
    if (!headingRegex.test(body)) {
      return [
        {
          ruleId: 'required-sections',
          severity: 'warning',
          message: 'Dossier body has no ## headings — add sections to organize content',
        },
      ];
    }

    return [];
  },
};
