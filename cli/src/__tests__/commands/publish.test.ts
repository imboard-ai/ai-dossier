import fs from 'node:fs';
import { createEvidenceRecord, parseDossierContent, sha256Hex } from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublishCommand } from '../../commands/publish';
import * as config from '../../config';
import * as credentials from '../../credentials';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:readline');
vi.mock('../../credentials');
vi.mock('../../registry-client');
vi.mock('../../config');

const mockedFs = vi.mocked(fs);

const validDossier = `---dossier
{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"1.0.0","name":"test-dossier","risk_level":"low","status":"Stable"}
---
Body content here`;

const validDossierChecksum = sha256Hex(parseDossierContent(validDossier).body);

const validDossierWithChecksum = `---dossier
{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"1.0.0","name":"test-dossier","risk_level":"low","status":"Stable","checksum":{"algorithm":"sha256","hash":"${validDossierChecksum}"}}
---
Body content here`;

const validEvidence = JSON.stringify(
  createEvidenceRecord({
    dossier: 'org/test-dossier',
    version: '1.0.0',
    checksumHash: validDossierChecksum,
  })
);

const mismatchedEvidence = JSON.stringify(
  createEvidenceRecord({
    dossier: 'org/test-dossier',
    version: '9.9.9',
    checksumHash: validDossierChecksum,
  })
);

describe('publish command', () => {
  const mockClient = { publishDossier: vi.fn(), getDossier: vi.fn() };

  beforeEach(() => {
    vi.mocked(config.resolveWriteRegistry).mockReturnValue({
      name: 'public',
      url: 'https://test.registry.com',
    });
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: ['org'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockClient as any);
    mockClient.getDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    // Path-aware by default: the dossier file exists, but no sibling evidence sidecar does —
    // matches "no sidecar" being the common case across the pre-existing tests below.
    mockedFs.existsSync.mockImplementation(((p: unknown) => {
      return !String(p).endsWith('.evidence.json');
    }) as typeof fs.existsSync);
    mockedFs.readFileSync.mockReturnValue(validDossier);
  });

  it('should exit 1 when not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 when credentials expired', async () => {
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should exit 1 when file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'missing.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  it('should exit 1 on invalid dossier format', async () => {
    mockedFs.readFileSync.mockReturnValue('no frontmatter');

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid dossier format'));
  });

  it('should exit 1 on missing required fields', async () => {
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"name":"test"}\n---\nBody');

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Validation errors'));
  });

  it('should exit 1 in non-TTY without --yes', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Non-interactive session'));

    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('should publish with --yes flag and show full registry path', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith('org', validDossier, null, null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('org/test-dossier@1.0.0'));
  });

  it('should show CDN propagation warning after successful publish', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('CDN propagation'));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('dossier info org/test-dossier@1.0.0')
    );
  });

  it('should include verification field in JSON output after publish', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.published === true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.verification).toBeDefined();
    expect(output.verification.verify_command).toBe('dossier info org/test-dossier@1.0.0');
    expect(output.verification.cdn_delay_seconds).toBe(30);
  });

  it('should exit 1 on same-version collision (pre-publish check)', async () => {
    mockClient.getDossier.mockReset();
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });

    const program = createTestProgram();
    registerPublishCommand(program);

    try {
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);
    } catch {
      // Expected — process.exit throws in vitest v4
    }

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Version collision: org/test-dossier@1.0.0 already exists')
    );
  });

  it('should output JSON on same-version collision with --json flag', async () => {
    mockClient.getDossier.mockReset();
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json'])
    ).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.code === 'version_exists';
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.published).toBe(false);
    expect(output.name).toBe('org/test-dossier');
  });

  it('should publish with --json flag and output structured result', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.published === true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.name).toBe('org/test-dossier');
    expect(output.version).toBe('1.0.0');
    expect(output.content_url).toBe('https://registry.example.com/dossiers/org/test-dossier');
  });

  it('should exit 1 on 409 version conflict from server', async () => {
    mockClient.publishDossier.mockRejectedValue(
      Object.assign(new Error('Version exists'), { statusCode: 409 })
    );

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Version conflict'));
  });

  it('should warn when dossier exists at different version', async () => {
    mockClient.getDossier.mockReset();
    mockClient.getDossier.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '0.9.0' });

    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated from v0.9.0'));
    expect(mockClient.publishDossier).toHaveBeenCalled();
  });

  describe('evidence sidecar', () => {
    beforeEach(() => {
      mockClient.publishDossier.mockReset();
      mockClient.publishDossier.mockResolvedValue({
        name: 'org/test-dossier',
        content_url: 'https://registry.example.com/dossiers/org/test-dossier',
        evidence_url: 'https://registry.example.com/dossiers/org/test-dossier/evidence',
      });
    });

    it('should auto-attach a sibling evidence sidecar when present', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? validEvidence
          : validDossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

      expect(mockClient.publishDossier).toHaveBeenCalledWith(
        'org',
        validDossierWithChecksum,
        null,
        validEvidence
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Evidence: https://registry.example.com/dossiers/org/test-dossier/evidence'
        )
      );
    });

    it('should include evidence_url (null when absent) in --json output', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return !String(p).endsWith('.evidence.json');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(validDossierWithChecksum);
      mockClient.publishDossier.mockResolvedValue({
        name: 'org/test-dossier',
        content_url: 'https://registry.example.com/dossiers/org/test-dossier',
      });

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json']);

      const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
        try {
          return JSON.parse(call[0] as string).published === true;
        } catch {
          return false;
        }
      });
      expect(jsonCall).toBeDefined();
      expect(JSON.parse(jsonCall?.[0] as string).evidence_url).toBeNull();
    });

    it('should skip an existing sidecar with --no-evidence', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? validEvidence
          : validDossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'publish',
        'test.ds.md',
        '--yes',
        '--no-evidence',
      ]);

      expect(mockClient.publishDossier).toHaveBeenCalledWith(
        'org',
        validDossierWithChecksum,
        null,
        null
      );
    });

    it('should override the sidecar path with --evidence <path>', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).includes('custom-evidence')
          ? validEvidence
          : validDossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'publish',
        'test.ds.md',
        '--yes',
        '--evidence',
        'custom-evidence.json',
      ]);

      expect(mockClient.publishDossier).toHaveBeenCalledWith(
        'org',
        validDossierWithChecksum,
        null,
        validEvidence
      );
    });

    it('should exit 1 without publishing on an invalid sidecar', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? 'not valid json'
          : validDossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid evidence file'));
      expect(mockClient.publishDossier).not.toHaveBeenCalled();
    });

    it('should exit 1 with the evidence sync hint on a mismatch', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? mismatchedEvidence
          : validDossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Run 'ai-dossier evidence sync <file>' to update version/checksum")
      );
      expect(mockClient.publishDossier).not.toHaveBeenCalled();
    });

    it('should produce the same request body as before when no sidecar exists', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return !String(p).endsWith('.evidence.json');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(validDossierWithChecksum);

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

      expect(mockClient.publishDossier).toHaveBeenCalledWith(
        'org',
        validDossierWithChecksum,
        null,
        null
      );
    });
  });
});
