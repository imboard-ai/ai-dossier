import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importGraph } from '../../__tests__/import-graph';

const SRC = path.resolve(__dirname, '../..');
const MODEL = path.join(SRC, 'model');
const { sources, reaches, resolve, specifier } = importGraph(SRC);
const vm = sources(path.join(SRC, 'vm'));
describe('VM cannot reach model credentials, including transitive and type imports', () => {
  it('fails closed on unresolved and computed import paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-isolation-'));
    const entry = path.join(dir, 'entry.ts');
    try {
      for (const text of [
        "import type { X } from './missing'",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal source of a hostile computed import for the scanner self-check.
        "await import(`./model/${'adapter'}`)",
        'await import(target)',
      ]) {
        fs.writeFileSync(entry, text);
        expect(() => reaches(entry)).toThrow(/cannot prove isolation/iu);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('scans every VM entry point, never an empty table', () => {
    expect(vm.length).toBeGreaterThan(5);
    expect(vm).toContain(path.join(SRC, 'vm/broker.ts'));
    expect(vm).toContain(path.join(SRC, 'vm/local-qemu.ts'));
  });
  it.each(vm.map((file) => [path.relative(SRC, file)]))('%s stays isolated', (relative) => {
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
      [..."import type { ModelAdapter } from '../model/adapter'".matchAll(specifier)][0]?.[2]
    ).toBe('../model/adapter');
  });
});
