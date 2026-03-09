import { getLineNumber, isLineInCodeBlock, parseCodeBlockRanges } from '../code-block-context';
import type { SecurityFinding, SecurityRule, SecuritySeverity } from '../types';

/**
 * Detects suspicious Unicode characters that can be used to hide text,
 * create visually misleading content, or smuggle instructions.
 *
 * Note: We use individual character alternation instead of character classes
 * for zero-width characters because some (like ZWJ U+200D) are joiners that
 * compose emoji sequences, and biome's `noMisleadingCharacterClass` rule
 * flags them inside character classes.
 */
const UNICODE_ATTACK_PATTERNS: {
  pattern: RegExp;
  description: string;
  severity: SecuritySeverity;
}[] = [
  // Zero-width characters (ZWSP, ZWNJ, ZWJ, zero-width no-break space)
  // Using alternation instead of character class to avoid noMisleadingCharacterClass
  {
    pattern: /\u200B|\u200C|\u200D|\uFEFF/g,
    description: 'Zero-width character detected (potential hidden text)',
    severity: 'high',
  },
  // Unicode Tags Block (U+E0001-U+E007F) — used for invisible text smuggling
  {
    pattern: /[\u{E0001}-\u{E007F}]/gu,
    description: 'Unicode Tags Block character (invisible text smuggling)',
    severity: 'critical',
  },
  // Right-to-left override/embedding (text direction attacks)
  {
    pattern: /[\u202A-\u202E\u2066-\u2069]/g,
    description: 'Bidirectional text override character (visual spoofing)',
    severity: 'high',
  },
  // Interlinear annotation markers
  {
    pattern: /[\uFFF9-\uFFFB]/g,
    description: 'Interlinear annotation character',
    severity: 'medium',
  },
  // Homoglyph-heavy sequences — Cyrillic/Greek characters in otherwise Latin text
  {
    pattern: /[a-zA-Z]+[\u0400-\u04FF]+|[\u0400-\u04FF]+[a-zA-Z]+/g,
    description: 'Mixed Latin/Cyrillic script (potential homoglyph attack)',
    severity: 'medium',
  },
  // Object replacement character that can hide content
  {
    pattern: /\uFFFC/g,
    description: 'Object replacement character',
    severity: 'low',
  },
];

export const unicodeAttacksRule: SecurityRule = {
  id: 'unicode-attacks',
  category: 'unicode-attacks',
  description:
    'Detects suspicious Unicode characters — zero-width chars, bidi overrides, Tags Block, homoglyphs',
  defaultSeverity: 'high',
  detect(context) {
    const findings: SecurityFinding[] = [];
    const codeBlockRanges = parseCodeBlockRanges(context.body);

    for (const { pattern, description, severity } of UNICODE_ATTACK_PATTERNS) {
      // matchAll requires a fresh regex or one with global flag
      const globalPattern = pattern.global
        ? new RegExp(pattern.source, pattern.flags)
        : new RegExp(pattern.source, `${pattern.flags}g`);

      for (const match of context.body.matchAll(globalPattern)) {
        const line = getLineNumber(context.body, match.index ?? 0);
        const inCodeBlock = isLineInCodeBlock(line, codeBlockRanges);

        findings.push({
          ruleId: 'unicode-attacks',
          category: 'unicode-attacks',
          severity: inCodeBlock ? 'info' : severity,
          message: `Unicode attack: ${description}`,
          evidence: `U+${match[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`,
          line,
          inCodeBlock,
        });
      }
    }

    return findings;
  },
};
