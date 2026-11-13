import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReexecTargetVersions } from '../engine-version';

/** Lay out a fake npm global prefix: bin/ai-dossier -> lib/node_modules/@ai-dossier/cli/bin/ai-dossier. */
function makePrefix(root: string, cliVersion: string, schedVersion: string | null): string {
  const cliDir = path.join(root, 'lib', 'node_modules', '@ai-dossier', 'cli');
  fs.mkdirSync(path.join(cliDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(cliDir, 'package.json'),
    JSON.stringify({ name: '@ai-dossier/cli', version: cliVersion })
  );
  fs.writeFileSync(path.join(cliDir, 'bin', 'ai-dossier'), '#!/usr/bin/env node\n');
  if (schedVersion !== null) {
    const schedDir = path.join(cliDir, 'node_modules', '@ai-dossier', 'sched');
    fs.mkdirSync(schedDir, { recursive: true });
    fs.writeFileSync(
      path.join(schedDir, 'package.json'),
      JSON.stringify({ name: '@ai-dossier/sched', version: schedVersion, main: 'index.js' })
    );
  }
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const bin = path.join(root, 'bin', 'ai-dossier');
  fs.symlinkSync(path.join(cliDir, 'bin', 'ai-dossier'), bin);
  return bin;
}

describe('readReexecTargetVersions', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reexec-target-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('follows the bin symlink to the cli package and reads cli + nested sched versions from disk', () => {
    const bin = makePrefix(tmp, '0.93.3', '0.70.1');
    const result = readReexecTargetVersions(bin);
    expect(result.cli).toBe('0.93.3');
    expect(result.sched).toBe('0.70.1');
    expect(result.packageDir).toBe(
      fs.realpathSync(path.join(tmp, 'lib', 'node_modules', '@ai-dossier', 'cli'))
    );
  });

  it('sees an in-place reinstall (same prefix) immediately — no module cache', () => {
    const bin = makePrefix(tmp, '0.93.3', '0.70.1');
    expect(readReexecTargetVersions(bin).cli).toBe('0.93.3');
    fs.writeFileSync(
      path.join(tmp, 'lib', 'node_modules', '@ai-dossier', 'cli', 'package.json'),
      JSON.stringify({ name: '@ai-dossier/cli', version: '0.93.4' })
    );
    expect(readReexecTargetVersions(bin).cli).toBe('0.93.4');
  });

  it('leaves sched null when it cannot be resolved from the cli package', () => {
    const bin = makePrefix(tmp, '0.93.3', null);
    const result = readReexecTargetVersions(bin);
    expect(result.cli).toBe('0.93.3');
    // May resolve a hoisted sched elsewhere on the walk-up only if one exists
    // above tmp; under os.tmpdir() there is none.
    expect(result.sched).toBeNull();
  });

  it('returns all-null for a missing path or a script outside any cli package', () => {
    expect(readReexecTargetVersions(undefined)).toEqual({
      cli: null,
      sched: null,
      packageDir: null,
    });
    expect(readReexecTargetVersions(path.join(tmp, 'nope'))).toEqual({
      cli: null,
      sched: null,
      packageDir: null,
    });
    const loose = path.join(tmp, 'script.js');
    fs.writeFileSync(loose, '');
    expect(readReexecTargetVersions(loose).cli).toBeNull();
  });
});
