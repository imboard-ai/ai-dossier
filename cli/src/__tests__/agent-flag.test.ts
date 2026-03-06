import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cliPath = path.resolve(__dirname, '../../src/cli.ts');

function runCli(args: string[]): string {
  return execFileSync('npx', ['tsx', cliPath, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

describe('--agent flag', () => {
  it('should output valid JSON capability manifest', () => {
    const output = runCli(['--agent']);
    const manifest = JSON.parse(output);

    expect(manifest.agent_protocol).toBe('1.0');
    expect(manifest.cli).toBe('ai-dossier');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.discovery_command).toBe('ai-dossier commands');
    expect(manifest.capabilities).toEqual({
      json_output: '--json',
      skip_prompts: '-y / --yes',
      non_tty_safe: true,
      machine_errors: true,
      multi_registry: true,
    });
    expect(manifest.quick_start).toBeInstanceOf(Array);
    expect(manifest.quick_start.length).toBeGreaterThan(0);

    // Registry section should describe multi-registry support
    expect(manifest.registry).toBeDefined();
    expect(manifest.registry.commands).toBeDefined();
    expect(manifest.registry.env_vars).toBeInstanceOf(Array);
    expect(manifest.registry.env_vars).toContain('DOSSIER_REGISTRY_URL');
    expect(manifest.registry.project_config).toBe('.dossierrc.json');
  });

  it('should include agent hint in --help output', () => {
    const output = runCli(['--help']);
    expect(output).toContain('ai-dossier --agent');
    expect(output).toContain('Agent-friendly');
  });
});
