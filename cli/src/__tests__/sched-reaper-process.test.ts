import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { procStatFields } from '@ai-dossier/sched';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/sched-reaper-fixture.mjs', import.meta.url));

describe('#1244 inherited child recovery', () => {
  it.each([
    'legacy',
    'worker',
  ])('reaps after a real parent exit following %s ownership loss', async (mode) => {
    if (process.platform !== 'linux' || (mode === 'legacy' && typeof process.execve !== 'function'))
      return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reaper-'));
    const child = spawn(process.execPath, [fixture, mode, dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect({ code, output }).toEqual({
        code: 75,
        output: expect.stringContaining('live-fenced; zombie-dead; supervisor-restart=75'),
      });
      const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
      for (let n = 0; n < 500 && procStatFields(pid) !== null; n++) await delay(10);
      expect(procStatFields(pid)).toBeNull(); // OS reaper, not just false signal-0 liveness
    } finally {
      clearTimeout(timeout);
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
