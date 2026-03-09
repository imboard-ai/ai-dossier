import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns that attempt to hijack agent behavior — overriding system instructions,
 * granting autonomy, or suppressing safety checks.
 */
const AGENT_HIJACKING_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Attempts to override system instructions
  {
    pattern: /(?:new|updated|revised|real)\s+system\s+(?:prompt|instructions?|message|directive)/gi,
    description: 'Attempt to inject new system instructions',
  },
  // Granting unrestricted autonomy
  {
    pattern:
      /(?:you\s+(?:have|are\s+granted|now\s+have)\s+)?(?:full|unrestricted|unlimited|complete)\s+(?:access|autonomy|control|permissions?|authority)/gi,
    description: 'Attempt to grant unrestricted autonomy/permissions',
  },
  // Suppressing safety checks
  {
    pattern:
      /(?:skip|bypass|disable|ignore|turn\s+off|suppress)\s+(?:safety|security|verification|validation|approval|confirmation|checks?|guards?|filters?)/gi,
    description: 'Attempt to suppress safety/security checks',
  },
  // Role reassignment
  {
    pattern:
      /(?:act\s+as|pretend\s+(?:to\s+be|you(?:'re| are))|roleplay\s+as|switch\s+(?:to|into)\s+(?:a\s+)?(?:root|admin|superuser|developer|DAN|jailbr))/gi,
    description: 'Role reassignment / jailbreak attempt',
  },
  // "Do anything now" (DAN) style jailbreaks
  {
    pattern: /\bDAN\s+(?:mode|prompt|jailbreak)\b|do\s+anything\s+now/gi,
    description: 'DAN-style jailbreak pattern',
  },
  // Instruction to not follow rules
  {
    pattern:
      /(?:don'?t|do\s+not|never)\s+(?:follow|obey|adhere\s+to|comply\s+with)\s+(?:the\s+)?(?:rules?|guidelines?|policies?|restrictions?|constraints?)/gi,
    description: 'Instruction to not follow rules/guidelines',
  },
];

export const agentHijackingRule: SecurityRule = {
  id: 'agent-hijacking',
  category: 'agent-hijacking',
  description:
    'Detects attempts to hijack agent behavior — system instruction overrides and autonomy escalation',
  defaultSeverity: 'critical',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of AGENT_HIJACKING_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'agent-hijacking',
          'agent-hijacking',
          description,
          'critical'
        )
      );
    }

    return findings;
  },
};
