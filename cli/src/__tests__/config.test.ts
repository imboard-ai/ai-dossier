import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  ensureConfigDir,
  getConfig,
  loadConfig,
  saveConfig,
  setConfig,
} from '../config';

describe('config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
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
});
