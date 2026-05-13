import { describe, expect, it } from 'vitest';
import { resolveTraceConfig } from '../trace-config';

/** Build an injectable readFile from a path→content map (everything else returns null). */
function fakeFs(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

const HOME = '/h';
const USER_CONFIG = '/h/.dossier/config.json';
const USER_CREDS = '/h/.dossier/credentials.json';
const PROJECT_RC = '/work/proj/.dossierrc.json';

describe('resolveTraceConfig', () => {
  it('returns disabled with default URL when nothing is configured', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/work/proj',
      env: {},
      readFile: fakeFs({}),
    });
    expect(result.enabled).toBe(false);
    expect(result.url).toBe('https://dossier-registry.vercel.app');
    expect(result.token).toBeNull();
    expect(result.sources.enabled.layer).toBe('default');
    expect(result.sources.url?.layer).toBe('default');
    expect(result.sources.token).toBeNull();
  });

  it('reads enabled + token from credentials when user config opts in', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({ tracing: { enabled: true } }),
        [USER_CREDS]: JSON.stringify({
          public: { token: 'creds-token', expires_at: '2099-01-01' },
        }),
      }),
    });
    expect(result.enabled).toBe(true);
    expect(result.url).toBe('https://dossier-registry.vercel.app');
    expect(result.token).toBe('creds-token');
    expect(result.sources.enabled.layer).toBe('user');
    expect(result.sources.token?.layer).toBe('credentials');
  });

  it('env vars take precedence over project + user', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/work/proj',
      env: {
        DOSSIER_TRACE_ENABLED: 'true',
        DOSSIER_TRACE_URL: 'https://env.example',
        DOSSIER_TRACE_TOKEN: 'env-token',
      },
      readFile: fakeFs({
        [PROJECT_RC]: JSON.stringify({ tracing: { enabled: false, url: 'https://proj.test' } }),
        [USER_CONFIG]: JSON.stringify({ tracing: { enabled: false, url: 'https://user.test' } }),
      }),
    });
    expect(result.enabled).toBe(true);
    expect(result.url).toBe('https://env.example');
    expect(result.token).toBe('env-token');
    expect(result.sources.enabled.layer).toBe('env');
    expect(result.sources.url?.layer).toBe('env');
    expect(result.sources.token?.layer).toBe('env');
  });

  it('DOSSIER_TRACE_ENABLED=false overrides user config that says true', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: { DOSSIER_TRACE_ENABLED: 'false' },
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({ tracing: { enabled: true } }),
        [USER_CREDS]: JSON.stringify({ public: { token: 't' } }),
      }),
    });
    expect(result.enabled).toBe(false);
    expect(result.sources.enabled.layer).toBe('env');
  });

  it('project config overrides user config but not env', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/work/proj',
      env: {},
      readFile: fakeFs({
        [PROJECT_RC]: JSON.stringify({ tracing: { enabled: true, url: 'https://team.test' } }),
        [USER_CONFIG]: JSON.stringify({ tracing: { enabled: false, url: 'https://my.test' } }),
        [USER_CREDS]: JSON.stringify({ public: { token: 't' } }),
      }),
    });
    expect(result.enabled).toBe(true);
    expect(result.url).toBe('https://team.test');
    expect(result.sources.enabled.layer).toBe('project');
    expect(result.sources.url?.layer).toBe('project');
  });

  it('walks up from cwd to find .dossierrc.json', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/work/proj/deep/nested/dir',
      env: {},
      readFile: fakeFs({
        [PROJECT_RC]: JSON.stringify({ tracing: { enabled: true, url: 'https://walked.test' } }),
        [USER_CREDS]: JSON.stringify({ public: { token: 't' } }),
      }),
    });
    expect(result.enabled).toBe(true);
    expect(result.url).toBe('https://walked.test');
    expect(result.sources.url?.path).toBe(PROJECT_RC);
  });

  it('matches credentials by registry URL when the user has multiple', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({
          tracing: { enabled: true, url: 'https://corp.example' },
          registries: {
            public: { url: 'https://dossier-registry.vercel.app', default: true },
            corp: { url: 'https://corp.example' },
          },
        }),
        [USER_CREDS]: JSON.stringify({
          public: { token: 'public-token' },
          corp: { token: 'corp-token' },
        }),
      }),
    });
    expect(result.url).toBe('https://corp.example');
    expect(result.token).toBe('corp-token');
  });

  it('falls back to public credentials when no registry URL matches', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({
          tracing: { enabled: true, url: 'https://unknown.test' },
        }),
        [USER_CREDS]: JSON.stringify({ public: { token: 'public-token' } }),
      }),
    });
    expect(result.url).toBe('https://unknown.test');
    expect(result.token).toBe('public-token');
  });

  it('result.enabled is false when enabled flag is set but no token is resolvable', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({ tracing: { enabled: true } }),
        // no credentials file
      }),
    });
    expect(result.enabled).toBe(false);
    expect(result.token).toBeNull();
    expect(result.sources.enabled.layer).toBe('user'); // the flag was on, but token resolution failed
  });

  it('uses configured default registry URL when no explicit tracing URL is set', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: JSON.stringify({
          tracing: { enabled: true },
          defaultRegistry: 'corp',
          registries: {
            corp: { url: 'https://corp.example' },
          },
        }),
        [USER_CREDS]: JSON.stringify({ corp: { token: 'corp-token' } }),
      }),
    });
    expect(result.url).toBe('https://corp.example');
    expect(result.token).toBe('corp-token');
  });

  it('handles malformed JSON gracefully (falls through to defaults)', () => {
    const result = resolveTraceConfig({
      home: HOME,
      cwd: '/tmp',
      env: {},
      readFile: fakeFs({
        [USER_CONFIG]: 'not-json{{{',
        [USER_CREDS]: '{{ also broken',
      }),
    });
    expect(result.enabled).toBe(false);
    expect(result.url).toBe('https://dossier-registry.vercel.app');
    expect(result.token).toBeNull();
  });
});
