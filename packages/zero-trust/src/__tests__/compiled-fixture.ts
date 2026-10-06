import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

/** Compile the current source closure for real child processes, never warm dist. */
export function compiledFixture(directory: string, entry: string): string {
  const root = path.join(directory, 'compiled');
  fs.mkdirSync(root, { recursive: true });
  const dependencies = path.join(root, 'node_modules');
  if (!fs.existsSync(dependencies))
    fs.symlinkSync(path.resolve(__dirname, '../../../../node_modules'), dependencies, 'dir');
  const seen = new Set<string>();
  const compile = (relative: string): void => {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(path.join(__dirname, '..', `${relative}.ts`), 'utf8');
    for (const imported of ts.preProcessFile(source).importedFiles) {
      if (imported.fileName.startsWith('.'))
        compile(path.join(path.dirname(relative), imported.fileName));
    }
    const target = path.join(root, `${relative}.js`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText
    );
  };
  compile(entry);
  return path.join(root, `${entry}.js`);
}
