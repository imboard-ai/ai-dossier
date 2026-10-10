/** AC8: the credential broker is controller-only. No module outside the
 * credential-holding set, including the package index, the credential-free
 * hand-off and fork modules beside it in src/github/ and the worker broker under src/vm/,
 * may reach it through any chain of static or dynamic imports. */
import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
// The unexported composition root constructs credentials; only scripts may import it.
CREDENTIAL.push(path.join(SRC, 'controller', 'wiring.ts'));
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
    const wiring = path.join(SRC, 'controller', 'wiring.ts');
    expect(resolve(path.join(SRC, 'x.ts'), './controller/wiring')).toBe(wiring);
    expect(reaches(wiring)).toContain(broker);
    // A prospective source import reaches the root itself, which is credential-bearing.
    expect([wiring, ...reaches(wiring)].filter(isCredential).length).toBeGreaterThan(1);
    const entry = path.join(SRC, 'isolation-negative.ts');
    const original = fs.readFileSync;
    // Run the actual scanner on a virtual source module; never edit the live tree.
    const spy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) =>
        file === entry
          ? "import type { ControllerOverrides } from './controller/wiring';"
          : Reflect.apply(original, fs, [file, ...args])) as typeof fs.readFileSync);
    try {
      expect(reaches(entry).filter(isCredential)).toContain(wiring);
    } finally {
      spy.mockRestore();
    }
  });
});
