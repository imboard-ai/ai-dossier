import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerInitCommand } from '../../commands/init';
import * as config from '../../config';
import * as hooks from '../../hooks';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../config');
vi.mock('../../hooks');

const mockedFs = vi.mocked(fs);

describe('init command', () => {
  beforeEach(() => {
    mockedFs.existsSync.mockReset();
    mockedFs.mkdirSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    vi.mocked(config.saveConfig).mockReset();
    vi.mocked(hooks.installClaudeHook).mockReset();
    vi.mocked(hooks.installMcpServer).mockReset();
  });

  it('should create directories when they do not exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(config.saveConfig).mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(true);
    vi.mocked(hooks.installMcpServer).mockReturnValue('installed');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(mockedFs.mkdirSync).toHaveBeenCalledTimes(2);
    expect(config.saveConfig).toHaveBeenCalled();
    expect(hooks.installClaudeHook).toHaveBeenCalled();
    expect(hooks.installMcpServer).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('initialized'));
  });

  it('should skip existing directories', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('already');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  it('should skip hooks with --skip-hooks', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installMcpServer).mockReturnValue('already');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init', '--skip-hooks']);

    expect(hooks.installClaudeHook).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipped'));
  });

  it('should skip MCP with --skip-mcp', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init', '--skip-mcp']);

    expect(hooks.installMcpServer).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--skip-mcp'));
  });

  it('should report MCP server installed', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('installed');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Configured MCP server'));
  });

  it('should report MCP server already configured', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('already');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('MCP server already configured')
    );
  });

  it('should show fallback instructions on MCP error', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('error');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Could not configure MCP server')
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'));
  });

  it("should print What's next? summary", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('installed');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("What's next?"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ai-dossier search'));
  });

  it('should show Claude Code tip when MCP is configured', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);
    vi.mocked(hooks.installMcpServer).mockReturnValue('installed');

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Claude Code can now discover')
    );
  });

  it('should not show Claude Code tip when MCP is skipped', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(hooks.installClaudeHook).mockReturnValue(false);

    const program = createTestProgram();
    registerInitCommand(program);

    await program.parseAsync(['node', 'dossier', 'init', '--skip-mcp']);

    const logCalls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
    expect(logCalls).not.toContainEqual(expect.stringContaining('Claude Code can now discover'));
  });
});
