import {
  collectDeclaredUrls,
  findStaleReferences,
  findUndeclaredUrls,
  scanBodyForUrls,
} from '../../utils/url-scanner';
import type { LintDiagnostic, LintRule } from '../types';

export const externalReferencesDeclaredRule: LintRule = {
  id: 'external-references-declared',
  description: 'External URLs in body must be declared in external_references',
  defaultSeverity: 'error',
  run(context) {
    const { frontmatter, body } = context;
    const diagnostics: LintDiagnostic[] = [];

    const bodyUrls = scanBodyForUrls(body);
    if (bodyUrls.length === 0) {
      return diagnostics;
    }

    const declaredUrls = collectDeclaredUrls(frontmatter);
    const undeclaredUrls = findUndeclaredUrls(bodyUrls, declaredUrls);

    for (const url of undeclaredUrls) {
      diagnostics.push({
        ruleId: 'external-references-declared',
        severity: 'error' as const,
        message: `Undeclared external URL in body: ${url} — add it to external_references`,
        field: 'external_references',
      });
    }

    if (bodyUrls.length > 0 && frontmatter.content_scope !== 'references-external') {
      diagnostics.push({
        ruleId: 'external-references-declared',
        severity: 'error' as const,
        message: `Body contains ${bodyUrls.length} external URL(s) but content_scope is not "references-external"`,
        field: 'content_scope',
      });
    }

    if (Array.isArray(frontmatter.external_references)) {
      const stale = findStaleReferences(frontmatter.external_references, bodyUrls);
      for (const ref of stale) {
        diagnostics.push({
          ruleId: 'external-references-declared',
          severity: 'info' as const,
          message: `Declared external reference not found in body (possibly stale): ${ref.url}`,
          field: 'external_references',
        });
      }
    }

    return diagnostics;
  },
};
