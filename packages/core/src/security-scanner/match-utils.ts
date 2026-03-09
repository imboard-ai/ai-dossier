/**
 * Shared regex matching utility for security rules.
 *
 * Avoids the `noAssignInExpressions` lint violation by using
 * `matchAll` instead of a `while (match = exec())` loop.
 */

import { type CodeBlockRange, getLineNumber, isLineInCodeBlock } from './code-block-context';
import type { SecurityCategory, SecurityFinding, SecuritySeverity } from './types';

export interface PatternDefinition {
  pattern: RegExp;
  description: string;
}

export interface PatternWithSeverity extends PatternDefinition {
  severity: SecuritySeverity;
}

/**
 * Run a global regex against text and collect all matches as SecurityFindings.
 * Uses `String.matchAll` to avoid assignment-in-expression.
 */
export function matchPattern(
  text: string,
  pattern: RegExp,
  codeBlockRanges: CodeBlockRange[],
  ruleId: string,
  category: SecurityCategory,
  description: string,
  defaultSeverity: SecuritySeverity,
  codeBlockSeverity: SecuritySeverity = 'info'
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Ensure the regex has the global flag for matchAll
  const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

  for (const match of text.matchAll(globalPattern)) {
    const line = getLineNumber(text, match.index ?? 0);
    const inCodeBlock = isLineInCodeBlock(line, codeBlockRanges);

    findings.push({
      ruleId,
      category,
      severity: inCodeBlock ? codeBlockSeverity : defaultSeverity,
      message: `${formatCategory(category)}: ${description}`,
      evidence: match[0].slice(0, 200),
      line,
      inCodeBlock,
    });
  }

  return findings;
}

function formatCategory(category: SecurityCategory): string {
  return category
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
