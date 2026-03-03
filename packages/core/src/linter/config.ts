import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LintConfig } from './types';

const CONFIG_FILENAME = '.dossierrc.json';

export const defaultConfig: LintConfig = {
  rules: {},
};

export function loadLintConfig(startDir?: string): LintConfig {
  const configPath = findConfigFile(startDir || process.cwd());
  if (!configPath) {
    return { ...defaultConfig };
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      rules: parsed.rules || {},
    };
  } catch {
    return { ...defaultConfig };
  }
}

function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');

  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      return null;
    }
    dir = parent;
  }
}
