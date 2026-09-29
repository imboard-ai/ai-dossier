import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCapabilityManifest } from '../capability';

const MANIFEST = `version: 1
capabilities:
  lint:
    command: echo lint
`;

describe('loadCapabilityManifest upward search (#759)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-root-'));
    fs.mkdirSync(path.join(root, '.dossier', 'automation'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dossier', 'automation', 'manifest.yaml'), MANIFEST);
    fs.mkdirSync(path.join(root, 'main', 'packages', 'x'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the manifest from the project root', () => {
    expect(Object.keys(loadCapabilityManifest(root).capabilities)).toEqual(['lint']);
  });

  it('finds the manifest from a nested checkout directory', () => {
    const m = loadCapabilityManifest(path.join(root, 'main', 'packages', 'x'));
    expect(Object.keys(m.capabilities)).toEqual(['lint']);
    expect(m.path).toBe(path.join(root, '.dossier', 'automation', 'manifest.yaml'));
  });

  it('reports no manifest when no ancestor has .dossier/', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-bare-'));
    try {
      expect(loadCapabilityManifest(bare)).toEqual({ path: null, capabilities: {} });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
