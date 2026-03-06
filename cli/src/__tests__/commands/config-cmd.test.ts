import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerConfigCommand } from '../../commands/config-cmd';
import * as config from '../../config';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../config');

describe('config command', () => {
  beforeEach(() => {
    // Mocks are reset by global afterEach (setup.ts)
    vi.mocked(config.loadConfig).mockReturnValue({
      defaultLlm: 'auto',
      theme: 'auto',
      auditLog: true,
    });
    vi.mocked(config.DEFAULT_CONFIG).defaultLlm = 'auto';
    vi.mocked(config.DEFAULT_CONFIG).theme = 'auto';
    vi.mocked(config.DEFAULT_CONFIG).auditLog = true;
  });

  it('should list config with --list', async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'config', '--list'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Current Configuration'));
  });

  it('should list config when no args given', async () => {
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'config'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Current Configuration'));
  });

  it('should get a specific config value', async () => {
    vi.mocked(config.getConfig).mockReturnValue('auto');
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'config', 'defaultLlm'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith('defaultLlm: auto');
  });

  it('should exit 1 for unknown key', async () => {
    vi.mocked(config.getConfig).mockReturnValue(undefined);
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'config', 'unknownKey'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unknown configuration key'));
  });

  it('should set a config value', async () => {
    vi.mocked(config.setConfig).mockReturnValue(true);
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'config', 'defaultLlm', 'claude-code'])
    ).rejects.toThrow();

    expect(config.setConfig).toHaveBeenCalledWith('defaultLlm', 'claude-code');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Configuration updated'));
  });

  it('should warn for non-standard key', async () => {
    vi.mocked(config.setConfig).mockReturnValue(true);
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'config', 'customKey', 'value'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not a standard config key'));
  });

  it('should reset config with --reset', async () => {
    vi.mocked(config.saveConfig).mockReturnValue(true);
    const program = createTestProgram();
    registerConfigCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'config', '--reset'])).rejects.toThrow();

    expect(config.saveConfig).toHaveBeenCalledWith(config.DEFAULT_CONFIG);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reset to defaults'));
  });

  describe('--add-registry HTTPS validation', () => {
    it('should reject http:// registry URLs', async () => {
      const program = createTestProgram();
      registerConfigCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'config',
          '--add-registry',
          'insecure',
          '--url',
          'http://registry.example.com',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Registry URL must use HTTPS')
      );
    });

    it('should reject file:// registry URLs', async () => {
      const program = createTestProgram();
      registerConfigCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'config',
          '--add-registry',
          'local',
          '--url',
          'file:///etc/passwd',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Registry URL must use HTTPS')
      );
    });

    it('should reject invalid URLs', async () => {
      const program = createTestProgram();
      registerConfigCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'config',
          '--add-registry',
          'bad',
          '--url',
          'not-a-url',
        ])
      ).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid URL'));
    });

    it('should accept https:// registry URLs', async () => {
      vi.mocked(config.saveConfig).mockReturnValue(true);
      const program = createTestProgram();
      registerConfigCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'config',
          '--add-registry',
          'secure',
          '--url',
          'https://registry.example.com',
        ])
      ).rejects.toThrow();

      expect(config.saveConfig).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Added registry 'secure'"));
    });
  });
});
