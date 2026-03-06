import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// Must import after mock
import {
  CREDENTIALS_FILE,
  deleteCredentials,
  isExpired,
  loadCredentials,
  saveCredentials,
} from '../credentials';

describe('credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
  });

  describe('saveCredentials', () => {
    it('should write credentials to file with secure permissions', () => {
      const creds = { token: 'tok', username: 'user', orgs: ['org1'], expiresAt: null };
      // loadCredentialsStore reads the file first; mock it to return empty
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue('{}');

      saveCredentials(creds);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CREDENTIALS_FILE,
        expect.stringContaining('"token": "tok"'),
        { mode: 0o600 }
      );
    });

    it('should create config dir if it does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const creds = { token: 'tok', username: 'user', orgs: [], expiresAt: null };

      saveCredentials(creds);

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        mode: 0o700,
      });
    });

    it('should store expiresAt as expires_at in JSON', () => {
      const creds = { token: 'tok', username: 'user', orgs: [], expiresAt: '2030-01-01' };
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue('{}');

      saveCredentials(creds);

      const written = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.public.expires_at).toBe('2030-01-01');
    });

    it('should default orgs to empty array', () => {
      const creds = {
        token: 'tok',
        username: 'user',
        orgs: undefined as unknown as string[],
        expiresAt: null,
      };
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue('{}');

      saveCredentials(creds);

      const written = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.public.orgs).toEqual([]);
    });
  });

  describe('loadCredentials', () => {
    it('should return null if file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadCredentials()).toBeNull();
    });

    it('should return parsed credentials from file', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          public: { token: 'tok', username: 'user', orgs: ['o'], expires_at: null },
        })
      );

      const creds = loadCredentials();
      expect(creds).toEqual({
        token: 'tok',
        username: 'user',
        orgs: ['o'],
        expiresAt: null,
      });
    });

    it('should return null if token is missing', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ public: { username: 'user' } }));
      expect(loadCredentials()).toBeNull();
    });

    it('should return null if username is missing', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ public: { token: 'tok' } }));
      expect(loadCredentials()).toBeNull();
    });

    it('should return null on invalid JSON', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue('not json');
      expect(loadCredentials()).toBeNull();
    });

    it('should default orgs to empty array when missing', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ public: { token: 'tok', username: 'user' } })
      );

      const creds = loadCredentials();
      expect(creds?.orgs).toEqual([]);
    });

    it('should return credentials from DOSSIER_REGISTRY_TOKEN env var via env registry', () => {
      const saved = {
        token: process.env.DOSSIER_REGISTRY_TOKEN,
        user: process.env.DOSSIER_REGISTRY_USER,
        orgs: process.env.DOSSIER_REGISTRY_ORGS,
      };

      process.env.DOSSIER_REGISTRY_TOKEN = 'env-token';
      process.env.DOSSIER_REGISTRY_USER = 'env-user';
      process.env.DOSSIER_REGISTRY_ORGS = 'org1,org2';

      try {
        // Env var credentials are on the "env" registry
        const creds = loadCredentials('env');
        expect(creds).toEqual({
          token: 'env-token',
          username: 'env-user',
          orgs: ['org1', 'org2'],
          expiresAt: null,
        });
      } finally {
        if (saved.token === undefined) delete process.env.DOSSIER_REGISTRY_TOKEN;
        else process.env.DOSSIER_REGISTRY_TOKEN = saved.token;
        if (saved.user === undefined) delete process.env.DOSSIER_REGISTRY_USER;
        else process.env.DOSSIER_REGISTRY_USER = saved.user;
        if (saved.orgs === undefined) delete process.env.DOSSIER_REGISTRY_ORGS;
        else process.env.DOSSIER_REGISTRY_ORGS = saved.orgs;
      }
    });

    it('should use default username when only DOSSIER_REGISTRY_TOKEN is set', () => {
      const saved = {
        token: process.env.DOSSIER_REGISTRY_TOKEN,
        user: process.env.DOSSIER_REGISTRY_USER,
        orgs: process.env.DOSSIER_REGISTRY_ORGS,
      };

      process.env.DOSSIER_REGISTRY_TOKEN = 'env-token';
      delete process.env.DOSSIER_REGISTRY_USER;
      delete process.env.DOSSIER_REGISTRY_ORGS;

      try {
        const creds = loadCredentials('env');
        expect(creds?.username).toBe('token-auth');
        expect(creds?.orgs).toEqual([]);
      } finally {
        if (saved.token === undefined) delete process.env.DOSSIER_REGISTRY_TOKEN;
        else process.env.DOSSIER_REGISTRY_TOKEN = saved.token;
        if (saved.user === undefined) delete process.env.DOSSIER_REGISTRY_USER;
        else process.env.DOSSIER_REGISTRY_USER = saved.user;
        if (saved.orgs === undefined) delete process.env.DOSSIER_REGISTRY_ORGS;
        else process.env.DOSSIER_REGISTRY_ORGS = saved.orgs;
      }
    });

    it('should auto-migrate old flat format to keyed format', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as any);
      // Old format: flat object with token/username at top level
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ token: 'tok', username: 'user', orgs: ['o'], expires_at: null })
      );

      const creds = loadCredentials();
      expect(creds).toEqual({
        token: 'tok',
        username: 'user',
        orgs: ['o'],
        expiresAt: null,
      });
      // Should write back the migrated format
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it('should warn and fix insecure permissions', () => {
      mockedFs.statSync.mockReturnValue({ mode: 0o100644 } as any);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          public: { token: 'tok', username: 'user', orgs: [], expires_at: null },
        })
      );

      loadCredentials();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('insecure permissions'));
      expect(mockedFs.chmodSync).toHaveBeenCalledWith(CREDENTIALS_FILE, 0o600);
    });
  });

  describe('deleteCredentials', () => {
    it('should delete file and return true when it exists', () => {
      expect(deleteCredentials()).toBe(true);
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(CREDENTIALS_FILE);
    });

    it('should return false when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      expect(deleteCredentials()).toBe(false);
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('isExpired', () => {
    it('should return false when expiresAt is null', () => {
      expect(isExpired({ expiresAt: null })).toBe(false);
    });

    it('should return false when token has not expired', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      expect(isExpired({ expiresAt: future })).toBe(false);
    });

    it('should return true when token has expired', () => {
      const past = new Date(Date.now() - 3600000).toISOString();
      expect(isExpired({ expiresAt: past })).toBe(true);
    });

    it('should return false on invalid date string', () => {
      expect(isExpired({ expiresAt: 'not-a-date' })).toBe(false);
    });
  });
});
