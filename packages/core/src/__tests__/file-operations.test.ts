import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calculateChecksum } from '../checksum';
import { formatDossierFile } from '../formatter';
import { lintDossierFile } from '../linter';
import { Ed25519Verifier } from '../signers/ed25519';
import { VerifierRegistry } from '../signers/registry';

function makeDossier(frontmatter: Record<string, unknown>, body = '# Test\n\n## Section\nContent') {
  const json = JSON.stringify(frontmatter, null, 2);
  return `---dossier\n${json}\n---\n${body}`;
}

const baseFrontmatter = {
  dossier_schema_version: '1.0.0',
  title: 'Test Dossier',
  version: '1.0.0',
  status: 'Stable',
  objective: 'Test file-based operations for coverage',
  risk_level: 'low',
  requires_approval: false,
};

describe('formatDossierFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `dossier-fmt-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should format a file in place and return changed=true', () => {
    const body = '# Test\n\n## Section\nContent';
    const fm = { version: '1.0.0', title: 'Test', dossier_schema_version: '1.0.0' };
    const content = makeDossier(fm, body);
    const filePath = join(tempDir, 'test.ds.md');
    writeFileSync(filePath, content, 'utf8');

    const result = formatDossierFile(filePath);

    expect(result.changed).toBe(true);
    const written = readFileSync(filePath, 'utf8');
    expect(written).toBe(result.formatted);
  });

  it('should not write when content is already formatted', () => {
    const body = '# Test\n\n## Section\nContent';
    const fm = {
      ...baseFrontmatter,
      checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
    };
    const content = makeDossier(fm, body);
    const filePath = join(tempDir, 'test.ds.md');

    // Format once
    writeFileSync(filePath, content, 'utf8');
    const first = formatDossierFile(filePath);
    writeFileSync(filePath, first.formatted, 'utf8');

    // Format again — should not change
    const second = formatDossierFile(filePath);
    expect(second.changed).toBe(false);
  });
});

describe('lintDossierFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `dossier-lint-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should lint a file and return results with file path', () => {
    const body = '# Test\n\n## Section\nContent';
    const fm = {
      ...baseFrontmatter,
      checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
    };
    const content = makeDossier(fm, body);
    const filePath = join(tempDir, 'test.ds.md');
    writeFileSync(filePath, content, 'utf8');

    const result = lintDossierFile(filePath);

    expect(result.file).toBe(filePath);
    expect(result.errorCount).toBeGreaterThanOrEqual(0);
    expect(result.warningCount).toBeGreaterThanOrEqual(0);
  });

  it('should detect lint issues in a file', () => {
    const content = makeDossier({ title: 'Incomplete' });
    const filePath = join(tempDir, 'bad.ds.md');
    writeFileSync(filePath, content, 'utf8');

    const result = lintDossierFile(filePath);

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});

describe('verifySignature (via registry)', () => {
  it('should verify using a registry with Ed25519Verifier', async () => {
    // Exercise the registry + verifier pattern that verifySignature uses,
    // without calling getVerifierRegistry() which uses require() at runtime.
    const registry = new VerifierRegistry();
    registry.register(new Ed25519Verifier());

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const content = 'test content for registry verify';
    const sig = cryptoSign(null, Buffer.from(content, 'utf8'), privateKey);

    const verifier = registry.get('ed25519');
    const result = await verifier.verify(content, {
      algorithm: 'ed25519',
      signature: sig.toString('base64'),
      public_key: publicKeyPem,
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
  });

  it('should reject invalid signature through registry', async () => {
    const registry = new VerifierRegistry();
    registry.register(new Ed25519Verifier());

    const verifier = registry.get('ed25519');
    const result = await verifier.verify('content', {
      algorithm: 'ed25519',
      signature: 'dGVzdA==',
      public_key: 'not-a-key',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
