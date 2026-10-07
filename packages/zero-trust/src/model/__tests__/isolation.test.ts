import fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const MODEL = path.join(SRC, 'model');
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/gu;
function resolve(from: string, name: string): string | null {
  if (name.startsWith('@ai-dossier/zero-trust')) return path.join(SRC, 'index.ts');
  if (!name.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), name.replace(/\.js$/u, ''));
  return (
    [base, `${base}.ts`, path.join(base, 'index.ts')].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ) ?? null
  );
}
function reaches(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const target = resolve(file, match[2] as string);
      if (target) stack.push(target);
    }
  }
  return [...seen];
}
describe('VM cannot reach model credentials, including transitive and type imports', () => {
  it.each(
    sources(path.join(SRC, 'vm')).map((file) => [path.relative(SRC, file)])
  )('%s stays isolated', (relative) => {
    expect(
      reaches(path.join(SRC, relative)).filter((file) => file.startsWith(`${MODEL}${path.sep}`))
    ).toEqual([]);
  });
  it('scanner detects the index re-export and self-reference bypass', () => {
    expect(reaches(path.join(SRC, 'index.ts'))).toContain(path.join(MODEL, 'openai-compatible.ts'));
    expect(resolve(path.join(SRC, 'vm/x.ts'), '@ai-dossier/zero-trust')).toBe(
      path.join(SRC, 'index.ts')
    );
    expect(resolve(path.join(SRC, 'vm/x.ts'), '../model/adapter.js')).toBe(
      path.join(MODEL, 'adapter.ts')
    );
    expect(
      [..."import type { ModelAdapter } from '../model/adapter'".matchAll(SPECIFIER)][0]?.[2]
    ).toBe('../model/adapter');
  });
});
