import { parseCodeBlockRanges } from '../code-block-context';
import { matchPattern } from '../match-utils';
import type { SecurityFinding, SecurityRule } from '../types';

/**
 * Patterns that indicate prompt injection — attempts to insert hidden instructions
 * that an LLM would interpret as system/user directives.
 */
const PROMPT_INJECTION_PATTERNS: { pattern: RegExp; description: string }[] = [
  // HTML comment directives
  {
    pattern: /<!--\s*(system|instruction|ignore|override|forget|disregard|new\s+task)[\s\S]*?-->/gi,
    description: 'HTML comment containing directive keywords',
  },
  // Explicit system prompt injection markers
  {
    pattern: /\[SYSTEM\]|\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/gi,
    description: 'LLM chat template markers (system/inst delimiters)',
  },
  // Attempts to redefine the assistant identity
  {
    pattern:
      /you\s+are\s+(?:now|a\s+new|no\s+longer)\b|from\s+now\s+on,?\s+(?:you|ignore|forget)/gi,
    description: 'Identity override attempt',
  },
  // "Ignore previous" family
  {
    pattern:
      /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+(?:instructions?|rules?|context|prompts?|constraints?)/gi,
    description: 'Instruction override attempt ("ignore previous...")',
  },
  // Hidden text via HTML attributes
  {
    pattern:
      /<\w+[^>]*\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(?:white|transparent|#fff(?:fff)?))[^"']*["'][^>]*>/gi,
    description: 'HTML element with hidden/invisible styling',
  },
  // Base64-encoded payloads that look like embedded instructions
  {
    pattern: /<!--[\s\S]*?(?:[A-Za-z0-9+/]{40,}={0,2})[\s\S]*?-->/g,
    description: 'HTML comment containing base64-encoded payload',
  },
];

export const promptInjectionRule: SecurityRule = {
  id: 'prompt-injection',
  category: 'prompt-injection',
  description:
    'Detects prompt injection patterns — hidden instructions and system prompt overrides',
  defaultSeverity: 'critical',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description } of PROMPT_INJECTION_PATTERNS) {
      findings.push(
        ...matchPattern(
          context.body,
          pattern,
          codeBlockRanges,
          'prompt-injection',
          'prompt-injection',
          description,
          'critical'
        )
      );
    }

    return findings;
  },
};
