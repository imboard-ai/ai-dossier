import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerCacheCommand } from '../../commands/cache';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:readline');

const mockedFs = vi.mocked(fs);

describe('cache command', () => {
  describe('cache list', () => {
    it('should show empty message when no cache dir', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'cache', 'list'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No cached'));
    });

    it('should list cached dossiers', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        { name: '1.0.0.meta.json', isDirectory: () => false } as any,
      ] as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cached_at: '2025-01-01T00:00:00Z' }));
      mockedFs.statSync.mockReturnValue({ size: 1024 } as any);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'cache', 'list'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cached dossiers'));
    });

    it('should show sizes with --size flag', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        { name: '1.0.0.meta.json', isDirectory: () => false } as any,
      ] as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cached_at: '2025-01-01T00:00:00Z' }));
      mockedFs.statSync.mockReturnValue({ size: 2048 } as any);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'list', '--size'])
      ).rejects.toThrow('process.exit(0)');

      // SIZE header should appear with --size
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SIZE'));
    });

    it('should not show sizes without --size flag', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        { name: '1.0.0.meta.json', isDirectory: () => false } as any,
      ] as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cached_at: '2025-01-01T00:00:00Z' }));
      mockedFs.statSync.mockReturnValue({ size: 512 } as any);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'cache', 'list'])).rejects.toThrow(
        'process.exit(0)'
      );

      // Check that SIZE header is NOT in any log call
      const logCalls = vi.mocked(console.log).mock.calls;
      const hasSizeHeader = logCalls.some((c) => typeof c[0] === 'string' && c[0].includes('SIZE'));
      expect(hasSizeHeader).toBe(false);
    });

    it('should output JSON with --json', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        { name: '1.0.0.meta.json', isDirectory: () => false } as any,
      ] as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cached_at: '2025-01-01T00:00:00Z' }));
      mockedFs.statSync.mockReturnValue({ size: 512 } as any);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'list', '--json'])
      ).rejects.toThrow('process.exit(0)');

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('name'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });
  });

  describe('cache clean', () => {
    it('should show empty message when no cache', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'clean', '--all'])
      ).rejects.toThrow('process.exit(0)');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No cached'));
    });

    it('should clean all with --all --yes', async () => {
      mockedFs.existsSync.mockReturnValue(true);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'clean', '--all', '--yes'])
      ).rejects.toThrow('process.exit(0)');

      expect(mockedFs.rmSync).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cache cleared'));
    });

    it('should exit 1 on invalid --older-than', async () => {
      mockedFs.existsSync.mockReturnValue(true);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'clean', '--older-than', 'abc', '--yes'])
      ).rejects.toThrow('process.exit(1)');

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('positive number'));
    });

    it('should remove specific version', async () => {
      mockedFs.existsSync.mockReturnValue(true);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'cache', 'clean', 'my-dossier', '-V', '1.0.0'])
      ).rejects.toThrow('process.exit(0)');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    });

    it('should show usage when no arguments', async () => {
      mockedFs.existsSync.mockReturnValue(true);

      const program = createTestProgram();
      registerCacheCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'cache', 'clean'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });
  });
});
