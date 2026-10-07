/** AC8: the credential broker is controller-only. No module outside the
 * credential-holding set, including the package index, the credential-free
 * hand-off and fork modules beside it in src/github/ and the worker broker under src/vm/,
 * may reach it through any chain of static or dynamic imports. */
import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../__tests__/import-graph';

const SRC = path.resolve(__dirname, '../..');
const GITHUB = path.join(SRC, 'github');
/** The only modules that hold or handle GitHub credentials. `contributor.ts` (#1065) joins
 * them: it runs the user authorization, holds the refresh token and hands the access token
 * to the broker. Its credential-free half, `fork.ts`, stays outside and is scanned.
 * `push.ts` (#1066) passes the broker's push credential to git, so it is controller-only too. */
const CREDENTIAL = [
  'broker.ts',
  'app-auth.ts',
  'token-journal.ts',
  'contributor.ts',
  'push.ts',
].map((name) => path.join(GITHUB, name));
const isCredential = (file: string) => CREDENTIAL.includes(file);

const { sources, resolve, reaches } = importGraph(SRC);

describe('credential broker isolation', () => {
  const outside = sources(SRC).filter((file) => !isCredential(file));

  it('scans the package index and every non-credential module', () => {
    for (const file of CREDENTIAL) expect(fs.existsSync(file)).toBe(true);
    expect(outside).toContain(path.join(SRC, 'index.ts'));
    expect(outside.length).toBeGreaterThan(10);
  });

  it.each(
    outside.map((file) => [path.relative(SRC, file)])
  )('%s cannot reach the credential broker', (relative) => {
    expect(reaches(path.join(SRC, relative)).filter(isCredential)).toEqual([]);
  });

  it('detects a violation (self-check of the scanner)', () => {
    const broker = path.join(GITHUB, 'broker.ts');
    expect(reaches(broker)).toContain(path.join(GITHUB, 'app-auth.ts'));
    expect(resolve(path.join(SRC, 'index.ts'), './github/broker')).toBe(broker);
    expect(outside).toContain(path.join(GITHUB, 'fork.ts'));
    expect(reaches(path.join(GITHUB, 'contributor.ts'))).toContain(broker);
    expect(resolve(path.join(SRC, 'x.ts'), '@ai-dossier/zero-trust')).toBe(
      path.join(SRC, 'index.ts')
    );
  });
});
