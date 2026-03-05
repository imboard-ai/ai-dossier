import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessVerificationRisk } from '@ai-dossier/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkSignature, downloadFile, parseArgs, verifyDossier } from '../verify-dossier';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('assessVerificationRisk (core)', () => {
  it('should return low risk when checksum passes and no signature', () => {
    const result = assessVerificationRisk(
      'low',
      { passed: true },
      { present: false, verified: false, trusted: false }
    );
    expect(result.level).toBe('low');
    expect(result.recommendation).toBe('ALLOW');
    expect(result.issues).toHaveLength(0);
  });

  it('should return critical risk when checksum fails', () => {
    const result = assessVerificationRisk(
      undefined,
      { passed: false },
      { present: false, verified: false, trusted: false }
    );
    expect(result.level).toBe('critical');
    expect(result.recommendation).toBe('BLOCK');
    expect(result.issues).toContain(
      'Checksum verification FAILED - content has been tampered with'
    );
  });

  it('should block when signature is present but verification fails', () => {
    const result = assessVerificationRisk(
      undefined,
      { passed: true },
      { present: true, verified: false, trusted: false }
    );
    expect(result.level).toBe('high');
    expect(result.recommendation).toBe('BLOCK');
  });

  it('should block when signature is valid but not trusted', () => {
    const result = assessVerificationRisk(
      undefined,
      { passed: true },
      { present: true, verified: true, trusted: false }
    );
    expect(result.level).toBe('medium');
    expect(result.recommendation).toBe('BLOCK');
    expect(result.issues).toContain(
      'Signature is valid but signer is not in your trusted keys list'
    );
  });

  it('should allow when signature is valid and trusted', () => {
    const result = assessVerificationRisk(
      undefined,
      { passed: true },
      { present: true, verified: true, trusted: true }
    );
    expect(result.level).toBe('low');
    expect(result.recommendation).toBe('ALLOW');
  });

  it('should flag medium risk for high-risk dossier without signature', () => {
    const result = assessVerificationRisk(
      'high',
      { passed: true },
      { present: false, verified: false, trusted: false }
    );
    expect(result.level).toBe('medium');
    expect(result.issues).toContain('High-risk dossier without signature');
  });

  it('should flag high risk for critical-risk dossier without signature', () => {
    const result = assessVerificationRisk(
      'critical',
      { passed: true },
      { present: false, verified: false, trusted: false }
    );
    expect(result.level).toBe('high');
    expect(result.issues).toContain('Critical-risk dossier without signature');
  });

  it('should keep critical level even with additional risk factors', () => {
    const result = assessVerificationRisk(
      'critical',
      { passed: false },
      { present: false, verified: false, trusted: false }
    );
    expect(result.level).toBe('critical');
    expect(result.recommendation).toBe('BLOCK');
  });
});

describe('checkSignature', () => {
  it('should return not-present when no signature in frontmatter', async () => {
    const result = await checkSignature('body', { title: 'T', version: '1' });
    expect(result.present).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.message).toBe('No signature present');
  });

  it('should return failed for an invalid signature', async () => {
    const result = await checkSignature('body', {
      title: 'T',
      version: '1',
      signature: {
        algorithm: 'ed25519',
        signature: 'invalidsig',
        public_key: 'invalidpk',
        key_id: 'kid',
      },
    });
    expect(result.present).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe('parseArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('should parse input path', () => {
    process.argv = ['node', 'dossier-verify', 'path/to/file.ds.md'];
    const result = parseArgs();
    expect(result.input).toBe('path/to/file.ds.md');
    expect(result.verbose).toBe(false);
  });

  it('should parse --verbose flag', () => {
    process.argv = ['node', 'dossier-verify', '--verbose', 'file.ds.md'];
    const result = parseArgs();
    expect(result.verbose).toBe(true);
    expect(result.input).toBe('file.ds.md');
  });

  it('should parse -v shorthand', () => {
    process.argv = ['node', 'dossier-verify', '-v', 'file.ds.md'];
    const result = parseArgs();
    expect(result.verbose).toBe(true);
  });

  it('should parse --help flag', () => {
    process.argv = ['node', 'dossier-verify', '--help'];
    const result = parseArgs();
    expect(result.help).toBe(true);
  });

  it('should return null input when no file provided', () => {
    process.argv = ['node', 'dossier-verify'];
    const result = parseArgs();
    expect(result.input).toBeNull();
  });

  it('should handle multiple flags together', () => {
    process.argv = ['node', 'dossier-verify', '--verbose', 'file.ds.md'];
    const result = parseArgs();
    expect(result.verbose).toBe(true);
    expect(result.input).toBe('file.ds.md');
  });
});

describe('downloadFile', () => {
  it('should reject when redirect limit is exceeded', async () => {
    await expect(downloadFile('http://example.com', 10)).rejects.toThrow('Too many redirects');
  });
});

describe('verifyDossier', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `dossier-verify-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDossier(body: string, extra: Record<string, unknown> = {}): string {
    const hash = sha256(body);
    const fm = {
      title: 'Test',
      version: '1.0.0',
      checksum: { algorithm: 'sha256', hash },
      ...extra,
    };
    return `---dossier\n${JSON.stringify(fm, null, 2)}\n---\n${body}`;
  }

  it('should return true for valid dossier with correct checksum', async () => {
    const body = '# Test\n\nValid dossier content.';
    const filePath = join(tempDir, 'valid.ds.md');
    writeFileSync(filePath, makeDossier(body));

    const result = await verifyDossier(filePath, { verbose: false });
    expect(result).toBe(true);
  });

  it('should return false for tampered content', async () => {
    const body = '# Test\n\nOriginal content.';
    const content = makeDossier(body);
    const tampered = content.replace('Original content.', 'Tampered content!');
    const filePath = join(tempDir, 'tampered.ds.md');
    writeFileSync(filePath, tampered);

    const result = await verifyDossier(filePath, { verbose: false });
    expect(result).toBe(false);
  });

  it('should return false when file does not exist', async () => {
    const result = await verifyDossier('/nonexistent/path.ds.md', { verbose: false });
    expect(result).toBe(false);
  });

  it('should handle verbose mode without error', async () => {
    const body = '# Test\n\nVerbose test.';
    const filePath = join(tempDir, 'verbose.ds.md');
    writeFileSync(filePath, makeDossier(body));

    const result = await verifyDossier(filePath, { verbose: true });
    expect(result).toBe(true);
  });

  it('should allow unsigned dossier with default risk', async () => {
    const body = '# Unsigned\n\nNo signature.';
    const filePath = join(tempDir, 'unsigned.ds.md');
    writeFileSync(filePath, makeDossier(body));

    const result = await verifyDossier(filePath, { verbose: false });
    expect(result).toBe(true);
  });

  it('should proceed for critical-risk unsigned dossier with valid checksum', async () => {
    const body = '# Critical\n\nHigh risk content.';
    const filePath = join(tempDir, 'critical.ds.md');
    writeFileSync(filePath, makeDossier(body, { risk_level: 'critical' }));

    const result = await verifyDossier(filePath, { verbose: false });
    expect(result).toBe(true);
  });
});
