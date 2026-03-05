import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerValidateCommand } from '../../commands/validate';
import { createTestProgram, makeDossier } from '../helpers/test-utils';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

describe('validate command', () => {
  beforeEach(() => {
    // Mocks are reset by global afterEach (setup.ts)
  });

  it('should exit 1 when file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'missing.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  it('should pass for valid dossier with all required fields', async () => {
    const content = makeDossier({
      dossier_schema_version: '1.0.0',
      title: 'Test',
      version: '1.0.0',
      objective: 'Test',
      risk_level: 'low',
      status: 'Draft',
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Valid'));
  });

  it('should fail for dossier missing required fields', async () => {
    const content = `---dossier\n${JSON.stringify({ title: 'Test' }, null, 2)}\n---\nBody`;
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Missing required field'));
  });

  it('should fail for content without frontmatter', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('# Just markdown');
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No frontmatter'));
  });

  it('should output JSON with --json', async () => {
    const content = makeDossier({
      dossier_schema_version: '1.0.0',
      title: 'Test',
      version: '1.0.0',
      objective: 'Test',
      risk_level: 'low',
      status: 'Draft',
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md', '--json'])
    ).rejects.toThrow();

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"valid"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
    const output = JSON.parse(jsonCalls[0][0]);
    expect(output.valid).toBe(true);
  });

  it('should treat warnings as errors with --strict', async () => {
    // Missing recommended fields will produce warnings
    const content = `---dossier\n${JSON.stringify(
      {
        dossier_schema_version: '1.0.0',
        title: 'Test',
        version: '1.0.0',
      },
      null,
      2
    )}\n---\nBody`;
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerValidateCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md', '--strict'])
    ).rejects.toThrow();
  });

  it('should warn about invalid risk_level', async () => {
    const content = makeDossier({ risk_level: 'extreme' });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);
    const program = createTestProgram();
    registerValidateCommand(program);

    // Not strict, so warnings don't cause failure if no errors
    await expect(program.parseAsync(['node', 'dossier', 'validate', 'test.ds.md'])).rejects.toThrow(
      'process.exit'
    );

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unknown risk_level'));
  });
});
