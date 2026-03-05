import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPublishCommand } from '../../commands/publish';
import * as credentials from '../../credentials';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:readline');
vi.mock('../../credentials');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

const validDossier = `---dossier
{"title":"Test Dossier","version":"1.0.0","name":"test-dossier","risk_level":"low","status":"stable"}
---
Body content here`;

describe('publish command', () => {
  const mockClient = { publishDossier: vi.fn(), getDossier: vi.fn() };

  beforeEach(() => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: ['org'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);
    vi.mocked(registryClient.getClient).mockReturnValue(mockClient as any);
    mockClient.getDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(validDossier);
  });

  it('should exit 1 when not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 when credentials expired', async () => {
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should exit 1 when file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'missing.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  it('should exit 1 on invalid dossier format', async () => {
    mockedFs.readFileSync.mockReturnValue('no frontmatter');

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid dossier format'));
  });

  it('should exit 1 on missing required fields', async () => {
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"name":"test"}\n---\nBody');

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Validation errors'));
  });

  it('should publish with --yes flag and show full registry path', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith('org', validDossier, null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('org/test-dossier@1.0.0'));
  });

  it('should exit 1 on same-version collision (pre-publish check)', async () => {
    mockClient.getDossier.mockReset();
    // First call (with version) returns existing dossier — same version exists
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });

    const program = createTestProgram();
    registerPublishCommand(program);

    // In vitest v4, process.exit records the call but doesn't halt execution
    try {
      await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);
    } catch {
      // Expected — process.exit throws in vitest v4
    }

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Version collision: org/test-dossier@1.0.0 already exists')
    );
  });

  it('should output JSON on same-version collision with --json flag', async () => {
    mockClient.getDossier.mockReset();
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '1.0.0' });

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json'])
    ).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.error === 'version_exists';
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.success).toBe(false);
    expect(output.path).toBe('org/test-dossier');
  });

  it('should publish with --json flag and output structured result', async () => {
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.success === true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.registryPath).toBe('org/test-dossier@1.0.0');
    expect(output.url).toBe('https://registry.example.com/dossiers/org/test-dossier');
  });

  it('should exit 1 on 409 version conflict from server', async () => {
    mockClient.publishDossier.mockRejectedValue(
      Object.assign(new Error('Version exists'), { statusCode: 409 })
    );

    const program = createTestProgram();
    registerPublishCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Version conflict'));
  });

  it('should warn when dossier exists at different version', async () => {
    mockClient.getDossier.mockReset();
    // First call (with version) — 404 (specific version doesn't exist)
    mockClient.getDossier.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    // Second call (without version) — dossier exists at different version
    mockClient.getDossier.mockResolvedValueOnce({ name: 'org/test-dossier', version: '0.9.0' });

    mockClient.publishDossier.mockResolvedValue({
      name: 'org/test-dossier',
      content_url: 'https://registry.example.com/dossiers/org/test-dossier',
    });

    const program = createTestProgram();
    registerPublishCommand(program);

    await program.parseAsync(['node', 'dossier', 'publish', 'test.ds.md', '--yes']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated from v0.9.0'));
    expect(mockClient.publishDossier).toHaveBeenCalled();
  });
});
