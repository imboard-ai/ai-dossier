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
  // and exits with $STUB_SKILL_RC; list prints $STUB_LIST_OUT and exits with $STUB_LIST_RC;
  // pulling $STUB_PULL_FAIL fails the way a checksum mismatch does.
  executable(
    join(bin, 'ai-dossier'),
    String.raw`#!/bin/sh
echo "$*" >> "$HOME/calls.log"
if [ "$1" = "--version" ]; then printf '%s\n' "\${STUB_VERSION:-0.82.0}"; exit 0; fi
if [ "$1" = "list" ]; then
  if [ -n "$STUB_LIST_OUT" ]; then printf '%s\n' "$STUB_LIST_OUT"; fi
  exit "\${STUB_LIST_RC:-0}"
fi
if [ "$1" = "pull" ] && [ "$2" = "$STUB_PULL_FAIL" ]; then
  echo "$2: checksum mismatch after download" >&2; exit 1
fi
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

// The CLI's `list --source registry --json` document, pretty-printed as the CLI prints it.
const registryList = (names) =>
  JSON.stringify(
    {
      dossiers: names.map((name) => ({ name, version: '1.0.0', _registry: 'public' })),
      total: names.length,
      page: 1,
      perPage: 1000,
    },
    null,
    2
  );

// The stub registry lists, by default, the four git dossiers the fixed list missed on
// 2026-10-15, two it had, a meta dossier, and names outside the refreshed prefixes.
const REFRESHED = [
  'imboard-ai/git/plan-issue',
  'imboard-ai/git/fleet-cycle',
  'imboard-ai/git/implement-issue',
  'imboard-ai/git/setup-issue-workflow',
  'imboard-ai/git/member-cycle',
  'imboard-ai/git/full-cycle-issue',
  'imboard-ai/meta/publish-dossier',
];
const NOT_REFRESHED = [
  'imboard-ai/skills/finish-issue-skill',
  'imboard-ai/devops/provision-arm-vps',
  'imboard-ai/gitops/lookalike',
  'someone-else/git/plan-issue',
  'imboard-ai/issue-triage',
];
const FALLBACK = [
  'imboard-ai/git/member-cycle',
  'imboard-ai/git/batch-integrate',
  'imboard-ai/git/batch-issues-preparation',
  'imboard-ai/git/issue-cycle-classifier',
  'imboard-ai/git/full-cycle-issue',
];
// Enumerated dossiers are pulled sorted: fleet-cycle first, the meta dossier last.
const REFRESHED_ORDER = [...REFRESHED].sort();

function runRefreshRaw(box, args = [], extraEnv = {}) {
  const res = spawnSync('bash', [SCRIPT_PATH, '--hosts', 'host-a', ...args], {
    env: {
      ...process.env,
      HOME: box.home,
      REFRESH_FLEET_LOCAL_HOST: 'host-a',
      PATH: `${box.bin}:${process.env.PATH}`,
      SCHED_PROFILE_FLEET_HOME: box.fleet,
      SCHED_PROFILE_FILE: PROFILE_PATH,
      SCHED_BOOTSTRAP_FILE: BOOTSTRAP_PATH,
      STUB_LIST_OUT: registryList([...REFRESHED, ...NOT_REFRESHED]),
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

// The dossier names pulled, in call order.
const pulled = (box) =>
  calls(box)
    .filter((c) => c.startsWith('pull '))
    .map((c) => c.replace(/^pull (.*) --force$/, '$1'));

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

  it('pulls every imboard-ai/git and imboard-ai/meta dossier the registry lists, not a fixed subset (#1241)', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box);

    expect(res.status).toBe(0);
    expect(calls(box)).toContain('list --source registry --json --per-page 1000');
    // Exactly the listed dossiers under the prefixes, each once: nothing outside them, and
    // no fixed-list-only name such as batch-integrate.
    expect(pulled(box)).toEqual(REFRESHED_ORDER);
    expect(res.out).toContain(
      'dossiers: 7 listed under imboard-ai/git/ imboard-ai/meta/ in the registry'
    );
    expect(res.out).not.toContain('WARN dossier enumeration failed');
    expect(res.out).toContain('host-a ok  dossiers: 7 refreshed, 0 failed');
    expect(res.out).toContain('dossier list: 7 enumerated from the registry');
    expect(res.out).toMatch(/ {2}all hosts refreshed$/m);
  });

  it.each([
    [
      'the CLI prints no listing',
      { STUB_LIST_OUT: "error: unknown option '--source'", STUB_LIST_RC: '1' },
      "no JSON listing in the CLI output — error: unknown option '--source'",
    ],
    [
      'every registry failed (the CLI exits 0 with an empty listing)',
      { STUB_LIST_OUT: `⚠️  Registry 'public': fetch failed\n${registryList([])}` },
      "the registry listed no dossier under imboard-ai/git/ imboard-ai/meta/ — ⚠️  Registry 'public': fetch failed",
    ],
    [
      'the listing names nothing under the prefixes',
      { STUB_LIST_OUT: registryList(NOT_REFRESHED) },
      'the registry listed no dossier under imboard-ai/git/ imboard-ai/meta/',
    ],
    ['the listing command exits non-zero', { STUB_LIST_RC: '2' }, 'ai-dossier list exited 2'],
  ])('falls back to the fixed list and says so when %s (#1241)', (_case, env, reason) => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], env);

    expect(res.status).toBe(0);
    expect(res.out).toContain(
      `WARN dossier enumeration failed (${reason}) — falling back to the fixed list of 5`
    );
    expect(pulled(box)).toEqual(FALLBACK);
    expect(res.out).toContain('dossier list: 5 from the FIXED FALLBACK list');
    expect(res.out).toContain(
      'all hosts refreshed — but dossiers came from the fixed fallback list, not the registry'
    );
  });

  it('reports a failed pull, still runs the rest, and counts it in the summary (#1241)', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], { STUB_PULL_FAIL: REFRESHED_ORDER[0] });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain(`FAIL pull ${REFRESHED_ORDER[0]} (exit 1)`);
    expect(res.out).toContain(`${REFRESHED_ORDER[0]}: checksum mismatch after download`);
    // The failing pull was the first; every later one still ran and reported ok.
    expect(pulled(box)).toEqual(REFRESHED_ORDER);
    for (const name of REFRESHED_ORDER.slice(1)) expect(res.out).toContain(`ok   pull ${name}`);
    expect(res.out).toContain('host-a fail  dossiers: 6 refreshed, 1 failed');
    expect(res.out).toContain('ONE OR MORE HOSTS FAILED');
    expect(res.out).toContain('also: 1 dossier pull(s) failed');
    expect(res.out).not.toContain('all hosts refreshed');
  });

  it('never pulls a listed name that is not owner/category/name, so a listing cannot inject shell (#1241)', () => {
    const box = fixture(undefined);
    const hostile = [
      `imboard-ai/git/x';touch "$HOME/pwned";'`,
      'imboard-ai/git/y\nDOSSIER imboard-ai/git/injected',
      'imboard-ai/git/nested/too-deep',
    ];
    const res = runRefreshRaw(box, [], { STUB_LIST_OUT: registryList([...REFRESHED, ...hostile]) });

    expect(existsSync(join(box.home, 'pwned'))).toBe(false);
    expect(res.status).toBe(0);
    expect(pulled(box)).toEqual(REFRESHED_ORDER);
    expect(res.out).toContain(
      `WARN registry name imboard-ai/git/x';touch "$HOME/pwned";' is not owner/category/name — not pulled`
    );
    expect(res.out).toContain(
      'WARN registry name imboard-ai/git/y / DOSSIER imboard-ai/git/injected is not owner/category/name'
    );
    expect(res.out).toContain(
      'WARN registry name imboard-ai/git/nested/too-deep is not owner/category/name'
    );
  });

  it('appends extra targets after the enumerated dossiers, each pulled once', () => {
    const box = fixture(undefined);
    const extra = 'imboard-ai/security/scan-markdown-security';
    const res = runRefreshRaw(box, [extra, 'imboard-ai/git/plan-issue']);

    expect(res.status).toBe(0);
    expect(pulled(box)).toEqual([...REFRESHED_ORDER, extra]);
    expect(res.out).toContain('dossier list: 7 enumerated from the registry + 1 extra target(s)');
  });

  it('--cli-only neither lists the registry nor pulls dossiers', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, ['--cli-only']);

    expect(res.status).toBe(0);
    expect(calls(box).some((c) => c.startsWith('list ') || c.startsWith('pull '))).toBe(false);
    expect(res.out).not.toContain('dossier list:');
  });

  it('exits non-zero with guidance when no hosts are configured', () => {
    const box = fixture(undefined);
    const env = { ...process.env, HOME: box.home, PATH: `${box.bin}:${process.env.PATH}` };
    delete env.REFRESH_FLEET_HOSTS;
    const res = spawnSync('bash', [SCRIPT_PATH], { env, encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('set REFRESH_FLEET_HOSTS');
    expect(calls(box)).toEqual([]);
  });

  it('refreshes only this machine with --local-only', () => {
    const box = fixture(undefined);
    const env = { ...process.env, HOME: box.home, PATH: `${box.bin}:${process.env.PATH}` };
    delete env.REFRESH_FLEET_HOSTS;
    const res = spawnSync('bash', [SCRIPT_PATH, '--local-only'], { env, encoding: 'utf8' });
    expect(res.stdout).toContain('hosts=localhost');
    expect(res.stdout).not.toContain('unreachable over ssh');
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

  it('mentions collisions on the final line even when another skill failed', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 0, skipped: 0, failed: 1, collisions: 1 }, [
      { name: 'imboard-ai/skills/a-skill', status: 'failed', message: 'boom' },
      { name: 'imboard-ai/qa/b-skill', status: 'collision', message: 'basename collides' },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '1' });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('ONE OR MORE HOSTS FAILED');
    expect(res.out).toContain('1 host(s) have skill collisions');
  });

  it('fails when the summary counts failures that no row explains', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 1, skipped: 0, failed: 2, collisions: 0 });
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('FAIL skill (summary) — summary.failed=2');
  });

  it('fails on exit 0 when a row reports failed', () => {
    const box = fixture(undefined);
    const json = skillJson({ ok: 0, skipped: 0, failed: 1, collisions: 0 }, [
      { name: 'imboard-ai/skills/a-skill', status: 'failed', message: 'boom' },
    ]);
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json, STUB_SKILL_RC: '0' });

    expect(res.status).not.toBe(0);
    expect(res.out).toContain('FAIL skill imboard-ai/skills/a-skill — boom');
  });

  it('survives a null entry in results without crashing the parser', () => {
    const box = fixture(undefined);
    const json = JSON.stringify({
      success: true,
      summary: { ok: 1, skipped: 0, failed: 0, collisions: 0 },
      results: [null],
    });
    const res = runRefreshRaw(box, [], { STUB_SKILL_JSON: json });

    expect(res.status).toBe(0);
  });

  it('accepts a v-prefixed host version', () => {
    const box = fixture(undefined);
    const res = runRefreshRaw(box, [], { STUB_VERSION: 'v0.82.0' });

    expect(res.status).toBe(0);
    expect(calls(box)).toContain('install-skill --all --owner imboard-ai --fresh --json');
  });

  it('--usage-sync runs `usage sync` from the driving host against the remote hosts only (#782)', () => {
    const box = fixture(undefined);
    // Every ssh succeeds; host-c's stub reports no CLI version, so the run may exit non-zero —
    // only the usage-sync step matters here.
    executable(join(box.bin, 'ssh'), '#!/bin/sh\nexit 0\n');
    const res = runRefreshRaw(box, ['--hosts', 'host-a,host-c', '--usage-sync']);
    expect(res.out).toContain('== usage sync ==');
    expect(calls(box).some((c) => c.startsWith('usage sync --hosts host-c'))).toBe(true);
  });
});
