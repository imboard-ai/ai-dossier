import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Caller owns the directory and its cleanup; fixture key never leaves it. */
export function createProxyCaFixture(root: string, days = '1'): string {
  const file = path.join(root, 'proxy-ca.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      days,
      '-subj',
      '/CN=fixture-proxy',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      path.join(root, 'proxy-ca.key'),
      '-out',
      file,
    ],
    { stdio: 'ignore' }
  );
  return file;
}
