import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { CanonicalError } from './export';

/** Internal plumbing only. Never points Git at an artifact's repository/config. */
export class TrustedGit {
  readonly directory: string;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Biome misses the read in the environment-copy spread in exec().
  private readonly env: NodeJS.ProcessEnv;
  constructor() {
    // Do not let inherited TMPDIR relocate trusted config into worker storage.
    this.directory = fs.mkdtempSync('/tmp/zt-canonical-');
    const home = join(this.directory, 'home');
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
      fs.mkdirSync(home, { mode: 0o700 });
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
    const result = this.exec(args, { input, identity });
    if (result.status !== 0) throw new CanonicalError('git_failed');
    return result.stdout;
  }
  /** Like run(), but reports the exit status, for commands whose refusal is an expected
   * outcome (a rejected lease). `config` adds `-c` entries after the hardening ones;
   * `env` adds only `GIT_*` variables, e.g. a broker credential's `GIT_CONFIG_*` set. */
  exec(
    args: readonly string[],
    options: {
      input?: Buffer | string;
      identity?: NodeJS.ProcessEnv;
      env?: Readonly<Record<string, string>>;
      config?: readonly string[];
      timeoutMs?: number;
    } = {}
  ): { status: number | null; stdout: Buffer } {
    const gitEnv = { ...this.env };
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_AUTHOR_DATE',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_COMMITTER_DATE',
    ]) {
      const value = options.identity?.[key];
      if (value !== undefined) gitEnv[key] = value;
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!key.startsWith('GIT_')) throw new CanonicalError('git_failed');
      gitEnv[key] = value;
    }
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
        ...(options.config ?? []).flatMap((entry) => ['-c', entry]),
        `--git-dir=${join(this.directory, 'repo')}`,
        ...args,
      ],
      {
        cwd: this.directory,
        env: gitEnv,
        input: options.input,
        maxBuffer: 128 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60000,
        shell: false,
      }
    );
    return {
      status: result.error ? null : result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
    };
  }
  close(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
