import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanonicalError } from './export';

/** Internal plumbing only. Never points Git at an artifact's repository/config. */
export class TrustedGit {
  readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor() {
    this.directory = fs.mkdtempSync(join(tmpdir(), 'zt-canonical-'));
    const home = join(this.directory, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    this.env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: home,
      TMPDIR: this.directory,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
    try {
      this.run([
        'init',
        '--bare',
        '--object-format=sha1',
        '--template=',
        join(this.directory, 'repo'),
      ]);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  run(args: readonly string[], input?: Buffer | string, identity: NodeJS.ProcessEnv = {}): Buffer {
    const result = spawnSync(
      '/usr/bin/git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.helper=',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'protocol.allow=never',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.quotePath=false',
        `--git-dir=${join(this.directory, 'repo')}`,
        ...args,
      ],
      {
        cwd: this.directory,
        env: { ...this.env, ...identity },
        input,
        maxBuffer: 128 * 1024 * 1024,
        timeout: 60000,
        shell: false,
      }
    );
    if (result.error || result.status !== 0) throw new CanonicalError('git_failed');
    return result.stdout;
  }
  close(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
