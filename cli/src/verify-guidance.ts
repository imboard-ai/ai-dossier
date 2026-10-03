/**
 * Actionable guidance printed under a failed integrity or authenticity check.
 *
 * Pure functions returning lines, so the wording is unit-testable and the
 * commands named here stay in one place. Every command mentioned exists in
 * this CLI (`checksum --update`, `sign`, `pull --force`, `run --fresh`,
 * `keys add`).
 */

export interface ChecksumFailure {
  /** File path or URL that was verified. */
  input: string;
  /** Hash declared in frontmatter (undefined when the dossier declares none). */
  expected?: string;
  /** Hash computed from the body. */
  actual?: string;
}

function isUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

export function checksumFailureGuidance(f: ChecksumFailure): string[] {
  const lines: string[] = [];
  if (f.expected !== undefined || f.actual !== undefined) {
    lines.push(`Expected: ${f.expected ?? '(none declared)'}`);
    lines.push(`Actual:   ${f.actual ?? '(unknown)'}`);
    lines.push('');
  }
  lines.push('Possible causes:');
  lines.push('  - The file was edited after it was checksummed (the body changed)');
  lines.push('  - A corrupted or truncated download, or a stale cached copy');
  lines.push('  - The content was tampered with in transit or at the source');
  lines.push('');
  lines.push('Fix:');
  if (isUrl(f.input)) {
    lines.push(`  - Download it again: ai-dossier verify ${f.input}`);
  } else {
    lines.push('  - Fetched from the registry? Refresh the copy: ai-dossier pull --force <name>');
    lines.push('    (or: ai-dossier run <name> --fresh)');
  }
  lines.push(
    `  - Your own dossier? Recompute and re-sign it: ai-dossier checksum ${f.input} --update`
  );
  lines.push(`    then ai-dossier sign ${f.input}`);
  lines.push('  - Otherwise do not run it: the content differs from what the author published.');
  return lines;
}

export interface SignatureFailure {
  input: string;
  /** Underlying error from verification, when there is one. */
  error?: string;
}

export function signatureFailureGuidance(f: SignatureFailure): string[] {
  const lines: string[] = [];
  if (f.error) {
    lines.push(`Error: ${f.error}`);
    lines.push('');
  }
  lines.push('Possible causes:');
  lines.push('  - The body or frontmatter changed after the dossier was signed');
  lines.push('  - The signature block is malformed or was signed by a different tool version');
  lines.push('  - The content was tampered with in transit or at the source');
  lines.push('');
  lines.push('Fix:');
  if (isUrl(f.input)) {
    lines.push(`  - Download it again: ai-dossier verify ${f.input}`);
  } else {
    lines.push('  - Fetched from the registry? Refresh the copy: ai-dossier pull --force <name>');
  }
  lines.push(`  - Your own dossier? Re-sign it: ai-dossier sign ${f.input}`);
  lines.push('  - To trust a signer, see the hint above, or run: ai-dossier keys list');
  return lines;
}

/** A dossier's declared risk, as `run` shows it before asking for confirmation. */
export function riskSummaryLines(fm: { risk_level?: string; risk_factors?: unknown }): string[] {
  const factors = Array.isArray(fm.risk_factors) ? fm.risk_factors.map(String) : [];
  const lines = [`Risk level: ${fm.risk_level ?? 'unspecified'}`];
  if (factors.length > 0) {
    lines.push('This dossier declares it may:');
    for (const factor of factors) lines.push(`  - ${factor.replace(/_/g, ' ')}`);
  }
  return lines;
}

/** Whether `run` should stop and ask before executing this dossier. */
export function needsRiskConfirmation(fm: {
  risk_level?: string;
  risk_factors?: unknown;
}): boolean {
  const level = (fm.risk_level ?? '').toLowerCase();
  return level === 'high' || level === 'critical';
}
