import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEFAULT_REGISTRY_URL,
  ensureConfigDir,
  getConfig,
  loadConfig,
  loadProjectConfig,
  resolveRegistries,
  resolveRegistryByName,
  resolveWriteRegistry,
  saveConfig,
  setConfig,
} from '../config';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
    delete process.env.DOSSIER_REGISTRY_URL;
  });

  afterEach(() => {
    process.env.DOSSIER_REGISTRY_URL = originalEnv.DOSSIER_REGISTRY_URL;
  });

  describe('ensureConfigDir', () => {
    it('should create directory if it does not exist', () => {
      ensureConfigDir();
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true, mode: 0o700 });
    });

    it('should not create directory if it exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      ensureConfigDir();
      expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when config file does not exist', () => {
      const config = loadConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should merge file config with defaults', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ defaultLlm: 'claude-code', customKey: 'value' })
      );

      const config = loadConfig();
      expect(config.defaultLlm).toBe('claude-code');
      expect(config.theme).toBe('auto');
      expect(config.customKey).toBe('value');
    });

    it('should return defaults on read error', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const config = loadConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should return defaults on invalid JSON', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not json');

      const config = loadConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('saveConfig', () => {
    it('should write config to file and return true', () => {
      // ensureConfigDir needs existsSync to return true to avoid mkdir
      mockedFs.existsSync.mockReturnValue(true);
      const config = { ...DEFAULT_CONFIG, defaultLlm: 'claude-code' };

      expect(saveConfig(config)).toBe(true);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"claude-code"'),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    it('should return false on write error', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(saveConfig(DEFAULT_CONFIG)).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('should return a specific config value', () => {
      expect(getConfig('defaultLlm')).toBe('auto');
    });

    it('should return undefined for unknown keys', () => {
      expect(getConfig('nonExistentKey')).toBeUndefined();
    });
  });

  describe('setConfig', () => {
    it('should set a value and save', () => {
      // existsSync: false for CONFIG_FILE (loadConfig returns defaults),
      // but ensureConfigDir will try to create dir — that's fine
      mockedFs.existsSync.mockReturnValue(false);

      expect(setConfig('defaultLlm', 'claude-code')).toBe(true);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"claude-code"'),
        { encoding: 'utf8', mode: 0o600 }
      );
    });
  });

  describe('loadProjectConfig', () => {
    it('should return null when no .dossierrc.json found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadProjectConfig()).toBeNull();
    });

    it('should return parsed config when .dossierrc.json exists', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('.dossierrc.json')
      );
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ registries: { internal: { url: 'https://internal.example.com' } } })
      );
      const config = loadProjectConfig();
      expect(config).toBeDefined();
      expect(config?.registries?.internal?.url).toBe('https://internal.example.com');
    });

    it('should return null on invalid JSON', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('.dossierrc.json')
      );
      mockedFs.readFileSync.mockReturnValue('not json');
      expect(loadProjectConfig()).toBeNull();
    });
  });

  describe('resolveRegistries', () => {
    it('should return default public registry when no config', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const registries = resolveRegistries();
      expect(registries).toEqual([{ name: 'public', url: DEFAULT_REGISTRY_URL }]);
    });

    it('should include env registry when DOSSIER_REGISTRY_URL is set', () => {
      process.env.DOSSIER_REGISTRY_URL = 'https://env.example.com';
      mockedFs.existsSync.mockReturnValue(false);

      const registries = resolveRegistries();
      expect(registries).toEqual([
        { name: 'env', url: 'https://env.example.com', readonly: undefined },
      ]);
    });

    it('should merge user and project registries', () => {
      // User config has 'public' registry
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s.endsWith('config.json') || s.endsWith('.dossierrc.json');
      });

      let callCount = 0;
      mockedFs.readFileSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          // First call: user config (loadConfig)
          return JSON.stringify({
            registries: { public: { url: 'https://public.example.com' } },
          });
        }
        // Second call: project config (loadProjectConfig)
        return JSON.stringify({
          registries: { internal: { url: 'https://internal.example.com' } },
        });
      });

      const registries = resolveRegistries();
      expect(registries.length).toBe(2);
      expect(registries.find((r) => r.name === 'public')?.url).toBe('https://public.example.com');
      expect(registries.find((r) => r.name === 'internal')?.url).toBe(
        'https://internal.example.com'
      );
    });

    it('should not allow project config to override user-configured registry URLs', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s.endsWith('config.json') || s.endsWith('.dossierrc.json');
      });

      let callCount = 0;
      mockedFs.readFileSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          // User config: has 'public' registry
          return JSON.stringify({
            registries: { public: { url: 'https://user-registry.example.com' } },
          });
        }
        // Project config: tries to override 'public' with attacker URL
        return JSON.stringify({
          registries: { public: { url: 'https://attacker.example.com' } },
        });
      });

      const registries = resolveRegistries();
      const pub = registries.find((r) => r.name === 'public');
      expect(pub?.url).toBe('https://user-registry.example.com');
      expect(pub?.url).not.toBe('https://attacker.example.com');
    });
  });

  describe('resolveWriteRegistry', () => {
    it('should return the named registry when flag provided', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const reg = resolveWriteRegistry();
      expect(reg.name).toBe('public');
      expect(reg.url).toBe(DEFAULT_REGISTRY_URL);
    });

    it('should throw when named registry not found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(() => resolveWriteRegistry('nonexistent')).toThrow("Registry 'nonexistent' not found");
    });

    it('should throw when named registry is readonly', () => {
      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => String(p).endsWith('config.json'));
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          registries: { mirror: { url: 'https://mirror.example.com', readonly: true } },
        })
      );
      expect(() => resolveWriteRegistry('mirror')).toThrow('read-only');
    });
  });

  describe('resolveRegistryByName', () => {
    it('should return registry when found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const reg = resolveRegistryByName('public');
      expect(reg.url).toBe(DEFAULT_REGISTRY_URL);
    });

    it('should throw when not found', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(() => resolveRegistryByName('missing')).toThrow("Registry 'missing' not found");
    });
  });
});
