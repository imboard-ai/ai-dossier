import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * URL shortener and redirect service domains that can disguise malicious destinations.
 */
const URL_SHORTENER_DOMAINS = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'adf.ly',
  'bl.ink',
  'lnkd.in',
  'soo.gd',
  'rb.gy',
  's.id',
  'v.gd',
  'clck.ru',
  'shorturl.at',
  'cutt.ly',
];

/**
 * Patterns for URL-based threats — shorteners, punycode, suspicious TLDs,
 * and IP-based URLs that may disguise malicious destinations.
 */
const URL_THREAT_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Punycode domains (internationalized domain names that can mimic legitimate domains)
  {
    pattern: /https?:\/\/xn--[a-z0-9-]+\.[a-z]{2,}/gi,
    description: 'Punycode domain (potential homograph attack)',
  },
  // IP address URLs (decimal)
  {
    pattern: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s]*)?/g,
    description: 'IP-address URL (no domain name — potential evasion)',
  },
  // IP address URLs (decimal-encoded single integer, e.g., http://2130706433)
  {
    pattern: /https?:\/\/\d{8,10}(?:\/[^\s]*)?/g,
    description: 'Decimal-encoded IP URL (obfuscated destination)',
  },
  // Hex-encoded URL
  {
    pattern: /https?:\/\/0x[0-9a-fA-F]+(?:\/[^\s]*)?/g,
    description: 'Hex-encoded IP URL (obfuscated destination)',
  },
  // URLs with excessive redirects via query params
  {
    pattern:
      /https?:\/\/[^\s]*(?:redirect|redir|goto|next|return|url|continue|destination)\s*=\s*https?(?:%3A|:)/gi,
    description: 'URL with redirect parameter (potential open redirect)',
  },
  // URLs with @ symbol (credential stuffing in URL)
  {
    pattern: /https?:\/\/[^@\s]+@[^@\s]+\.[a-z]{2,}/gi,
    description: 'URL with embedded credentials (user@host format)',
  },
];

export const urlThreatsRule: SecurityRule = {
  id: 'url-threats',
  category: 'url-threats',
  description:
    'Detects URL-based threats — shorteners, punycode domains, IP-based URLs, open redirects',
  defaultSeverity: 'medium',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    // Check for URL shorteners
    const shortenerPattern = new RegExp(
      `https?:\\/\\/(?:${URL_SHORTENER_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})\\/[^\\s"')<]+`,
      'gi'
    );

    findings.push(
      ...matchPattern(
        context.body,
        shortenerPattern,
        codeBlockRanges,
        'url-threats',
        'url-threats',
        'Shortened URL (destination unknown — could disguise malicious target)',
        'medium'
      )
    );

    // Check other URL threat patterns
    for (const { pattern, description } of URL_THREAT_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'url-threats',
          'url-threats',
          description,
          'medium'
        )
      );
    }

    return findings;
  },
};
