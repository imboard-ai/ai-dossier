import { spawnSync } from 'node:child_process';
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
    String.raw`#!/bin/sh
LATEST="\${STUB_LATEST:-0.82.0}"
case "$*" in
  "root -g") printf '%s\n' "$HOME/global" ;;
  "view @ai-dossier/cli version") printf '%s\n' "$LATEST" ;;
  *) exit 0 ;;
esac
`.replaceAll('\\$', '$')
  );
  // Stub CLI: logs every call to $HOME/calls.log; install-skill --all prints $STUB_SKILL_JSON
  // and exits with $STUB_SKILL_RC.
  executable(
    join(bin, 'ai-dossier'),
    String.raw`#!/bin/sh
echo "$*" >> "$HOME/calls.log"
if [ "$1" = "--version" ]; then printf '%s\n' "\${STUB_VERSION:-0.82.0}"; exit 0; fi
if [ "$1" = "install-skill" ]; then
  if [ -n "$STUB_SKILL_JSON" ]; then printf '%s\n' "$STUB_SKILL_JSON"
  else printf '%s\n' '{"success":true,"summary":{"ok":2,"skipped":0,"failed":0,"collisions":0},"results":[]}'; fi
  exit "\${STUB_SKILL_RC:-0}"
fi
exit 0
`.replaceAll('\\$', '$')
  );
  return { home, bin, fleet, project };
}

function runRefreshRaw(box, args = [], extraEnv = {}) {
  const res = spawnSync('bash', [SCRIPT_PATH, '--hosts', 'wls', ...args], {
    env: {
      ...process.env,
      HOME: box.home,
      PATH: `${box.bin}:${process.env.PATH}`,
      SCHED_PROFILE_FLEET_HOME: box.fleet,
      SCHED_PROFILE_FILE: PROFILE_PATH,
      SCHED_BOOTSTRAP_FILE: BOOTSTRAP_PATH,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function runRefresh(box) {
  const res = runRefreshRaw(box);
  if (res.status !== 0) throw new Error(`refresh-fleet exited ${res.status}:\n${res.out}`);
  return res.out;
}

function calls(box) {
  const log = join(box.home, 'calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

const skillJson = (summary, results = []) =>
  JSON.stringify({ success: summary.failed === 0 && summary.collisions === 0, summary, results });

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
  it('installs skills via install-skill --all --owner imboard-ai and keeps no hardcoded list', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box);

    expect(res.status).toBe(0);
    expect(calls(box)).toContain('install-skill --all --owner imboard-ai --fresh --json');
    expect(calls(box).filter((c) => c.startsWith('install-skill'))).toHaveLength(1);
    expect(res.out).toContain('ok   install-skill --all --owner imboard-ai');
    expect(readFileSync(SCRIPT_PATH, 'utf8')).not.toMatch(/^SKILLS=/m);
    expect(readFileSync(SCRIPT_PATH, 'utf8')).not.toContain('imboard-ai/skills/');
  });

  it('still pulls the dossier cache and any extra targets', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, ['imboard-ai/git/ship-issue']);

    expect(res.status).toBe(0);
    expect(calls(box)).toContain('pull imboard-ai/git/ship-issue --force');
    expect(calls(box)).toContain('pull imboard-ai/git/full-cycle-issue --force');
  });

  it('fails the host clearly when its CLI is older than 0.82.0, without calling install-skill', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], { STUB_VERSION: '0.81.0', STUB_LATEST: '0.81.0' });

    expect(res.status).not.toBe(0);
    expect(res.out).toMatch(/FAIL install-skill --all.*0\.81\.0.*older than 0\.82\.0/);
    expect(calls(box).some((c) => c.startsWith('install-skill'))).toBe(false);
  });

  it('reports a failed skill install as FAIL and exits non-zero', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 1, skipped: 0, failed: 1, collisions: 0 }, [
      { name: 'imboard-ai/skills/a-skill', status: 'ok' },
      { name: 'imboard-ai/skills/b-skill', status: 'failed', message: 'not found in registry' },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '1' });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('FAIL skill imboard-ai/skills/b-skill — not found in registry');
    expect(res.out).toContain('FAIL install-skill --all --owner imboard-ai');
  });

  it('surfaces collisions as a WARN without failing the run', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 1, skipped: 0, failed: 0, collisions: 1 }, [
      {
        name: 'imboard-ai/qa/qa-sheet-triage-skill',
        status: 'collision',
        message: 'directory holds imboard-ai/other/qa-sheet-triage-skill',
      },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '1' });

    expect(res.status).toBe(0);
    expect(res.out).toContain('WARN skill collision imboard-ai/qa/qa-sheet-triage-skill');
    expect(res.out).toContain('1 collision(s) need manual attention');
    expect(res.out).toContain('+skill-collisions');
    expect(res.out).toContain('1 host(s) have skill collisions');
    expect(calls(box).some((c) => /--force/.test(c) && c.startsWith('install-skill'))).toBe(false);
  });

  it('fails when install-skill exits non-zero with unparseable output', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: 'boom', STUB_SKILL_RC: '1' });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('no parseable JSON output');
  });
  it('fails when the CLI reports a registry listing failure', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], {
      STUB_SKILL_JSON: JSON.stringify({ success: false, error: 'Could not list registry: boom' }),
      STUB_SKILL_RC: '1',
    });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain(
      'FAIL install-skill --all --owner imboard-ai — Could not list registry: boom'
    );
  });

  it('fails when zero skills were installed, skipped or refused', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], {
      STUB_SKILL_JSON: skillJson({ ok: 0, skipped: 0, failed: 0, collisions: 0 }),
    });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('registry listed no skills');
  });

  it('does not excuse a non-1 exit code because collision rows exist', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 1, skipped: 0, failed: 0, collisions: 1 }, [
      { name: 'imboard-ai/qa/x-skill', status: 'collision', message: 'basename collides' },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '255' });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('exit 255, no failing rows reported');
  });

  it('parses pretty-printed JSON surrounded by stderr noise', () => {
    const box = fixture(undefined);
    const json = JSON.stringify(
      { success: true, summary: { ok: 1, skipped: 0, failed: 0, collisions: 0 }, results: [] },
      null,
      2
    );
    const res = runRefreshRaw(box, [], {
      STUB_SKILL_JSON: `warning: registry slow\n${json}\n(node:1) trailing warning`,
    });

    expect(res.status).toBe(0);
    expect(res.out).toContain('ok   install-skill --all --owner imboard-ai (ok=1');
  });

  it('neutralizes control characters and newlines in remote-provided messages', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 0, skipped: 0, failed: 1, collisions: 0 }, [
      {
        name: 'imboard-ai/skills/evil-skill',
        status: 'failed',
        message: 'x\u001b[2K\nCOLLISION fake — y',
      },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '1' });

    expect(res.status).not.toBe(0);
    expect(res.out).not.toContain('\u001b');
    expect(res.out).not.toContain('WARN skill collision fake');
    expect(res.out).toContain(
      'FAIL skill imboard-ai/skills/evil-skill — x?[2K / COLLISION fake — y'
    );
  });

  it('prints the whole usage header for --help', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, ['--help']);

    expect(res.status).toBe(0);
    expect(res.out).toContain('--profile-projects');
    expect(res.out).toContain('deliberately NOT passed');
  });
});
