import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** A well-formed Claude Code session UUID, for tests exercising the default `claude-code` provider. */
const VALID_SESSION = '5a718af0-4e3c-4d6b-a7e1-e73bd3358ab4';

/** Wire fs mocks for an `evidence sync` test: `sidecarRecord` sits beside `dossierWithChecksum`. */
function mockSyncFixture(sidecarRecord: ReturnType<typeof createEvidenceRecord>): void {
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockImplementation(((p: unknown) =>
    String(p).endsWith('.evidence.json')
      ? JSON.stringify(sidecarRecord)
      : dossierWithChecksum) as typeof fs.readFileSync);
}

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

    it('should compute the checksum from the body when frontmatter has none', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierNoChecksum);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'init', 'test.ds.md']);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.checksum.hash).toBe(dossierChecksum);
      expect(console.error).not.toHaveBeenCalled();
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
        VALID_SESSION,
      ]);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Evidence entry added (dossier=org/test-dossier version=1.0.0, 1 entries)'
        )
      );
      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.entries).toHaveLength(1);
      expect(written.entries[0].evidence[0].provider).toBe('claude-code');
      expect(written.entries[0].evidence[0].host).toBe(os.hostname());
      expect(written.entries[0].evidence[0].session).toBe(VALID_SESSION);
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

    it('should default --session from AI_DOSSIER_SESSION_ID when the flag is absent', async () => {
      process.env.AI_DOSSIER_SESSION_ID = VALID_SESSION;
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
      expect(written.entries[0].evidence[0].session).toBe(VALID_SESSION);
      expect(console.log).toHaveBeenCalledWith(
        `ℹ️  session=${VALID_SESSION} (from AI_DOSSIER_SESSION_ID)`
      );

      delete process.env.AI_DOSSIER_SESSION_ID;
    });

    it('should default --session from the newest transcript for provider claude-code', async () => {
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      const slug = process.cwd().replace(/\//g, '-');
      const projectDir = path.join(projectsDir, slug);

      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        const s = String(p);
        if (s.endsWith('.ds.md')) return true;
        if (s.endsWith('.evidence.json')) return false;
        return s === projectsDir || s === projectDir;
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);
      mockedFs.readdirSync.mockImplementation(((p: unknown) => {
        if (String(p) === projectDir) return ['older-session.jsonl', `${VALID_SESSION}.jsonl`];
        return [];
      }) as unknown as typeof fs.readdirSync);
      mockedFs.statSync.mockImplementation(((p: unknown) => {
        const mtimeMs = String(p).includes(VALID_SESSION) ? 2000 : 1000;
        return { mtimeMs } as fs.Stats;
      }) as typeof fs.statSync);

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
      expect(written.entries[0].evidence[0].session).toBe(VALID_SESSION);
      expect(console.log).toHaveBeenCalledWith(
        `ℹ️  session=${VALID_SESSION} (from newest transcript)`
      );
    });

    it('should default --session from the cross-project fallback and label it distinctly', async () => {
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      const primaryDir = path.join(projectsDir, process.cwd().replace(/\//g, '-'));
      const otherDir = path.join(projectsDir, 'some-other-project');

      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        const s = String(p);
        if (s.endsWith('.ds.md')) return true;
        if (s.endsWith('.evidence.json')) return false;
        return s === projectsDir || s === otherDir;
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierWithChecksum);
      mockedFs.readdirSync.mockImplementation(((p: unknown) => {
        if (String(p) === primaryDir) return []; // nothing for this cwd's own project dir
        if (String(p) === projectsDir) return ['some-other-project'];
        if (String(p) === otherDir) return [`${VALID_SESSION}.jsonl`];
        return [];
      }) as unknown as typeof fs.readdirSync);
      mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

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
      expect(written.entries[0].evidence[0].session).toBe(VALID_SESSION);
      expect(console.log).toHaveBeenCalledWith(
        `ℹ️  session=${VALID_SESSION} (from newest transcript — ${otherDir}, not this project's dir; pass --session explicitly if wrong)`
      );
    });

    it('should hint at the transcript search paths when --session cannot be resolved at all', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(existingRecord)
          : dossierWithChecksum) as typeof fs.readFileSync);
      mockedFs.readdirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

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

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('looked for a transcript under ~/.claude/projects/')
      );
    });

    it('should reject a short non-placeholder session id for a non-claude-code provider', async () => {
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
          '--provider',
          'codex',
          '--session',
          'abc123',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--session looks like a placeholder')
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject a placeholder session id for provider claude-code', async () => {
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
          '--session',
          'claude-session-fc749',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          '--session must be the Claude Code session UUID (the transcript filename under ~/.claude/projects); got "claude-session-fc749"'
        )
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should reject a placeholder session id for a non-claude-code provider', async () => {
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
          '--provider',
          'codex',
          '--session',
          'example-session',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--session looks like a placeholder')
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should bypass session validation with --force-session', async () => {
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
        'claude-session-fc749',
        '--force-session',
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.entries[0].evidence[0].session).toBe('claude-session-fc749');
    });

    it('should warn (not fail) when --rationale starts with an imperative instruction verb', async () => {
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
        'Record evidence for every rule you changed',
        '--session',
        VALID_SESSION,
      ]);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('looks like copied instruction text')
      );
      // The warning does not block the write.
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it('should not warn when --rationale is not an imperative instruction', async () => {
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
        'The placeholder session defeated the sidecar; this fixes it.',
        '--session',
        VALID_SESSION,
      ]);

      expect(console.error).not.toHaveBeenCalled();
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
        VALID_SESSION,
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
        VALID_SESSION,
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('test-org/test-dossier');
      expect(written.entries).toHaveLength(1);
    });

    it('should compute the checksum from the body when frontmatter has none', async () => {
      mockedFs.existsSync.mockImplementation(((p: unknown) => {
        return String(p).endsWith('.ds.md');
      }) as typeof fs.existsSync);
      mockedFs.readFileSync.mockReturnValue(dossierNoChecksum);

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
        VALID_SESSION,
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.checksum.hash).toBe(dossierChecksum);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should preserve an existing sidecar’s namespace on a repeat call without --namespace', async () => {
      // A second `evidence add` (e.g. for a different anchor) must not silently revert a
      // previously-set custom namespace back to the account default — see the equivalent
      // `sync` test above for the trap (#736) this protects against.
      const customNamespaceRecord = createEvidenceRecord({
        dossier: 'custom-org/test-dossier',
        version: '1.0.0',
        checksumHash: dossierChecksum,
      });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(customNamespaceRecord)
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
        VALID_SESSION,
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('custom-org/test-dossier');
    });
  });

  describe('sync', () => {
    it('should update version and hash from the current frontmatter', async () => {
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'org/test-dossier',
          version: '0.9.0',
          checksumHash: '0'.repeat(64),
        })
      );

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'sync', 'test.ds.md']);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.version).toBe('1.0.0');
      expect(written.checksum.hash).toBe(dossierChecksum);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(dossierChecksum));
    });

    it('should rewrite dossier to the given --namespace', async () => {
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'wrong-org/test-dossier',
          version: '1.0.0',
          checksumHash: dossierChecksum,
        })
      );

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync([
        'node',
        'dossier',
        'evidence',
        'sync',
        'test.ds.md',
        '--namespace',
        'foo',
      ]);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('foo/test-dossier');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dossier=foo/test-dossier'));
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('dossier namespace changed: wrong-org → foo')
      );
    });

    it('should preserve the existing namespace when --namespace is absent', async () => {
      // A previously-set custom namespace ("custom-org") must never be silently reverted to
      // the account default ("test-org") just because a later sync omits --namespace — that
      // was the exact mis-stamping trap (#736) this command exists to let an author fix
      // in place, on purpose, by passing --namespace.
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'custom-org/test-dossier',
          version: '1.0.0',
          checksumHash: dossierChecksum,
        })
      );

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'sync', 'test.ds.md']);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('custom-org/test-dossier');
    });

    it('should not require credentials when the sidecar already has a namespace', async () => {
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'custom-org/test-dossier',
          version: '1.0.0',
          checksumHash: dossierChecksum,
        })
      );
      vi.mocked(credentials.loadCredentials).mockReturnValue(null);

      const program = createTestProgram();
      registerEvidenceCommand(program);
      await program.parseAsync(['node', 'dossier', 'evidence', 'sync', 'test.ds.md']);

      const written = JSON.parse(vi.mocked(mockedFs.writeFileSync).mock.calls[0][1] as string);
      expect(written.dossier).toBe('custom-org/test-dossier');
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should error when the dossier has no checksum', async () => {
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'custom-org/test-dossier',
          version: '1.0.0',
          checksumHash: dossierChecksum,
        })
      );
      mockedFs.readFileSync.mockImplementation(((p: unknown) =>
        String(p).endsWith('.evidence.json')
          ? JSON.stringify(
              createEvidenceRecord({
                dossier: 'custom-org/test-dossier',
                version: '1.0.0',
                checksumHash: dossierChecksum,
              })
            )
          : dossierNoChecksum) as typeof fs.readFileSync);

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'evidence', 'sync', 'test.ds.md'])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('has no checksum'));
    });

    it('should refuse to write a sidecar an invalid --namespace would make schema-invalid', async () => {
      mockSyncFixture(
        createEvidenceRecord({
          dossier: 'custom-org/test-dossier',
          version: '1.0.0',
          checksumHash: dossierChecksum,
        })
      );

      const program = createTestProgram();
      registerEvidenceCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'evidence',
          'sync',
          'test.ds.md',
          '--namespace',
          'Bad_NS',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid evidence record')
      );
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
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
