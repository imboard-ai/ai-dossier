/** AC8: the credential broker is controller-only. No module outside the
 * credential-holding set, including the package index, the credential-free
 * hand-off modules beside it in src/github/ and the worker broker under src/vm/,
 * may reach it through any chain of static or dynamic imports. */
import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const GITHUB = path.join(SRC, 'github');
/** The only modules that hold or handle GitHub credentials. `contributor.ts` (#1065) joins
 * them: it runs the user authorization, holds the refresh token and hands the access token
 * to the broker. Its credential-free half, `fork.ts`, stays outside and is scanned. */
const CREDENTIAL = ['broker.ts', 'app-auth.ts', 'token-journal.ts', 'contributor.ts'].map((name) =>
  path.join(GITHUB, name)
);
const isCredential = (file: string) => CREDENTIAL.includes(file);

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return /\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name) ? [full] : [];
  });
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/gu;
function imports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)].map((match) => match[2] as string);
}
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    // A self-reference through the package name would bypass relative-path checks.
    if (specifier.startsWith('@ai-dossier/zero-trust')) return path.join(SRC, 'index.ts');
    return null;
  }
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ''));
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return null;
}
function reaches(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of imports(file)) {
      const target = resolve(file, specifier);
      if (target) stack.push(target);
    }
  }
  return [...seen];
}

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
