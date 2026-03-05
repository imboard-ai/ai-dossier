function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  content: {
    org: 'imboard-ai',
    repo: 'dossier-content',
    branch: 'main',
    get botToken(): string {
      return requireEnv('GITHUB_BOT_TOKEN');
    },
  },

  auth: {
    github: {
      get clientId(): string {
        return requireEnv('GITHUB_CLIENT_ID');
      },
      get clientSecret(): string {
        return requireEnv('GITHUB_CLIENT_SECRET');
      },
      scopes: 'read:user read:org',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      apiUrl: 'https://api.github.com',
    },
    jwt: {
      get secret(): string {
        return requireEnv('JWT_SECRET');
      },
    },
  },

  get baseUrl(): string {
    return requireEnv('REGISTRY_BASE_URL');
  },

  cdnBaseUrl: 'https://cdn.jsdelivr.net/gh',

  getCdnUrl(path: string): string {
    const { org, repo } = this.content;
    return `${this.cdnBaseUrl}/${org}/${repo}/${path}`;
  },

  getManifestUrl(): string {
    const { org, repo, branch } = this.content;
    return `https://raw.githubusercontent.com/${org}/${repo}/${branch}/index.json`;
  },
};

export default config;
