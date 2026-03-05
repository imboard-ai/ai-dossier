import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/cli-wrapper', () => ({
  execCli: vi.fn(),
  CliNotFoundError: class CliNotFoundError extends Error {
    constructor() {
      super('ai-dossier CLI not found');
      this.name = 'CliNotFoundError';
    }
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CliNotFoundError, execCli } from '../../utils/cli-wrapper';
import { readDossier } from '../readDossier';

describe('readDossier tool', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    tempDir = join(tmpdir(), `dossier-read-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should read dossier metadata and body', async () => {
    const dossierContent = `---dossier
{
  "name": "test",
  "title": "Test Dossier",
  "version": "1.0.0"
}
---

# Test Dossier

This is the body.`;

    const filePath = join(tempDir, 'test.ds.md');
    writeFileSync(filePath, dossierContent);

    vi.mocked(execCli).mockResolvedValue({
      name: 'test',
      title: 'Test Dossier',
      version: '1.0.0',
    });

    const result = await readDossier({ path: filePath });

    expect(result.metadata).toEqual({
      name: 'test',
      title: 'Test Dossier',
      version: '1.0.0',
    });
    expect(result.body).toContain('# Test Dossier');
    expect(result.body).toContain('This is the body.');
    expect(execCli).toHaveBeenCalledWith('info', [filePath, '--json']);
  });

  it('should extract body from YAML frontmatter', async () => {
    const dossierContent = `---
name: test
title: Test
---

# Body Content`;

    const filePath = join(tempDir, 'yaml.ds.md');
    writeFileSync(filePath, dossierContent);

    vi.mocked(execCli).mockResolvedValue({ name: 'test', title: 'Test' });

    const result = await readDossier({ path: filePath });
    expect(result.body).toContain('# Body Content');
  });

  it('should reject paths outside working directory', async () => {
    await expect(readDossier({ path: '/etc/passwd' })).rejects.toThrow('Access denied');
  });

  it('should throw when CLI is not found', async () => {
    const filePath = join(tempDir, 'notfound.ds.md');
    writeFileSync(filePath, '---dossier\n{}\n---\n# Body');

    vi.mocked(execCli).mockRejectedValue(new CliNotFoundError());

    await expect(readDossier({ path: filePath })).rejects.toThrow('ai-dossier CLI not found');
  });
});
