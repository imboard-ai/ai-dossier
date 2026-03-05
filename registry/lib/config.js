// Configuration for the Dossier Registry API

const config = {
  // Content repository details
  content: {
    org: 'imboard-ai',
    repo: 'dossier-content',
    branch: 'main',
    botToken: process.env.GITHUB_BOT_TOKEN,
  },

  // Authentication configuration
  auth: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scopes: 'read:user read:org',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      apiUrl: 'https://api.github.com',
    },
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: '30d',
    },
  },

  // CDN base URL (jsDelivr)
  cdnBaseUrl: 'https://cdn.jsdelivr.net/gh',

  // Construct the full CDN URL for a file
  // Note: Omitting @branch for faster cache updates (jsDelivr caches branch tags aggressively)
  getCdnUrl(path) {
    const { org, repo } = this.content;
    return `${this.cdnBaseUrl}/${org}/${repo}/${path}`;
  },

  // Get the manifest URL (direct from GitHub, not CDN, to avoid caching issues)
  getManifestUrl() {
    const { org, repo, branch } = this.content;
    return `https://raw.githubusercontent.com/${org}/${repo}/${branch}/index.json`;
  },
};

module.exports = config;
