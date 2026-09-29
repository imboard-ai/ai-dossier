// Vitest globalSetup shared by every workspace (#896).
//
// Points HOME / USERPROFILE at a per-run mkdtemp dir before any worker forks,
// so `os.homedir()` — and every `~/.dossier`, `~/.claude`, `~/.config` path
// derived from it, in the test process and in any CLI subprocess it spawns —
// resolves inside a private sandbox. Two consequences:
//   - concurrent suites on one host never collide on shared on-disk state
//     (config.json, cache, runs.jsonl, trusted-keys.txt, ...);
//   - no test can write the developer's real ~/.dossier, which the live
//     scheduler daemon on the same host also uses.
// Relies on vitest's default `forks` pool: workers inherit this process's env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home;

export default function setup() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-test-home-'));
  // Tests that run `git commit` still need an identity; the real ~/.gitconfig
  // is no longer visible under the sandboxed HOME.
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n'
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    fs.rmSync(home, { recursive: true, force: true });
  };
}
