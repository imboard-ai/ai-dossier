import { parseDossierContent, parseDossierFile } from '../parser';
import { buildReport, SecurityRuleRegistry } from './registry';
import { defaultSecurityRules } from './rules';
import type { SecurityReport, SecurityRuleContext, SecurityScanConfig } from './types';

export { buildReport, SecurityRuleRegistry } from './registry';
export {
  agentHijackingRule,
  dangerousExecutionRule,
  dataExfiltrationRule,
  defaultSecurityRules,
  promptInjectionRule,
  supplyChainRule,
  unicodeAttacksRule,
  urlThreatsRule,
  xssHtmlInjectionRule,
} from './rules';
export * from './types';

const defaultConfig: SecurityScanConfig = { rules: {} };

function createRegistry(): SecurityRuleRegistry {
  const registry = new SecurityRuleRegistry();
  registry.registerAll(defaultSecurityRules);
  return registry;
}

/**
 * Scan a dossier's markdown body for security threats.
 *
 * Accepts raw dossier content (frontmatter + body) as a string.
 */
export function scanDossier(content: string, config?: SecurityScanConfig): SecurityReport {
  const parsed = parseDossierContent(content);
  const resolvedConfig = config ?? defaultConfig;
  const registry = createRegistry();

  const context: SecurityRuleContext = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    raw: parsed.raw,
  };

  const findings = registry.run(context, resolvedConfig);
  return buildReport(findings);
}

/**
 * Scan a dossier file at the given path for security threats.
 */
export function scanDossierFile(filePath: string, config?: SecurityScanConfig): SecurityReport {
  const parsed = parseDossierFile(filePath);
  const resolvedConfig = config ?? defaultConfig;
  const registry = createRegistry();

  const context: SecurityRuleContext = {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    raw: parsed.raw,
  };

  const findings = registry.run(context, resolvedConfig);
  return buildReport(findings, filePath);
}

/**
 * Scan raw markdown text (without dossier frontmatter) for security threats.
 *
 * Useful for scanning arbitrary markdown files that are not dossiers.
 */
export function scanMarkdown(markdown: string, config?: SecurityScanConfig): SecurityReport {
  const resolvedConfig = config ?? defaultConfig;
  const registry = createRegistry();

  const context: SecurityRuleContext = {
    frontmatter: {} as SecurityRuleContext['frontmatter'],
    body: markdown,
    raw: markdown,
  };

  const findings = registry.run(context, resolvedConfig);
  return buildReport(findings);
}
