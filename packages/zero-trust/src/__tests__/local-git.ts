import { execFileSync } from 'node:child_process';

/** Offline bare-fixture plumbing, isolated from ambient Git configuration/credentials. */
export function localGit(root: string, args: string[], input?: string | Buffer): Buffer {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    input,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
