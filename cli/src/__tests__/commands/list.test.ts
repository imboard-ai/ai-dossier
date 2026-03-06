import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerListCommand } from '../../commands/list';
import * as config from '../../config';
import * as helpers from '../../helpers';
import * as multiRegistry from '../../multi-registry';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../helpers');
vi.mock('../../config');

const mockedFs = vi.mocked(fs);

describe('list command', () => {
  beforeEach(() => {
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
    vi.mocked(helpers.parseListSource).mockReturnValue({ type: 'local', path: '.' });
    vi.mocked(helpers.formatTable).mockReturnValue('formatted table');
  });

  describe('registry source', () => {
    it('should list registry dossiers', async () => {
      vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
        dossiers: [
          {
            name: 'test-dossier',
            version: '1.0.0',
            title: 'Test',
            category: 'devops',
            _registry: 'public',
          },
        ] as any,
        total: 1,
        errors: [],
      });

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '--source', 'registry'])
      ).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Registry dossiers'));
    });

    it('should output JSON for registry', async () => {
      vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
        dossiers: [{ name: 'test', version: '1.0.0', _registry: 'public' }] as any,
        total: 1,
        errors: [],
      });

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '--source', 'registry', '--format', 'json'])
      ).rejects.toThrow();

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"dossiers"'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });

    it('should output JSON for registry with --json flag', async () => {
      vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
        dossiers: [{ name: 'test', version: '1.0.0', _registry: 'public' }] as any,
        total: 1,
        errors: [],
      });

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '--source', 'registry', '--json'])
      ).rejects.toThrow();

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"dossiers"'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });

    it('should show partial results warning when some registries fail', async () => {
      vi.mocked(config.resolveRegistries).mockReturnValue([
        { name: 'public', url: 'https://public.registry.com' },
        { name: 'private', url: 'https://private.registry.com' },
      ]);
      vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
        dossiers: [
          { name: 'test', version: '1.0.0', title: 'Test', category: 'dev', _registry: 'public' },
        ] as any,
        total: 1,
        errors: [{ registry: 'private', error: 'connection refused' }],
      });

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '--source', 'registry'])
      ).rejects.toThrow();

      expect(helpers.printRegistryErrors).toHaveBeenCalledWith(
        [{ registry: 'private', error: 'connection refused' }],
        'warning'
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Showing partial results (1/2 registries responded)')
      );
    });

    it('should show empty message for registry', async () => {
      vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
        dossiers: [],
        total: 0,
        errors: [],
      });

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '--source', 'registry'])
      ).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No dossiers found'));
    });
  });

  describe('local source', () => {
    it('should list local dossiers', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(helpers.findDossierFilesLocal).mockReturnValue(['test.ds.md']);
      vi.mocked(helpers.parseDossierMetadataLocal).mockReturnValue({
        path: 'test.ds.md',
        name: 'test',
        title: 'Test',
        version: '1.0.0',
        risk_level: 'low',
        category: 'dev',
        signed: false,
      } as any);

      const program = createTestProgram();
      registerListCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'list', '.'])).rejects.toThrow();

      expect(helpers.findDossierFilesLocal).toHaveBeenCalled();
    });

    it('should output JSON with --json flag', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(helpers.findDossierFilesLocal).mockReturnValue(['test.ds.md']);
      vi.mocked(helpers.parseDossierMetadataLocal).mockReturnValue({
        path: 'test.ds.md',
        name: 'test',
        title: 'Test',
        version: '1.0.0',
        risk_level: 'low',
        category: 'dev',
        signed: false,
      } as any);

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '.', '--json'])
      ).rejects.toThrow();

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"test.ds.md"'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });

    it('should exit 1 when directory not found', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerListCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'list', '/nonexistent'])
      ).rejects.toThrow();
    });
  });
});
