import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmptyState,
  enqueueEntries,
  SCHEMA_VERSION,
  type SchedState,
  SchedStore,
} from '@ai-dossier/sched';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('./fixtures/sched-upgrade-fixture.mjs', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scheduler CLI self-upgrade (two-version process integration)', () => {
  it('replaces the old process, migrates state in the new version, and performs no old-version write after install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-upgrade-process-'));
    dirs.push(root);
    const stateDir = path.join(root, 'state');
    const versionFile = path.join(root, 'installed-cli-version');
    const timelineFile = path.join(root, 'timeline.jsonl');
    const store = new SchedStore(stateDir);
    const current = enqueueEntries(
      createEmptyState(),
      [{ issue: 945, mode: 'full' }],
      new Date('2026-10-02T00:00:00.000Z')
    );
    const legacy = {
      ...current,
      schema_version: '1.29.0',
      entries: current.entries.map(
        ({ ground_truth_unreachable_condition: _condition, ...entry }) => entry
      ),
    } as unknown as SchedState;
    store.save(legacy);
    fs.writeFileSync(versionFile, '0.89.5');

    let output = '';
    const runFixture = () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(process.execPath, [FIXTURE, versionFile, stateDir, timelineFile], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`upgrade process timed out: ${output}`));
        }, 15_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
    let result = await runFixture();
    // Node 20 lacks process.execve; in that case exit 75 delegates the re-exec
    // to the supervisor, which starts the same now-updated entry point.
    if (result.code === 75) result = await runFixture();

    expect(result).toEqual({ code: 0, signal: null });
    expect(fs.readFileSync(versionFile, 'utf8')).toBe('0.89.6');
    expect(fs.readFileSync(timelineFile, 'utf8').trim().split('\n')).toEqual([
      'old-start:0.89.5',
      'install-complete:0.89.6',
      `new-load:0.89.6:schema=${SCHEMA_VERSION}:unreachable=null`,
      `new-write:0.89.6:schema=${SCHEMA_VERSION}`,
    ]);
    expect(store.load().schema_version).toBe(SCHEMA_VERSION);
    expect(store.load().paused).toBe(true);
  }, 20_000);
});
