// Trace config resolver.
//
// Resolves which URL + token the TraceRecorder should use, walking a
// precedence stack: env > project (.dossierrc.json) > user (~/.dossier/
// config.json) > defaults. The token can also come from the CLI
// credentials store (~/.dossier/credentials.json) when not set elsewhere.
//
// Tracing is OPT-IN: the resolver returns { enabled: false } unless
// `tracing.enabled === true` is found in env or one of the config files,
// even if a URL and token happen to be available.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

const DEFAULT_TRACE_URL = 'https://dossier-registry.vercel.app';

export type ConfigLayer = 'env' | 'project' | 'user' | 'credentials' | 'default';

export interface TraceConfigSource {
  layer: ConfigLayer;
  path?: string;
}

export interface ResolvedTraceConfig {
  enabled: boolean;
  url: string | null;
  token: string | null;
  sources: {
    enabled: TraceConfigSource;
    url: TraceConfigSource | null;
    token: TraceConfigSource | null;
  };
}

export interface TraceConfigOptions {
  /** Override CWD for project-config lookup (mostly for tests). */
  cwd?: string;
  /** Override $HOME for user-config lookup (mostly for tests). */
  home?: string;
  /** Override process.env (mostly for tests). */
  env?: NodeJS.ProcessEnv;
  /** File reader injection (mostly for tests). */
  readFile?: (path: string) => string | null;
}

interface TracingBlock {
  enabled?: boolean;
  url?: string;
}

interface ParsedConfig {
  tracing?: TracingBlock;
  registries?: Record<string, { url: string; default?: boolean }>;
  defaultRegistry?: string;
  [key: string]: unknown;
}

interface CredentialsStore {
  [registryName: string]: {
    token?: string;
    expires_at?: string;
  };
}

/**
 * Resolve the effective trace configuration from the precedence stack.
 * The returned object always includes `sources` so callers can show the
 * user which layer won (useful for diagnostic commands).
 */
export function resolveTraceConfig(opts: TraceConfigOptions = {}): ResolvedTraceConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const readFile = opts.readFile ?? defaultReadFile;

  const userConfigPath = join(home, '.dossier', 'config.json');
  const userConfig = parseJson<ParsedConfig>(readFile(userConfigPath));
  const projectConfigPath = findProjectConfig(cwd, readFile);
  const projectConfig = projectConfigPath
    ? parseJson<ParsedConfig>(readFile(projectConfigPath))
    : null;

  // --- enabled ---
  let enabled = false;
  let enabledSource: TraceConfigSource = { layer: 'default' };
  if (env.DOSSIER_TRACE_ENABLED != null) {
    enabled = env.DOSSIER_TRACE_ENABLED.toLowerCase() === 'true';
    enabledSource = { layer: 'env' };
  } else if (projectConfig?.tracing?.enabled != null) {
    enabled = Boolean(projectConfig.tracing.enabled);
    enabledSource = { layer: 'project', path: projectConfigPath ?? undefined };
  } else if (userConfig?.tracing?.enabled != null) {
    enabled = Boolean(userConfig.tracing.enabled);
    enabledSource = { layer: 'user', path: userConfigPath };
  }

  // --- url ---
  let url: string | null = null;
  let urlSource: TraceConfigSource | null = null;
  if (env.DOSSIER_TRACE_URL) {
    url = env.DOSSIER_TRACE_URL;
    urlSource = { layer: 'env' };
  } else if (projectConfig?.tracing?.url) {
    url = projectConfig.tracing.url;
    urlSource = { layer: 'project', path: projectConfigPath ?? undefined };
  } else if (userConfig?.tracing?.url) {
    url = userConfig.tracing.url;
    urlSource = { layer: 'user', path: userConfigPath };
  } else {
    url = pickDefaultRegistryUrl(userConfig) ?? DEFAULT_TRACE_URL;
    urlSource = { layer: 'default' };
  }

  // --- token ---
  let token: string | null = null;
  let tokenSource: TraceConfigSource | null = null;
  if (env.DOSSIER_TRACE_TOKEN) {
    token = env.DOSSIER_TRACE_TOKEN;
    tokenSource = { layer: 'env' };
  } else {
    const credsPath = join(home, '.dossier', 'credentials.json');
    const creds = parseJson<CredentialsStore>(readFile(credsPath));
    if (creds) {
      // Prefer credentials whose registry URL matches the resolved tracing URL.
      const matched = findMatchingCredentials(creds, userConfig, url);
      if (matched?.token) {
        token = matched.token;
        tokenSource = { layer: 'credentials', path: credsPath };
      } else if (creds.public?.token) {
        token = creds.public.token;
        tokenSource = { layer: 'credentials', path: credsPath };
      }
    }
  }

  return {
    enabled: enabled && Boolean(url) && Boolean(token),
    url,
    token,
    sources: { enabled: enabledSource, url: urlSource, token: tokenSource },
  };
}

function defaultReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function parseJson<T>(contents: string | null): T | null {
  if (!contents) return null;
  try {
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

function findProjectConfig(
  startDir: string,
  readFile: (path: string) => string | null
): string | null {
  let dir = startDir;
  const root = parse(dir).root;
  while (dir !== root) {
    const rcFile = join(dir, '.dossierrc.json');
    if (readFile(rcFile) != null) return rcFile;
    dir = dirname(dir);
  }
  return null;
}

function pickDefaultRegistryUrl(userConfig: ParsedConfig | null): string | null {
  if (!userConfig?.registries) return null;
  const defaultName = userConfig.defaultRegistry;
  if (defaultName && userConfig.registries[defaultName]) {
    return userConfig.registries[defaultName].url;
  }
  const flagged = Object.values(userConfig.registries).find((r) => r.default);
  if (flagged) return flagged.url;
  const first = Object.values(userConfig.registries)[0];
  return first?.url ?? null;
}

function findMatchingCredentials(
  creds: CredentialsStore,
  userConfig: ParsedConfig | null,
  resolvedUrl: string | null
): { token?: string } | null {
  if (!resolvedUrl || !userConfig?.registries) return null;
  const target = normalizeUrl(resolvedUrl);
  for (const [name, entry] of Object.entries(userConfig.registries)) {
    if (normalizeUrl(entry.url) === target && creds[name]) {
      return creds[name];
    }
  }
  return null;
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '').toLowerCase();
}
