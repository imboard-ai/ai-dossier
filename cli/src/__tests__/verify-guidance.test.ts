import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorEnabled, colors, paint } from '../color';
import { verifyDossier } from '../verify-dossier';
import {
  checksumFailureGuidance,
  needsRiskConfirmation,
  riskSummaryLines,
  signatureFailureGuidance,
} from '../verify-guidance';

describe('checksumFailureGuidance', () => {
  it('shows expected/actual, causes and a fix using real commands', () => {
    const text = checksumFailureGuidance({ input: 'a.ds.md', expected: 'aaa', actual: 'bbb' }).join(
      '\n'
    );
    expect(text).toContain('Expected: aaa');
    expect(text).toContain('Actual:   bbb');
    expect(text).toContain('Possible causes:');
    expect(text).toContain('ai-dossier checksum a.ds.md --update');
    expect(text).toContain('ai-dossier pull --force <name>');
  });

  it('suggests re-downloading for URLs', () => {
    const text = checksumFailureGuidance({ input: 'https://x.test/a.ds.md' }).join('\n');
    expect(text).toContain('Download it again');
  });
});

describe('signatureFailureGuidance', () => {
  it('names causes and re-sign / keys commands', () => {
    const text = signatureFailureGuidance({ input: 'a.ds.md', error: 'bad sig' }).join('\n');
    expect(text).toContain('Error: bad sig');
    expect(text).toContain('Possible causes:');
    expect(text).toContain('ai-dossier sign a.ds.md');
    expect(text).toContain('ai-dossier keys list');
  });
});

describe('risk helpers', () => {
  it('requires confirmation for high and critical only', () => {
    expect(needsRiskConfirmation({ risk_level: 'high' })).toBe(true);
    expect(needsRiskConfirmation({ risk_level: 'CRITICAL' })).toBe(true);
    expect(needsRiskConfirmation({ risk_level: 'medium' })).toBe(false);
    expect(needsRiskConfirmation({})).toBe(false);
  });

  it('lists risk_factors', () => {
    expect(
      riskSummaryLines({ risk_level: 'high', risk_factors: ['modifies_cloud_resources'] })
    ).toEqual([
      'Risk level: high',
      'This dossier declares it may:',
      '  - modifies cloud resources',
    ]);
  });
});

describe('color helper', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('honors NO_COLOR even on a TTY', () => {
    process.env.NO_COLOR = '1';
    expect(colorEnabled({ isTTY: true })).toBe(false);
    expect(paint('red', 'x')).toBe('x');
    expect(colors.red).toBe('');
  });

  it('is off for non-TTY and on with FORCE_COLOR', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    expect(colorEnabled({ isTTY: false })).toBe(false);
    process.env.FORCE_COLOR = '1';
    expect(paint('red', 'x')).toBe('\x1b[31mx\x1b[0m');
  });
});

describe('verifyDossier failure output', () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = join(tmpdir(), `dossier-guidance-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      out.push(a.join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints Expected/Actual, causes and fix for a tampered dossier without --verbose', async () => {
    const body = '# T\n\nOriginal';
    const hash = createHash('sha256').update(body, 'utf8').digest('hex');
    const fm = { title: 'T', version: '1.0.0', checksum: { algorithm: 'sha256', hash } };
    const file = join(dir, 't.ds.md');
    writeFileSync(
      file,
      `---dossier\n${JSON.stringify(fm)}\n---\n${body.replace('Original', 'Evil')}`
    );

    expect(await verifyDossier(file, { verbose: false })).toBe(false);
    const text = out.join('\n');
    expect(text).toContain(`Expected: ${hash}`);
    expect(text).toContain('Actual:');
    expect(text).toContain('Possible causes:');
    expect(text).toContain(`ai-dossier checksum ${file} --update`);
  });
});
