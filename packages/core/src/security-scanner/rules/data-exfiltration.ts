import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns that indicate data exfiltration — sending data to external URLs
 * via image tags, tracking pixels, DNS exfil, or webhook-based exfil.
 */
const DATA_EXFILTRATION_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Markdown image with dynamic/parameterized URL (data in query string)
  {
    pattern: /!\[[^\]]*\]\(https?:\/\/[^)]*(?:\$\{|`[^`]*`|\{\{)[^)]*\)/g,
    description: 'Markdown image with dynamic/templated URL (potential data exfiltration)',
  },
  // HTML image with suspicious query parameters suggesting data exfil
  {
    pattern:
      /<img[^>]+src\s*=\s*["']https?:\/\/[^"']*(?:data=|exfil=|payload=|token=|secret=|key=|password=|env=)[^"']*["']/gi,
    description: 'HTML image tag with data exfiltration query parameters',
  },
  // 1x1 tracking pixel (common exfil technique)
  {
    pattern:
      /<img[^>]+(?:width\s*=\s*["']1["'][^>]*height\s*=\s*["']1["']|height\s*=\s*["']1["'][^>]*width\s*=\s*["']1["'])/gi,
    description: 'Tracking pixel (1x1 image)',
  },
  // curl/wget/fetch sending data to external URLs
  {
    pattern: /(?:curl|wget)\s+.*(?:-d\s|--data\s|--post-data\s|--upload-file\s|-F\s).*https?:\/\//g,
    description: 'Sending data to external URL via curl/wget',
  },
  // DNS exfiltration pattern
  {
    pattern: /(?:dig|nslookup|host)\s+[^\s]*\$[{(]|\$\([^)]*\)\.[\w.-]+\.\w{2,}/g,
    description: 'Potential DNS exfiltration (dynamic subdomain query)',
  },
  // Webhook URLs (common exfil destinations)
  {
    pattern:
      /https?:\/\/(?:(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com|burpcollaborator\.net|interact\.sh|canarytokens\.com)[^\s"')<]*)/gi,
    description: 'Webhook or request-capture URL (common exfiltration destination)',
  },
  // Sending environment variables or secrets to external URLs
  {
    pattern:
      /(?:curl|wget|fetch|http\.post|requests\.post)\s*[(\s].*(?:\$\{?\w*(?:SECRET|TOKEN|KEY|PASSWORD|API_KEY|AWS_)\w*\}?|process\.env\.\w+|os\.environ)/gi,
    description: 'Sending environment variables/secrets to external endpoint',
  },
];

export const dataExfiltrationRule: SecurityRule = {
  id: 'data-exfiltration',
  category: 'data-exfiltration',
  description:
    'Detects data exfiltration patterns — image-based exfil, tracking pixels, webhook exfil',
  defaultSeverity: 'high',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of DATA_EXFILTRATION_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'data-exfiltration',
          'data-exfiltration',
          description,
          'high'
        )
      );
    }

    return findings;
  },
};
