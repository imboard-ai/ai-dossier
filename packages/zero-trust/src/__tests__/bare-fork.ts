/** Dependency-free bare Git fixture, also usable by the process-crash child. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export class BareFork {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.git(['init', '--bare', '--quiet']);
  }
  git(args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): string {
    return execFileSync('/usr/bin/git', ['--git-dir', this.dir, ...args], {
      input,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: this.dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  }
  sha(branch: string): string | null {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  }
}
