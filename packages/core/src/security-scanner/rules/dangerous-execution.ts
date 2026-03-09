import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns for dangerous shell commands and code execution.
 * These detect actual commands that could be destructive or facilitate code injection.
 */
const DANGEROUS_EXECUTION_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Recursive force removal
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/g,
    description: 'Recursive force delete (rm -rf)',
  },
  // Pipe to shell — curl/wget piped to bash/sh
  {
    pattern:
      /(?:curl|wget)\s+[^\n|]*\|\s*(?:ba)?sh\b|(?:curl|wget)\s+[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh/g,
    description: 'Remote script execution (curl/wget piped to shell)',
  },
  // eval with variable/dynamic content
  {
    pattern: /\beval\s*\(\s*["`$]|\beval\s+["'`$]/g,
    description: 'Dynamic eval execution',
  },
  // chmod 777 (world-writable)
  {
    pattern: /\bchmod\s+777\b/g,
    description: 'Setting world-writable permissions (chmod 777)',
  },
  // dd writing to block devices
  {
    pattern: /\bdd\s+.*\bof\s*=\s*\/dev\//g,
    description: 'Direct block device write (dd of=/dev/...)',
  },
  // mkfs (format filesystem)
  {
    pattern: /\bmkfs\b/g,
    description: 'Filesystem format command (mkfs)',
  },
  // Fork bomb patterns
  {
    pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/g,
    description: 'Fork bomb',
  },
  // Python/Node one-liner execution
  {
    pattern: /python[23]?\s+-c\s+['"].*(?:exec|eval|import\s+os|subprocess|__import__)/g,
    description: 'Python one-liner with dangerous imports/execution',
  },
  // Encoded/obfuscated command execution
  {
    pattern: /\bbase64\s+-d\b.*\|\s*(?:ba)?sh/g,
    description: 'Base64-decoded payload piped to shell',
  },
  // Overwriting critical system files
  {
    pattern: />\s*\/etc\/(?:passwd|shadow|sudoers|hosts|crontab)/g,
    description: 'Overwriting critical system file',
  },
  // Reverse shell patterns
  {
    pattern:
      /\bbash\s+-i\s+>&?\s*\/dev\/tcp\/|\bnc\s+.*-e\s+\/bin\/(?:ba)?sh|\bsocat\b.*\bexec\b.*\/bin\/(?:ba)?sh/g,
    description: 'Reverse shell pattern',
  },
  // crontab injection
  {
    pattern: /(?:echo|printf)\s+.*\|\s*crontab/g,
    description: 'Crontab injection via pipe',
  },
];

export const dangerousExecutionRule: SecurityRule = {
  id: 'dangerous-execution',
  category: 'dangerous-execution',
  description: 'Detects dangerous shell commands — rm -rf, curl|sh, eval, reverse shells, etc.',
  defaultSeverity: 'high',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of DANGEROUS_EXECUTION_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'dangerous-execution',
          'dangerous-execution',
          description,
          'high',
          'low'
        )
      );
    }

    return findings;
  },
};
