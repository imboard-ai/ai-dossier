import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cacheResolver from '../../cache-resolver';
import { registerCreateCommand } from '../../commands/create';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../../config');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../cache-resolver');
vi.mock('../../helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../helpers')>();
  return {
    ...actual,
    detectLlm: vi.fn(),
  };
});

const mockedFs = vi.mocked(fs);

// Import after mock setup
const { detectLlm } = await import('../../helpers');

describe('create command', () => {
  beforeEach(() => {
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
    vi.mocked(cacheResolver.resolveCachedVersion).mockResolvedValue({
      version: '1.0.0',
      source: 'registry',
      registry: 'public',
    });
    // Auto-mock returns undefined; the production code uses `!== null` to detect
    // cache misses, so undefined would be a false cache hit. Default to "no cache".
    vi.mocked(cacheResolver.readCachedContent).mockReturnValue(null);
    vi.mocked(cacheResolver.writeCachedContent).mockImplementation(() => undefined);
    vi.mocked(cacheResolver.parseMaxAgeOption).mockImplementation((raw: string | undefined) =>
      raw === undefined ? undefined : Number(raw)
    );
  });

  it('should exit 2 when LLM not detected', async () => {
    vi.mocked(detectLlm).mockReturnValue(null);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();
  });

  it('should exit 2 when template not found in registry', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    // Resolver returns a version but content fetch fails — exercises the
    // "Template not found" branch in create.ts.
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: null,
      errors: [],
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Template not found'));
  });

  it('should fetch template from registry and launch LLM', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Meta dossier content', _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await program.parseAsync(['node', 'dossier', 'create', '--title', 'My Dossier']);

    expect(spawnSync).toHaveBeenCalledWith('claude', [expect.stringContaining('dossier-create-')], {
      stdio: 'inherit',
    });
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(mockedFs.unlinkSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('should clean up temp file on exec failure', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as any);

    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Meta dossier', _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();

    expect(mockedFs.unlinkSync).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('creation failed'));
  });
});
