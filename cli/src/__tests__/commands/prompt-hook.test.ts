import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPromptHookCommand } from '../../commands/prompt-hook';
import * as helpers from '../../helpers';
import * as hooks from '../../hooks';
import * as multiRegistry from '../../multi-registry';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../helpers');
vi.mock('../../hooks');
vi.mock('../../multi-registry');

describe('prompt-hook command', () => {
  beforeEach(() => {
    // defaults
  });

  it('should exit 0 when no stdin', async () => {
    vi.mocked(helpers.readStdin).mockResolvedValue('');

    const program = createTestProgram();
    registerPromptHookCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'prompt-hook'])).rejects.toThrow();
  });

  it('should exit 0 when prompt does not match pattern', async () => {
    vi.mocked(helpers.readStdin).mockResolvedValue('{"prompt":"hello"}');
    vi.mocked(hooks.matchesHookPattern).mockReturnValue(false);

    const program = createTestProgram();
    registerPromptHookCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'prompt-hook'])).rejects.toThrow();
  });

  it('should output dossier list from cache', async () => {
    vi.mocked(helpers.readStdin).mockResolvedValue('{"prompt":"dossier run"}');
    vi.mocked(hooks.matchesHookPattern).mockReturnValue(true);
    vi.mocked(hooks.getCachedDossierList).mockReturnValue([
      { name: 'test-dossier', title: 'Test' },
      { name: 'deploy', title: 'Deploy App' },
    ]);

    const program = createTestProgram();
    registerPromptHookCommand(program);

    await program.parseAsync(['node', 'dossier', 'prompt-hook']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Available Dossier'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy'));
  });

  it('should fetch from registry when no cache', async () => {
    vi.mocked(helpers.readStdin).mockResolvedValue('{"prompt":"dossier run"}');
    vi.mocked(hooks.matchesHookPattern).mockReturnValue(true);
    vi.mocked(hooks.getCachedDossierList).mockReturnValue(null);
    vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
      dossiers: [{ name: 'fetched', title: 'Fetched Dossier', _registry: 'public' }] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerPromptHookCommand(program);

    await program.parseAsync(['node', 'dossier', 'prompt-hook']);

    expect(multiRegistry.multiRegistryList).toHaveBeenCalled();
    expect(hooks.saveDossierListCache).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('fetched'));
  });

  it('should exit 0 on error', async () => {
    vi.mocked(helpers.readStdin).mockRejectedValue(new Error('stdin error'));

    const program = createTestProgram();
    registerPromptHookCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'prompt-hook'])).rejects.toThrow();
  });
});
