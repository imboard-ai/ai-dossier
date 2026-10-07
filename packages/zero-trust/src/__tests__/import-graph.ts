import fs from 'node:fs';
import * as path from 'node:path';

/** Shared test-only graph; type/static/dynamic imports, exports and self-references all count. */
export function importGraph(root: string) {
  const specifier =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/gu;
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    });
  }
  function resolve(from: string, name: string): string | null {
    if (name.startsWith('@ai-dossier/zero-trust')) return path.join(root, 'index.ts');
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
      for (const match of fs.readFileSync(file, 'utf8').matchAll(specifier)) {
        const target = resolve(file, match[2] as string);
        if (target) stack.push(target);
      }
    }
    return [...seen];
  }
  return { sources, resolve, reaches, specifier };
}
