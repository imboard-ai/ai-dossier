import fs from 'node:fs';
import os from 'node:os';
import { createEvidenceRecord, parseDossierContent, sha256Hex } from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEvidenceCommand } from '../../commands/evidence';
import * as credentials from '../../credentials';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, makeCredentials, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../credentials');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

const dossierNoChecksum = `---dossier
{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"1.0.0","name":"test-dossier","risk_level":"low","status":"Stable"}
---
Body content here`;

const dossierChecksum = sha256Hex(parseDossierContent(dossierNoChecksum).body);

const dossierWithChecksum = `---dossier
{"dossier_schema_version":"1.0.0","title":"Test Dossier","version":"1.0.0","name":"test-dossier","risk_level":"low","status":"Stable","checksum":{"algorithm":"sha256","hash":"${dossierChecksum}"}}
---
Body content here`;

const existingRecord = createEvidenceRecord({
  dossier: 'org/test-dossier',
  version: '1.0.0',
  checksumHash: dossierChecksum,
});

describe('evidence command', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    vi.mocked(credentials.loadCredentials).mockReturnValue(makeCredentials() as any);
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
    delete process.env.AI_DOSSIER_SESSION_ID;
  });

  describe('show', () => {
    it('should render entries', async () => {
      const record = {
        ...existingRecord,
        entries: [
          {
            anchor: 'Section A',
            rationale: 'Because X',
            created_at: '2026-01-01T00:00:00.000Z',
            evidence: [
              {
                provider: 'claude-code' as const,
                session: 'sess-1',
                event: 'evt-1',
                host: 'wls',
                extra: { ctx: 'abc' },
              },
            ],
          },
        ],
      };
      vi.mocked(multiRegistry.multiRegistryGetEvidence).mockResolvedValue({
        result: {
          evidence: JSON.stringify(record),
          checksum: `sha256:${dossierChecksum}`,
          _registry: 'public',
        },
        errors: [],
      });

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'show', 'org/test-dossier']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`Evidence for org/test-dossier@1.0.0 (sha256:${dossierChecksum})`)
      );
      expect(console.log).toHaveBeenCalledWith('• Section A');
      expect(console.log).toHaveBeenCalledWith('  Because X');
      expect(console.log).toHaveBeenCalledWith('  refs: claude-code:sess-1#evt-1 @wls ctx=abc');
    });

    it('should print the raw record with --json', async () => {
      vi.mocked(multiRegistry.multiRegistryGetEvidence).mockResolvedValue({
        result: {
          evidence: JSON.stringify(existingRecord),
          checksum: `sha256:${dossierChecksum}`,
          _registry: 'public',
        },
        errors: [],
      });

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'show',
        'org/test-dossier',
        '--json',
      ]);

      const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
        try {
          return JSON.parse(call[0] as string).dossier === 'org/test-dossier';
        } catch {
          return false;
        }
      });
      expect(jsonCall).toBeDefined();
    });

    it('should exit 1 when not found', async () => {
      vi.mocked(multiRegistry.multiRegistryGetEvidence).mockResolvedValue({
        result: null,
        errors: [{ registry: 'public', error: 'Not found' }],
      });

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'show', 'org/missing'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No evidence for'));
    });
  });

  describe('init', () => {
    it('should create a valid record', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'init', 'test.ds.md']);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('test.evidence.json'),
        expect.stringContaining('"dossier": "test-org/test-dossier"'),
        'utf8'
      );
    });

    it('should refuse to overwrite without --force', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'init', 'test.ds.md'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should error when the dossier has no checksum', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierNoChecksum);

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'init', 'test.ds.md'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Dossier has no checksum')
      );
    });

    it('should error when not logged in and no --namespace', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);
      vi.mocked(credentials.loadCredentials).mockReturnValue(null);

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'init', 'test.ds.md'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--namespace required'));
    });
  });

  describe('add', () => {
    it('should append an entry with defaults (provider, hostname)', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(existingRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'add',
        'test.ds.md',
        '--anchor',
        'Section A',
        '--rationale',
        'Because X',
        '--session',
        'sess-1',
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Evidence entry added (1 entries)')
      );
      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.entries).toHaveLength(1);
      expect(written.entries[0].evidence[0].provider).toBe('claude-code');
      expect(written.entries[0].evidence[0].host).toBe(os.hostname());
      expect(written.entries[0].evidence[0].session).toBe('sess-1');
    });

    it('should error without --session and without AI_DOSSIER_SESSION_ID', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(existingRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'evidence',
          'add',
          'test.ds.md',
          '--anchor',
          'A',
          '--rationale',
          'B',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--session required'));
    });

    it('should respect AI_DOSSIER_SESSION_ID when --session is absent', async () => {
      process.env.AI_DOSSIER_SESSION_ID = 'env-session';
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(existingRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'add',
        'test.ds.md',
        '--anchor',
        'A',
        '--rationale',
        'B',
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.entries[0].evidence[0].session).toBe('env-session');

      delete process.env.AI_DOSSIER_SESSION_ID;
    });

    it('should land --extra k=v pairs in extra', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(existingRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'add',
        'test.ds.md',
        '--anchor',
        'A',
        '--rationale',
        'B',
        '--session',
        'sess-1',
        '--extra',
        'ctx=abc123',
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.entries[0].evidence[0].extra).toEqual({ ctx: 'abc123' });
    });

    it('should create the sidecar via init logic when absent', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'add',
        'test.ds.md',
        '--anchor',
        'A',
        '--rationale',
        'B',
        '--session',
        'sess-1',
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('test-org/test-dossier');
      expect(written.entries).toHaveLength(1);
    });
  });

  describe('sync', () => {
    it('should update version and hash from the current frontmatter', async () => {
      const staleRecord = createEvidenceRecord({
        dossier: 'org/test-dossier',
        version: '0.9.0',
        checksumHash: '0'.repeat(64),
      });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(staleRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'sync', 'test.ds.md']);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.version).toBe('1.0.0');
      expect(written.checksum.hash).toBe(dossierChecksum);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(dossierChecksum));
    });
  });

  describe('validate', () => {
    it('should print ✅ valid for a valid sidecar', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existingRecord));

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'validate',
        'sidecar.evidence.json',
      ]);

      expect(console.log).toHaveBeenCalledWith('✅ valid');
    });

    it('should exit 1 for an invalid sidecar', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not valid json');

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'validate', 'sidecar.evidence.json'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalled();
    });
  });
});
