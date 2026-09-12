import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(import.meta.dirname, 'refresh-fleet.sh');
const PROFILE_PATH = join(import.meta.dirname, 'sched-fleet', 'dispatch-profiles.json');
const BOOTSTRAP_PATH = join(import.meta.dirname, 'sched-fleet', 'bootstrap.sh');
const CRON_LIB_PATH = join(import.meta.dirname, 'sched-fleet', 'cron-lib.sh');
const tempRoots = [];

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fixture(maxSlots) {
  const home = mkdtempSync(join(tmpdir(), 'refresh-fleet-'));
  tempRoots.push(home);
  const bin = join(home, 'bin');
  const fleet = join(home, 'fleet');
  const project = join(home, '.dossier', 'sched', 'test-project');
  mkdirSync(bin, { recursive: true });
  if (maxSlots !== undefined) {
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'config.json'),
      `${JSON.stringify(
        {
          schema_version: '1.9.0',
          max_slots: maxSlots,
          dispatch: { command: ['claude'], tier_models: { mechanical: 'haiku' } },
        },
        null,
        2
      )}\n`
    );
  }
  executable(
    join(bin, 'npm'),
    '#!/bin/sh\ncase "$*" in\n  "root -g") printf \'%s\\n\' "$HOME/global" ;;\n  "view @ai-dossier/cli version") printf \'0.39.0\\n\' ;;\n  *) exit 0 ;;\nesac\n'
  );
  executable(
    join(bin, 'ai-dossier'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'0.39.0\\n\'; fi\nexit 0\n'
  );
  return { home, bin, fleet, project };
}

function runRefresh(box) {
  return execFileSync('bash', [SCRIPT_PATH, '--hosts', 'wls'], {
    env: {
      ...process.env,
      HOME: box.home,
      PATH: `${box.bin}:${process.env.PATH}`,
      SCHED_PROFILE_FLEET_HOME: box.fleet,
      SCHED_PROFILE_FILE: PROFILE_PATH,
      SCHED_BOOTSTRAP_FILE: BOOTSTRAP_PATH,
    },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('refresh-fleet.sh', () => {
  it('writes profiles to user config without requiring or modifying a project scheduler config', () => {
    const box = fixture(undefined);
    mkdirSync(join(box.home, '.dossier'), { recursive: true });
    writeFileSync(
      join(box.home, '.dossier', 'config.json'),
      `${JSON.stringify({ theme: 'dark' })}\n`
    );

    runRefresh(box);

    const profiles = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    const config = JSON.parse(readFileSync(join(box.home, '.dossier', 'config.json'), 'utf8'));
    expect(config).toEqual({ theme: 'dark', dispatch_profiles: profiles });
    expect(existsSync(join(box.project, 'config.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(box.fleet, 'dispatch-profiles.json'), 'utf8'))).toEqual(
      profiles
    );
    expect(readFileSync(join(box.fleet, 'bootstrap.sh'), 'utf8')).toBe(
      readFileSync(BOOTSTRAP_PATH, 'utf8')
    );
    expect(readFileSync(join(box.fleet, 'cron-lib.sh'), 'utf8')).toBe(
      readFileSync(CRON_LIB_PATH, 'utf8')
    );
  });
});
