/** AC8: the credential broker is controller-only. No module outside src/github/,
 * including the package index and the worker broker under src/vm/, may reach it
 * through any chain of static or dynamic imports. */
import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const GITHUB = path.join(SRC, 'github');

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
  const outside = sources(SRC).filter((file) => !file.startsWith(`${GITHUB}${path.sep}`));

  it('scans the package index and every non-broker module', () => {
    expect(outside).toContain(path.join(SRC, 'index.ts'));
    expect(outside.length).toBeGreaterThan(10);
  });

  it.each(
    sources(SRC)
      .filter((file) => !file.startsWith(`${GITHUB}${path.sep}`))
      .map((file) => [path.relative(SRC, file)])
  )('%s cannot reach src/github/', (relative) => {
    const reached = reaches(path.join(SRC, relative)).filter((file) =>
      file.startsWith(`${GITHUB}${path.sep}`)
    );
    expect(reached).toEqual([]);
  });

  it('detects a violation (self-check of the scanner)', () => {
    const broker = path.join(GITHUB, 'broker.ts');
    expect(reaches(broker)).toContain(path.join(GITHUB, 'app-auth.ts'));
    expect(resolve(path.join(SRC, 'index.ts'), './github/broker')).toBe(broker);
    expect(resolve(path.join(SRC, 'x.ts'), '@ai-dossier/zero-trust')).toBe(
      path.join(SRC, 'index.ts')
    );
  });
});
