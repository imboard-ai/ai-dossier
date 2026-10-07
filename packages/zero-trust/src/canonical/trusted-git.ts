import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { CanonicalError } from './export';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ASYNC_OUTPUT = 1024 * 1024;
export const MAX_GIT_PACK_BYTES = 128 * 1024 * 1024;
/** What a caller may add to the environment: a broker credential's `GIT_CONFIG_*` set and
 * the prompt/trace switches. Anything else (GIT_DIR, GIT_SSH_COMMAND, …) could undo the
 * hardening below. */
const EXTRA_ENV =
  /^(?:GIT_CONFIG_(?:COUNT|KEY_[0-9]{1,3}|VALUE_[0-9]{1,3})|GIT_TERMINAL_PROMPT|GIT_TRACE_REDACT)$/u;
/** `-c` keys a caller's extra config may not override. */
const HARDENED = new Set([
  'core.hookspath',
  'credential.helper',
  'core.attributesfile',
  'protocol.allow',
  'commit.gpgsign',
  'core.quotepath',
]);

export interface GitExecOptions {
  readonly input?: Buffer | string;
  readonly identity?: NodeJS.ProcessEnv;
  /** Added after the hardening variables; see EXTRA_ENV. */
  readonly env?: Readonly<Record<string, string>>;
  /** Extra `-c` entries, e.g. `protocol.file.allow=always` for a local test remote. */
  readonly config?: readonly string[];
  readonly timeoutMs?: number;
  /** Credential-free source fetch only; never combine with env/config overrides. */
  readonly sourceFetch?: 'https' | 'file-test';
  /** May only lower the receive-file bound; source fetch always has a hard 128 MiB cap. */
  readonly sourcePackBytes?: number;
  readonly maxOutputBytes?: number;
}
export interface GitResult {
  /** Null when git was killed (timeout, abort) or could not start. */
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly outputLimitExceeded?: boolean;
  readonly fileLimitExceeded?: boolean;
}

/** Internal plumbing only. Never points Git at an artifact's repository/config. */
export class TrustedGit {
  readonly directory: string;
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
   * outcome (a rejected lease). */
  exec(args: readonly string[], options: GitExecOptions = {}): GitResult {
    const { argv, env } = this.invocation(args, options);
    // RLIMIT_FSIZE is inherited by Git's index-pack child and enforced by the kernel
    // during download, not a post-fetch disk check. Force packed reception below.
    const source = options.sourceFetch !== undefined;
    const result = spawnSync(
      source ? '/usr/bin/env' : '/usr/bin/git',
      source
        ? [
            '--ignore-signal=XFSZ',
            '/usr/bin/prlimit',
            `--fsize=${options.sourcePackBytes ?? MAX_GIT_PACK_BYTES}`,
            '--',
            '/usr/bin/git',
            ...argv,
          ]
        : argv,
      {
        cwd: this.directory,
        env,
        input: options.input,
        maxBuffer: options.maxOutputBytes ?? 128 * 1024 * 1024,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        shell: false,
      }
    );
    return {
      status: result.error ? null : result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      outputLimitExceeded: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS',
      fileLimitExceeded:
        source &&
        (result.signal === 'SIGXFSZ' ||
          (result.stderr?.includes(Buffer.from('File too large')) ?? false)),
    };
  }
  /** exec() for long network operations: the event loop stays free, so a revoked lease or
   * the kill switch can abort `signal`, which kills git (status null). */
  execAsync(
    args: readonly string[],
    options: Omit<
      GitExecOptions,
      'input' | 'maxOutputBytes' | 'sourceFetch' | 'sourcePackBytes'
    > & { readonly signal: AbortSignal }
  ): Promise<GitResult> {
    const { argv, env } = this.invocation(args, options);
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const child = spawn('/usr/bin/git', argv, {
        cwd: this.directory,
        env,
        signal: options.signal,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ASYNC_OUTPUT) chunks.push(chunk);
        else child.kill('SIGKILL');
      });
      child.on('error', () => undefined);
      child.on('close', (code) =>
        resolve({
          status: options.signal.aborted || size > MAX_ASYNC_OUTPUT ? null : code,
          stdout: Buffer.concat(chunks),
        })
      );
    });
  }
  private invocation(
    args: readonly string[],
    options: GitExecOptions
  ): { argv: string[]; env: NodeJS.ProcessEnv } {
    const gitEnv = { ...this.env };
    if (
      options.sourcePackBytes !== undefined &&
      (options.sourceFetch === undefined ||
        !Number.isSafeInteger(options.sourcePackBytes) ||
        options.sourcePackBytes <= 0 ||
        options.sourcePackBytes > MAX_GIT_PACK_BYTES)
    )
      throw new TypeError('TrustedGit refuses unsafe source pack limit');
    if (options.sourceFetch !== undefined) {
      if (
        args[0] !== 'fetch' ||
        options.env !== undefined ||
        options.config !== undefined ||
        options.identity !== undefined ||
        !['https', 'file-test'].includes(options.sourceFetch) ||
        (options.sourceFetch === 'file-test' && !process.env.VITEST)
      )
        throw new TypeError('TrustedGit refuses unsafe source fetch options');
    }
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
      // A caller may repeat a hardening value, never change one.
      if (key in this.env ? this.env[key] !== value : !EXTRA_ENV.test(key))
        throw new TypeError(`TrustedGit refuses environment variable ${key}`);
      gitEnv[key] = value;
    }
    for (const entry of options.config ?? [])
      if (HARDENED.has(entry.split('=')[0]?.toLowerCase() ?? ''))
        throw new TypeError('TrustedGit refuses to override its hardening config');
    const argv = [
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'protocol.allow=never',
      ...(options.sourceFetch === undefined
        ? []
        : [
            '-c',
            `protocol.${options.sourceFetch === 'https' ? 'https' : 'file'}.allow=always`,
            '-c',
            'http.followRedirects=false',
            '-c',
            'fetch.unpackLimit=1',
            '-c',
            'fetch.writeCommitGraph=false',
            '-c',
            'gc.auto=0',
          ]),
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.quotePath=false',
      ...(options.config ?? []).flatMap((entry) => ['-c', entry]),
      `--git-dir=${join(this.directory, 'repo')}`,
      ...args,
    ];
    return { argv, env: gitEnv };
  }
  close(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Source APIs classify trusted storage/process initialization as unavailable. */
export function createSourceGit(): TrustedGit {
  try {
    return new TrustedGit();
  } catch {
    throw new CanonicalError('unavailable');
  }
}
