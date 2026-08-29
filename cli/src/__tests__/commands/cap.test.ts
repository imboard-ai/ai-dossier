import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendCapLog } from '../../cap-log';
import { compareVersions, parseCapabilityManifest } from '../../capability';
import { registerCapCommand } from '../../commands/cap';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../cap-log', () => ({
  appendCapLog: vi.fn(),
}));

const mockedAppendCapLog = vi.mocked(appendCapLog);

/** Run `cap ...` against the current cwd; returns all console.log calls. */
async function runCap(...args: string[]): Promise<string[][]> {
  const program = createTestProgram();
  registerCapCommand(program);
  await program.parseAsync(['node', 'dossier', 'cap', ...args]);
  return vi.mocked(console.log).mock.calls.map((c) => c.map(String));
}

describe('cap command', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
    process.chdir(tmpDir);
    mockedAppendCapLog.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeManifest = (yaml: string): string => {
    const dir = path.join(tmpDir, '.dossier', 'automation');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'manifest.yaml');
    fs.writeFileSync(file, yaml);
    return file;
  };

  describe('cap list', () => {
    it('shows an empty list with success exit when no manifest exists', async () => {
      const logs = await runCap('list');

      expect(logs.flat().join('\n')).toContain('(none)');
      // No process.exit → parseAsync resolved; the absent manifest is portable
    });

    it('lists capabilities with lifecycle, command, and description', async () => {
      writeManifest(`
capabilities:
  test.focused:
    command: npm test
    lifecycle: active
    description: Focused vitest suite
  lint.run:
    command: npm run lint
    lifecycle: shadow
    description: Biome check
`);

      const logs = await runCap('list');
      const out = logs.flat().join('\n');

      expect(out).toContain('test.focused');
      expect(out).toContain('active');
      expect(out).toContain('npm test');
      expect(out).toContain('lint.run');
      expect(out).toContain('shadow');
    });

    it('emits JSON with --json', async () => {
      writeManifest(`
capabilities:
  test.focused:
    command: npm test
    description: Focused vitest suite
`);

      const logs = await runCap('list', '--json');
      const parsed = JSON.parse(logs[logs.length - 1][0]);

      expect(parsed.manifest).toBe(path.join(tmpDir, '.dossier', 'automation', 'manifest.yaml'));
      expect(parsed.capabilities).toHaveLength(1);
      expect(parsed.capabilities[0]).toEqual({
        id: 'test.focused',
        lifecycle: 'active',
        command: 'npm test',
        description: 'Focused vitest suite',
      });
    });

    it('fails with exit 1 on a malformed manifest', async () => {
      writeManifest('capabilities: [not, a, mapping]\n');

      await expect(runCap('list')).rejects.toThrow('process.exit(1)');
      expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('invalid');
    });

    it('fails with exit 1 when an entry is missing its command', async () => {
      writeManifest(`
capabilities:
  test.focused:
    lifecycle: active
`);

      await expect(runCap('list')).rejects.toThrow('process.exit(1)');
      expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
        "requires a non-empty 'command'"
      );
    });
  });

  describe('cap run — outcome: ok', () => {
    it('exits 0 and reports ok for a succeeding command', async () => {
      writeManifest(`
capabilities:
  echo.ok:
    command: node -e "process.exit(0)"
    lifecycle: active
`);

      await expect(runCap('run', 'echo.ok')).rejects.toThrow('process.exit(0)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('ok');
      expect(envelope.exit_code).toBe(0);
      expect(envelope.capability).toBe('echo.ok');
      expect(typeof envelope.duration_ms).toBe('number');

      expect(mockedAppendCapLog).toHaveBeenCalledTimes(1);
      expect(mockedAppendCapLog.mock.calls[0][0]).toMatchObject({
        capability: 'echo.ok',
        outcome: 'ok',
        exit_code: 0,
      });
      expect(typeof mockedAppendCapLog.mock.calls[0][0].duration_ms).toBe('number');
    });

    it('appends extra args after -- to the command', async () => {
      writeManifest(`
capabilities:
  echo.args:
    command: node -e "require('fs').writeFileSync('args.txt', process.argv.slice(1).join(','))"
`);

      await expect(runCap('run', 'echo.args', 'alpha', 'beta')).rejects.toThrow('process.exit(0)');

      expect(fs.readFileSync(path.join(tmpDir, 'args.txt'), 'utf-8')).toBe('alpha,beta');
    });
  });

  describe('cap run — outcome: task-failed', () => {
    it('exits 1 and reports task-failed when the command legitimately fails', async () => {
      writeManifest(`
capabilities:
  red.tests:
    command: node -e "process.exit(1)"
`);

      await expect(runCap('run', 'red.tests')).rejects.toThrow('process.exit(1)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('task-failed');
      expect(envelope.exit_code).toBe(1);

      expect(mockedAppendCapLog.mock.calls[0][0]).toMatchObject({
        capability: 'red.tests',
        outcome: 'task-failed',
      });
    });
  });

  describe('cap run — outcome: automation-broken', () => {
    it('exits 2 when a file-exists probe fails — and the command never runs', async () => {
      writeManifest(`
capabilities:
  guarded:
    command: node -e "require('fs').writeFileSync('sentinel.txt', 'ran')"
    assumptions:
      - file-exists: definitely-missing-file.txt
`);

      await expect(runCap('run', 'guarded')).rejects.toThrow('process.exit(2)');

      // Probe failure must prevent execution entirely
      expect(fs.existsSync(path.join(tmpDir, 'sentinel.txt'))).toBe(false);

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('automation-broken');
      expect(envelope.reason).toContain('file-exists');
      expect(envelope.reason).toContain('not run');

      expect(mockedAppendCapLog.mock.calls[0][0]).toMatchObject({
        capability: 'guarded',
        outcome: 'automation-broken',
      });
    });

    it('exits 2 when a tool-version probe fails', async () => {
      writeManifest(`
capabilities:
  needs.new.node:
    command: node -e "process.exit(0)"
    assumptions:
      - tool-version: node>=99999
`);

      await expect(runCap('run', 'needs.new.node')).rejects.toThrow('process.exit(2)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('automation-broken');
      expect(envelope.reason).toContain('tool-version');
    });

    it('passes a satisfied tool-version probe and runs the command', async () => {
      writeManifest(`
capabilities:
  needs.old.node:
    command: node -e "process.exit(0)"
    assumptions:
      - tool-version: node>=4
`);

      await expect(runCap('run', 'needs.old.node')).rejects.toThrow('process.exit(0)');
    });

    it('exits 2 when the command binary is missing (exit 127)', async () => {
      writeManifest(`
capabilities:
  missing.bin:
    command: definitely-not-a-real-binary-xyz-463
`);

      await expect(runCap('run', 'missing.bin')).rejects.toThrow('process.exit(2)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('automation-broken');
      expect(envelope.reason).toContain('127');
    });

    it('exits 2 on abnormal termination (killed by a signal)', async () => {
      writeManifest(`
capabilities:
  suicide:
    command: node -e "process.kill(process.pid, 'SIGKILL')"
`);

      await expect(runCap('run', 'suicide')).rejects.toThrow('process.exit(2)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('automation-broken');
      expect(envelope.reason).toContain('abnormal termination');
    });
  });

  describe('cap run — outcome: capability-unavailable', () => {
    it('exits 3 for an id that is not in the manifest', async () => {
      writeManifest(`
capabilities:
  real.cap:
    command: node -e "process.exit(0)"
`);

      await expect(runCap('run', 'no.such.cap')).rejects.toThrow('process.exit(3)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('capability-unavailable');
      expect(envelope.reason).toContain('no.such.cap');

      // Every cap run is telemetried, including unavailable ones
      expect(mockedAppendCapLog.mock.calls[0][0]).toMatchObject({
        capability: 'no.such.cap',
        outcome: 'capability-unavailable',
      });
    });

    it('exits 3 when no manifest exists at all', async () => {
      await expect(runCap('run', 'anything')).rejects.toThrow('process.exit(3)');
    });

    it('exits 3 for a shadow lifecycle entry, with a reason', async () => {
      writeManifest(`
capabilities:
  shadow.cap:
    command: node -e "process.exit(0)"
    lifecycle: shadow
`);

      await expect(runCap('run', 'shadow.cap')).rejects.toThrow('process.exit(3)');

      const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      const envelope = JSON.parse(calls[calls.length - 1]);
      expect(envelope.outcome).toBe('capability-unavailable');
      expect(envelope.reason).toContain('lifecycle=shadow');
    });
  });
});

describe('capability engine (pure)', () => {
  describe('parseCapabilityManifest', () => {
    it('parses entries with defaults and probes', () => {
      const caps = parseCapabilityManifest(`
version: 1
capabilities:
  test.focused:
    command: npm test
    description: Focused suite
    assumptions:
      - file-exists: package.json
      - tool-version: node>=20
`);

      expect(caps['test.focused']).toEqual({
        command: 'npm test',
        lifecycle: 'active',
        description: 'Focused suite',
        assumptions: [
          { kind: 'file-exists', target: 'package.json' },
          { kind: 'tool-version', tool: 'node', op: '>=', version: '20' },
        ],
      });
    });

    it('rejects an invalid capability id', () => {
      expect(() => parseCapabilityManifest('capabilities:\n  Bad_ID:\n    command: x\n')).toThrow(
        /invalid/
      );
    });

    it('rejects an unknown probe kind', () => {
      expect(() =>
        parseCapabilityManifest(
          'capabilities:\n  a.b:\n    command: x\n    assumptions:\n      - magic: yes\n'
        )
      ).toThrow(/unknown probe kind/);
    });

    it('rejects an unsupported manifest version', () => {
      expect(() =>
        parseCapabilityManifest('version: 2\ncapabilities:\n  a.b:\n    command: x\n')
      ).toThrow(/unsupported manifest version/);
    });
  });

  describe('compareVersions', () => {
    it('compares numerically across segment counts', () => {
      expect(compareVersions('20.11.0', '20')).toBeGreaterThan(0);
      expect(compareVersions('20', '20.0.0')).toBe(0);
      expect(compareVersions('18.20.4', '20')).toBeLessThan(0);
      expect(compareVersions('1.2.3', '1.2.10')).toBeLessThan(0);
    });
  });
});
