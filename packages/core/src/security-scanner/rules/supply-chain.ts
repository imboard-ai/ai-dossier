import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns for supply chain attacks — fake prerequisites, hook exploitation,
 * package confusion, and CSV injection.
 */
const SUPPLY_CHAIN_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Installing packages from suspicious or unqualified sources
  {
    pattern:
      /(?:npm\s+install|pip\s+install|gem\s+install|go\s+get|cargo\s+install)\s+.*(?:--registry|--index-url|--extra-index-url|--trusted-host)\s+https?:\/\//g,
    description: 'Package installation from custom/untrusted registry',
  },
  // Git hooks injection (pre-commit, post-checkout, etc.)
  {
    pattern:
      /\.git\/hooks\/(?:pre-commit|post-commit|pre-push|post-checkout|pre-receive|post-receive|prepare-commit-msg)/g,
    description: 'Git hook file reference (potential hook exploitation)',
  },
  // npm scripts that run arbitrary commands
  {
    pattern:
      /["'](?:preinstall|postinstall|preuninstall|postuninstall|prepublish|prepare)["']\s*:\s*["'][^"']*(?:curl|wget|bash|sh|node\s+-e|python\s+-c)[^"']*["']/g,
    description: 'npm lifecycle script with shell/network command',
  },
  // CSV injection patterns (formulas that execute when opened in spreadsheets)
  {
    pattern: /(?:^|[,|;])\s*[=+@-]\s*(?:cmd|system|exec|call)\s*\(/gm,
    description: 'CSV injection formula (potential code execution in spreadsheets)',
  },
  // Typosquatting indicators — instructions to install packages with unusual names
  {
    pattern:
      /(?:npm\s+install|pip\s+install)\s+(?:[a-z]+-[a-z]+-[a-z]+-[a-z]+|[a-z]{1,3}-[a-z]+)\s/g,
    description:
      'Package installation with potentially typosquatted name (very short or heavily hyphenated)',
  },
  // Makefile or shell script downloading and executing
  {
    pattern: /(?:make|\.\/\w+\.sh)\b.*&&.*(?:curl|wget)\s+.*\|\s*(?:ba)?sh/g,
    description: 'Build script downloading and executing remote code',
  },
  // npm/pip install from git URL (bypasses registry security)
  {
    pattern:
      /(?:npm\s+install|pip\s+install)\s+(?:git\+)?https?:\/\/(?!github\.com\/|gitlab\.com\/|bitbucket\.org\/)[^\s]+/g,
    description: 'Package installation from non-standard git URL',
  },
];

export const supplyChainRule: SecurityRule = {
  id: 'supply-chain',
  category: 'supply-chain',
  description:
    'Detects supply chain attack patterns — untrusted registries, hook exploitation, CSV injection',
  defaultSeverity: 'medium',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of SUPPLY_CHAIN_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'supply-chain',
          'supply-chain',
          description,
          'medium'
        )
      );
    }

    return findings;
  },
};
