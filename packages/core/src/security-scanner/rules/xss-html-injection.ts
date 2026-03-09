import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns for XSS and HTML injection attacks in markdown.
 * These detect script tags, event handlers, and dangerous URI schemes
 * that could execute code when rendered.
 */
const XSS_HTML_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Script tags (including obfuscated variants)
  {
    pattern: /<\/?script\b[^>]*>/gi,
    description: 'Script tag detected',
  },
  // Event handler attributes (onclick, onerror, onload, etc.)
  {
    pattern: /<\w+[^>]*\bon\w+\s*=\s*["'][^"']*["'][^>]*>/gi,
    description: 'HTML element with inline event handler',
  },
  // javascript: URI scheme
  {
    pattern: /(?:href|src|action|formaction|data)\s*=\s*["']?\s*javascript\s*:/gi,
    description: 'JavaScript URI scheme in HTML attribute',
  },
  // data: URI with script content
  {
    pattern: /(?:href|src)\s*=\s*["']?\s*data\s*:\s*text\/html/gi,
    description: 'Data URI with HTML content (potential XSS)',
  },
  // Markdown link with javascript: URI
  {
    pattern: /\[[^\]]*\]\(\s*javascript\s*:[^)]*\)/gi,
    description: 'Markdown link with javascript: URI',
  },
  // iframe injection
  {
    pattern: /<iframe\b[^>]*>/gi,
    description: 'Iframe injection',
  },
  // object/embed tags (can execute arbitrary content)
  {
    pattern: /<(?:object|embed|applet)\b[^>]*>/gi,
    description: 'Object/embed/applet tag (potential code execution)',
  },
  // SVG with script or event handlers
  {
    pattern: /<svg\b[^>]*>[\s\S]*?(?:<script|on\w+=)/gi,
    description: 'SVG element with embedded script or event handler',
  },
  // CSS expression/behavior (IE-specific but still relevant for detection)
  {
    pattern: /expression\s*\([^)]*\)|behavior\s*:\s*url\s*\(/gi,
    description: 'CSS expression or behavior (potential code execution)',
  },
  // Meta refresh redirect
  {
    pattern: /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
    description: 'Meta refresh redirect',
  },
  // Form tags (potential for phishing)
  {
    pattern: /<form\b[^>]*action\s*=\s*["']https?:\/\/[^"']*["'][^>]*>/gi,
    description: 'HTML form with external action URL (potential phishing)',
  },
];

export const xssHtmlInjectionRule: SecurityRule = {
  id: 'xss-html-injection',
  category: 'xss-html-injection',
  description: 'Detects XSS and HTML injection — script tags, event handlers, dangerous URIs',
  defaultSeverity: 'high',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of XSS_HTML_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'xss-html-injection',
          'xss-html-injection',
          description,
          'high'
        )
      );
    }

    return findings;
  },
};
