import crypto from 'node:crypto';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerChecksumCommand } from '../../commands/checksum';
import { createTestProgram, makeDossier } from '../helpers/test-utils';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

describe('checksum command', () => {
  beforeEach(() => {
    // Mocks are reset by global afterEach (setup.ts)
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.writeFileSync.mockReset();
  });

  it('should exit 1 when file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'nonexistent.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  it('should exit 1 for invalid dossier format', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not a dossier');
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'bad.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Invalid dossier format'));
  });

  it('should display checksum for valid dossier', async () => {
    const content = makeDossier();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SHA256'));
  });

  it('should output only hash with --quiet', async () => {
    const content = makeDossier();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--quiet'])
    ).rejects.toThrow();

    // Should output just a hex hash
    const calls = vi.mocked(console.log).mock.calls;
    expect(calls[0][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should verify valid checksum with --verify', async () => {
    const body = '\n\n# Test Dossier\n\nBody content here.\n';
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    const content = `---dossier\n${JSON.stringify({ title: 'Test', checksum: { algorithm: 'sha256', hash } }, null, 2)}\n---\n${body}`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--verify'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum valid'));
  });

  it('should detect mismatch with --verify', async () => {
    const content = `---dossier\n${JSON.stringify({ title: 'Test', checksum: { algorithm: 'sha256', hash: 'badhash' } }, null, 2)}\n---\nBody`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--verify'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'));
  });

  it('should update checksum with --update', async () => {
    const content = makeDossier();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--update'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum added'));
  });

  it('should report "Checksum updated" when body changed with --update', async () => {
    const body = '\n\n# Test Dossier\n\nBody content here.\n';
    const staleHash = crypto.createHash('sha256').update('different body', 'utf8').digest('hex');
    const frontmatter = {
      dossier_schema_version: '1.0',
      title: 'Test Dossier',
      version: '1.0.0',
      objective: 'Test objective',
      risk_level: 'low',
      status: 'Draft',
      category: ['testing'],
      checksum: { algorithm: 'sha256', hash: staleHash },
    };
    const content = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--update'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum updated'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(staleHash));
  });

  it('should report "Body checksum unchanged" + note when only frontmatter changed with --update', async () => {
    const body = '\n\n# Test Dossier\n\nBody content here.\n';
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    const frontmatter = {
      dossier_schema_version: '1.0',
      title: 'Test Dossier',
      version: '1.0.0',
      objective: 'Test objective',
      risk_level: 'low',
      status: 'Draft',
      category: ['testing'],
      name: 'Added Name',
      checksum: { hash },
    };
    const content = `---dossier\n${JSON.stringify(frontmatter, null, 4)}\n---\n${body}`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--update'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Body checksum unchanged'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('frontmatter changed'));
  });

  it('should report "Checksum unchanged" and skip write when nothing changed with --update', async () => {
    const body = '\n\n# Test Dossier\n\nBody content here.\n';
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    const frontmatter = {
      dossier_schema_version: '1.0',
      title: 'Test Dossier',
      version: '1.0.0',
      objective: 'Test objective',
      risk_level: 'low',
      status: 'Draft',
      category: ['testing'],
      checksum: { algorithm: 'sha256', hash },
    };
    const content = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerChecksumCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'checksum', 'test.ds.md', '--update'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Checksum unchanged'));
  });
});
