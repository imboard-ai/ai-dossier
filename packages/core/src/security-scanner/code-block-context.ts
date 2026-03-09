/**
 * Utilities for detecting whether content appears inside fenced code blocks.
 *
 * Findings inside code blocks are downgraded in confidence because the content
 * is illustrative/documentary rather than executable instructions.
 */

export interface CodeBlockRange {
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
}

/**
 * Parse all fenced code block ranges from a markdown body.
 * Supports ``` and ~~~ fences per CommonMark spec.
 */
export function parseCodeBlockRanges(body: string): CodeBlockRange[] {
  const lines = body.split('\n');
  const ranges: CodeBlockRange[] = [];
  let openFenceLine: number | null = null;
  let openFenceChar: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Check for opening or closing fence
    const backtickMatch = trimmed.match(/^(`{3,})/);
    const tildeMatch = trimmed.match(/^(~{3,})/);
    const fenceMatch = backtickMatch || tildeMatch;

    if (fenceMatch) {
      const fenceChar = backtickMatch ? '`' : '~';
      const fenceLen = fenceMatch[1].length;

      if (openFenceLine === null) {
        // Opening a new code block
        openFenceLine = i + 1; // 1-based
        openFenceChar = fenceChar;
      } else if (fenceChar === openFenceChar && fenceLen >= 3) {
        // Closing the current code block (must use same fence character)
        ranges.push({ startLine: openFenceLine, endLine: i + 1 });
        openFenceLine = null;
        openFenceChar = null;
      }
    }
  }

  // If a fence was never closed, treat everything from the opening to EOF as a code block
  if (openFenceLine !== null) {
    ranges.push({ startLine: openFenceLine, endLine: lines.length });
  }

  return ranges;
}

/**
 * Check whether a given 1-based line number falls inside any fenced code block.
 */
export function isLineInCodeBlock(line: number, ranges: CodeBlockRange[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}

/**
 * Get the 1-based line number for a character offset in a string.
 */
export function getLineNumber(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
    }
  }
  return line;
}
