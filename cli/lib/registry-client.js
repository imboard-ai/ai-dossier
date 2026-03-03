/**
 * HTTP client for the Dossier Registry API.
 * Uses Node.js built-in fetch (Node 18+).
 */

const DEFAULT_REGISTRY_URL = 'https://dossier-registry-mvp-ten.vercel.app';

class RegistryError extends Error {
  /**
   * @param {string} message
   * @param {number|null} statusCode
   * @param {string|null} code
   */
  constructor(message, statusCode = null, code = null) {
    super(message);
    this.name = 'RegistryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class RegistryClient {
  /**
   * @param {string} baseUrl - Registry base URL
   * @param {string|null} token - Optional Bearer token for authenticated requests
   */
  constructor(baseUrl, token = null) {
    this.baseUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.token = token;
  }

  /**
   * Build request headers.
   * @returns {Record<string, string>}
   */
  _buildHeaders(contentType = null) {
    const headers = { Accept: 'application/json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  /**
   * Handle API response, throwing on errors.
   * @param {Response} response
   * @returns {Promise<any>}
   */
  async _handleResponse(response) {
    if (!response.ok) {
      let message = `Registry request failed: ${response.status} ${response.statusText}`;
      let code = null;

      try {
        const body = await response.json();
        const errorData = body.error || {};
        if (errorData.message) {
          message = errorData.message;
        }
        code = errorData.code || null;
      } catch {
        // Could not parse error body
      }

      throw new RegistryError(message, response.status, code);
    }

    return response.json();
  }

  /**
   * Build URL with query parameters.
   * @param {string} path
   * @param {Record<string, any>} params
   * @returns {string}
   */
  _buildUrl(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * List dossiers from the registry.
   * @param {{ category?: string, page?: number, perPage?: number }} options
   * @returns {Promise<{ dossiers: any[], pagination: any }>}
   */
  async listDossiers(options = {}) {
    const params = {
      page: options.page || 1,
      per_page: options.perPage || 20,
    };
    if (options.category) {
      params.category = options.category;
    }

    const response = await fetch(this._buildUrl('/dossiers', params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse(response);
  }

  /**
   * Get metadata for a dossier.
   * @param {string} name - Dossier name (e.g., 'myorg/deploy')
   * @param {string|null} version - Optional version (default: latest)
   * @returns {Promise<any>}
   */
  async getDossier(name, version = null) {
    const params = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}`, params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse(response);
  }

  /**
   * Download dossier content.
   * @param {string} name - Dossier name
   * @param {string|null} version - Optional version
   * @returns {Promise<{ content: string, digest: string|null }>}
   */
  async getDossierContent(name, version = null) {
    const params = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}/content`, params), {
      headers: this._buildHeaders(),
    });

    if (!response.ok) {
      let message = `Failed to download dossier '${name}': ${response.status} ${response.statusText}`;
      let code = null;

      try {
        const body = await response.json();
        const errorData = body.error || {};
        if (errorData.message) {
          message = errorData.message;
        }
        code = errorData.code || null;
      } catch {
        // Could not parse error body
      }

      throw new RegistryError(message, response.status, code);
    }

    const content = await response.text();
    const digest = response.headers.get('X-Dossier-Digest');

    return { content, digest };
  }

  /**
   * Search dossiers.
   * @param {string} query - Search query
   * @param {{ page?: number, perPage?: number }} options
   * @returns {Promise<any>}
   */
  async searchDossiers(query, options = {}) {
    const params = {
      q: query,
      page: options.page || 1,
      per_page: options.perPage || 20,
    };

    const response = await fetch(this._buildUrl('/search', params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse(response);
  }

  /**
   * Publish a dossier to the registry.
   * @param {string} namespace - Target namespace (e.g., 'myorg/tools')
   * @param {string} content - Full .ds.md file content
   * @param {string|null} changelog - Optional changelog message
   * @returns {Promise<any>}
   */
  async publishDossier(namespace, content, changelog = null) {
    const data = { namespace, content };
    if (changelog) {
      data.changelog = changelog;
    }

    const response = await fetch(this._buildUrl('/dossiers'), {
      method: 'POST',
      headers: this._buildHeaders('application/json'),
      body: JSON.stringify(data),
    });
    return this._handleResponse(response);
  }

  /**
   * Delete a dossier from the registry.
   * @param {string} name - Dossier name
   * @param {string|null} version - Optional specific version to delete
   * @returns {Promise<any>}
   */
  async removeDossier(name, version = null) {
    const params = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}`, params), {
      method: 'DELETE',
      headers: this._buildHeaders(),
    });
    return this._handleResponse(response);
  }

  /**
   * Get current user info.
   * @returns {Promise<any>}
   */
  async getMe() {
    const response = await fetch(this._buildUrl('/me'), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse(response);
  }

  /**
   * Exchange OAuth code for access token.
   * @param {string} code - Authorization code
   * @param {string} redirectUri - Redirect URI used in the auth request
   * @returns {Promise<any>}
   */
  async exchangeCode(code, redirectUri) {
    const response = await fetch(this._buildUrl('/auth/token'), {
      method: 'POST',
      headers: this._buildHeaders('application/json'),
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    return this._handleResponse(response);
  }
}

/**
 * Get registry URL from environment or use default.
 * @returns {string}
 */
function getRegistryUrl() {
  return process.env.DOSSIER_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

/**
 * Create a registry client from environment configuration.
 * @param {string|null} token - Optional auth token
 * @returns {RegistryClient}
 */
function getClient(token = null) {
  return new RegistryClient(getRegistryUrl(), token);
}

/**
 * Parse a name@version string.
 * @param {string} name - Dossier name, optionally with @version suffix
 * @returns {[string, string|null]} Tuple of [name, version]
 */
function parseNameVersion(name) {
  if (name.includes('@')) {
    const idx = name.lastIndexOf('@');
    return [name.slice(0, idx), name.slice(idx + 1)];
  }
  return [name, null];
}

module.exports = {
  RegistryClient,
  RegistryError,
  getRegistryUrl,
  getClient,
  parseNameVersion,
  DEFAULT_REGISTRY_URL,
};
