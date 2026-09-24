import fs from 'node:fs';
import {
  createEvidenceRecord,
  type EvidenceRecord,
  parseDossierContent,
  sha256Hex,
} from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findDroppedEvidenceAnchors, registerPublishCommand } from '../../commands/publish';
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

/** Build a previous-version evidence record for the regression-check tests. */
function previousEvidenceRecord(anchors: string[]): EvidenceRecord {
  const record = createEvidenceRecord({
    dossier: 'org/test-dossier',
    version: '1.0.0',
    checksumHash: 'a'.repeat(64),
  });
  record.entries = anchors.map((anchor) => ({
    anchor,
    rationale: 'because',
    created_at: '2026-01-01T00:00:00Z',
    evidence: [],
  }));
  return record;
}

describe('publish command', () => {
  const mockClient = {
    publishDossier: vi.fn(),
    getDossier: vi.fn(),
    getDossierEvidence: vi.fn(),
  };

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
    mockClient.getDossierEvidence.mockReset();
    mockClient.getDossierEvidence.mockRejectedValue(
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

  describe('findDroppedEvidenceAnchors (unit)', () => {
    const entry = (anchor: string) => ({
      anchor,
      rationale: 'because',
      created_at: '2026-01-01T00:00:00Z',
      evidence: [],
    });

    it('flags an anchor whose section survives but whose entry is missing', () => {
      expect(
        findDroppedEvidenceAnchors([entry('Step 2')], 'body text\n## Step 2\nstill here', [])
      ).toEqual(['Step 2']);
    });

    it('stays silent when the anchor section was removed too', () => {
      expect(findDroppedEvidenceAnchors([entry('Step 6')], 'body text, no heading', [])).toEqual(
        []
      );
    });

    it('does not flag an anchor whose entry survives in the new sidecar', () => {
      expect(
        findDroppedEvidenceAnchors([entry('Step 2')], 'body text\n## Step 2\nstill here', [
          entry('Step 2'),
        ])
      ).toEqual([]);
    });

    it('returns nothing for an empty previous entry list', () => {
      expect(findDroppedEvidenceAnchors([], 'anything', [])).toEqual([]);
    });
  });

  describe('evidence regression check (#817)', () => {
    const bodyKeepsAllSections =
      'Body content here\n\n## Step 2\nDo the thing.\n\n## Step 6\nClaim release.';
    const bodyRemovesStep6 = 'Body content here\n\n## Step 2\nDo the thing.';

    const rawDossier = (version: string, body: string) =>
      `---dossier\n{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"${version}","name":"test-dossier","risk_level":"low","status":"Stable"}\n---\n${body}`;

    const withChecksum = (version: string, body: string) => {
      const checksum = sha256Hex(parseDossierContent(rawDossier(version, body)).body);
      return `---dossier\n{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"${version}","name":"test-dossier","risk_level":"low","status":"Stable","checksum":{"algorithm":"sha256","hash":"${checksum}"}}\n---\n${body}`;
    };

    function evidenceWithAnchors(version: string, body: string, anchors: string[]): string {
      const record = createEvidenceRecord({
        dossier: 'org/test-dossier',
        version,
        checksumHash: sha256Hex(parseDossierContent(rawDossier(version, body)).body),
      });
      record.entries = anchors.map((anchor) => ({
        anchor,
        rationale: 'because',
        created_at: '2026-01-01T00:00:00Z',
        evidence: [],
      }));
      return JSON.stringify(record);
    }

    beforeEach(() => {
      mockClient.publishDossier.mockReset();
      mockClient.publishDossier.mockResolvedValue({
        name: 'org/test-dossier',
        content_url: 'https://registry.example.com/dossiers/org/test-dossier',
      });
    });

    it('AC1: blocks when a kept section drops its evidence entry, naming the anchor', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });
      mockClient.getDossierEvidence.mockResolvedValueOnce({
        evidence: JSON.stringify(previousEvidenceRecord(['Step 2', 'Step 6'])),
        checksum: null,
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).includes('custom-evidence')
          ? evidenceWithAnchors('1.1.0', bodyKeepsAllSections, ['Step 6'])
          : withChecksum('1.1.0', bodyKeepsAllSections)) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'publish',
          'test.ds.md',
          '--yes',
          '--evidence',
          'custom-evidence.json',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"Step 2"'));
      expect(mockClient.publishDossier).not.toHaveBeenCalled();
    });

    it('AC2: stays silent when both the section and its entry were removed', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });
      mockClient.getDossierEvidence.mockResolvedValueOnce({
        evidence: JSON.stringify(previousEvidenceRecord(['Step 2', 'Step 6'])),
        checksum: null,
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).includes('custom-evidence')
          ? evidenceWithAnchors('1.1.0', bodyRemovesStep6, ['Step 2'])
          : withChecksum('1.1.0', bodyRemovesStep6)) as typeof fs.readFileSync);

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

      expect(mockClient.publishDossier).toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('dropped'));
    });

    it('AC3: --drop-evidence overrides a named anchor and lets the publish proceed', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });
      mockClient.getDossierEvidence.mockResolvedValueOnce({
        evidence: JSON.stringify(previousEvidenceRecord(['Step 2', 'Step 6'])),
        checksum: null,
      });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).includes('custom-evidence')
          ? evidenceWithAnchors('1.1.0', bodyKeepsAllSections, ['Step 6'])
          : withChecksum('1.1.0', bodyKeepsAllSections)) as typeof fs.readFileSync);

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
        '--drop-evidence',
        'Step 2',
      ]);

      expect(mockClient.publishDossier).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Dropping evidence'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"Step 2"'));
    });

    it('AC4a: first publish (no previous version) skips the check without blocking', async () => {
      // Default beforeEach already rejects both getDossier calls with 404.
      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

      expect(mockClient.getDossierEvidence).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('First publish'));
      expect(mockClient.publishDossier).toHaveBeenCalled();
    });

    it('AC4b: no previous evidence recorded (404) skips the check without blocking', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '0.9.0' });
      // Default beforeEach already rejects getDossierEvidence with a 404.

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No evidence recorded'));
      expect(mockClient.publishDossier).toHaveBeenCalled();
    });

    it('AC5: a non-404 fetch failure skips the check without blocking', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '0.9.0' });
      mockClient.getDossierEvidence.mockRejectedValueOnce(new Error('network error'));

      const program = createTestProgram();
      registerPublishCommand(program);
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Could not establish previous evidence')
      );
      expect(mockClient.publishDossier).toHaveBeenCalled();
    });

    it('a hung registry (no response within the timeout) skips the check without blocking', async () => {
      vi.useFakeTimers();
      try {
        mockClient.getDossier.mockReset();
        mockClient.getDossier.mockRejectedValueOnce(
          Object.assign(new Error('Not found'), { statusCode: 404 })
        );
        mockClient.getDossier.mockResolvedValueOnce({
          name: 'org/test-dossier',
          version: '0.9.0',
        });
        // Never resolves — simulates a hung registry call.
        mockClient.getDossierEvidence.mockReturnValueOnce(new Promise(() => {}));

        const program = createTestProgram();
        registerPublishCommand(program);
        const run = program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

        await vi.advanceTimersByTimeAsync(10_000);
        await run;

        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Could not establish previous evidence')
        );
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('timed out'));
        expect(mockClient.publishDossier).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('blocks the default sibling .evidence.json path the same as an explicit --evidence path', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });
      mockClient.getDossierEvidence.mockResolvedValueOnce({
        evidence: JSON.stringify(previousEvidenceRecord(['Step 2', 'Step 6'])),
        checksum: null,
      });

      // No --evidence flag: resolveEvidenceForPublish falls back to the sibling .evidence.json.
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? evidenceWithAnchors('1.1.0', bodyKeepsAllSections, ['Step 6'])
          : withChecksum('1.1.0', bodyKeepsAllSections)) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"Step 2"'));
      expect(mockClient.publishDossier).not.toHaveBeenCalled();
    });

    it('strips control characters from a dropped anchor before printing it', async () => {
      mockClient.getDossier.mockReset();
      mockClient.getDossier.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );
      mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });
      const maliciousAnchor = 'Step 2\x1b[31mFAKE ERROR\x1b[0m';
      mockClient.getDossierEvidence.mockResolvedValueOnce({
        evidence: JSON.stringify(previousEvidenceRecord([maliciousAnchor])),
        checksum: null,
      });

      const bodyWithMaliciousSection = `Body content here\n\n## ${maliciousAnchor}\nDo the thing.`;
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? evidenceWithAnchors('1.1.0', bodyWithMaliciousSection, [])
          : withChecksum('1.1.0', bodyWithMaliciousSection)) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerPublishCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
      ).rejects.toThrow();

      for (const call of vi.mocked(console.error).mock.calls) {
        expect(String(call[0])).not.toContain('\x1b');
      }
      expect(mockClient.publishDossier).not.toHaveBeenCalled();
    });

    describe('--json output', () => {
      it('emits a structured evidence_regression envelope on the blocked path', async () => {
        mockClient.getDossier.mockReset();
        mockClient.getDossier.mockRejectedValueOnce(
          Object.assign(new Error('Not found'), { statusCode: 404 })
        );
        mockClient.getDossier.mockResolvedValueOnce({
          name: 'org/test-dossier',
          version: '1.0.0',
        });
        mockClient.getDossierEvidence.mockResolvedValueOnce({
          evidence: JSON.stringify(previousEvidenceRecord(['Step 2', 'Step 6'])),
          checksum: null,
        });

        mockedFs.existsSync.mockReturnValue(true);
        mockedFs.readFileSync.mockImplementation(((p: unknown) =>
          String(p).endsWith('.evidence.json')
            ? evidenceWithAnchors('1.1.0', bodyKeepsAllSections, ['Step 6'])
            : withChecksum('1.1.0', bodyKeepsAllSections)) as typeof fs.readFileSync);

        const program = createTestProgram();
        registerPublishCommand(program);

        await expect(
          program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json'])
        ).rejects.toThrow();

        const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
          try {
            return JSON.parse(call[0] as string).code === 'evidence_regression';
          } catch {
            return false;
          }
        });
        expect(jsonCall).toBeDefined();
        const output = JSON.parse(jsonCall?.[0] as string);
        expect(output.published).toBe(false);
        expect(output.anchors).toEqual(['Step 2']);
        expect(mockClient.publishDossier).not.toHaveBeenCalled();
      });

      it('carries evidence_check on the successful JSON result (clean vs. skipped)', async () => {
        mockClient.publishDossier.mockResolvedValue({
          name: 'org/test-dossier',
          content_url: 'https://registry.example.com/dossiers/org/test-dossier',
        });

        // Clean case: previous evidence exists, nothing was dropped.
        mockClient.getDossier.mockReset();
        mockClient.getDossier.mockRejectedValueOnce(
          Object.assign(new Error('Not found'), { statusCode: 404 })
        );
        mockClient.getDossier.mockResolvedValueOnce({
          name: 'org/test-dossier',
          version: '1.0.0',
        });
        mockClient.getDossierEvidence.mockResolvedValueOnce({
          evidence: JSON.stringify(previousEvidenceRecord(['Step 2'])),
          checksum: null,
        });
        mockedFs.existsSync.mockReturnValue(true);
        mockedFs.readFileSync.mockImplementation(((p: unknown) =>
          String(p).endsWith('.evidence.json')
            ? evidenceWithAnchors('1.1.0', bodyKeepsAllSections, ['Step 2', 'Step 6'])
            : withChecksum('1.1.0', bodyKeepsAllSections)) as typeof fs.readFileSync);

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
        expect(JSON.parse(jsonCall?.[0] as string).evidence_check).toEqual({ status: 'clean' });
      });
    });
  });
});
