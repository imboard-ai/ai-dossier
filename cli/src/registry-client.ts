/**
 * HTTP client for the Dossier Registry API.
 * Uses Node.js built-in fetch (Node 18+).
 */

class RegistryError extends Error {
  statusCode: number | null;
  code: string | null;

  constructor(message: string, statusCode: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'RegistryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface ListDossiersOptions {
  category?: string;
  page?: number;
  perPage?: number;
}

interface SearchOptions {
  page?: number;
  perPage?: number;
}

interface DossierContentResult {
  content: string;
  digest: string | null;
}

interface DossierInfo {
  name: string;
  title?: string;
  version?: string;
  status?: string;
  category?: string | string[];
  risk_level?: string;
  objective?: string;
  description?: string;
  authors?: Array<string | { name: string }>;
  tags?: string[];
  checksum?: { algorithm?: string; hash?: string };
  signature?: { signed_by?: string; key_id?: string };
  content_url?: string;
}

interface DossierListItem {
  name: string;
  title?: string;
  description?: string;
  objective?: string;
  version?: string;
  category?: string | string[];
  tags?: string[];
}

interface ListDossiersResult {
  dossiers?: DossierListItem[];
  data?: DossierListItem[];
  total?: number;
  totalPages?: number;
}

interface PublishResult {
  name?: string;
  content_url?: string;
}

interface SearchResult {
  dossiers?: DossierListItem[];
  total?: number;
  totalPages?: number;
}

class RegistryClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = `${baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.token = token;
  }

  /**
   * Get the registry base URL (without /api/v1 suffix).
   */
  getRegistryBaseUrl(): string {
    return this.baseUrl.replace(/\/api\/v1$/, '');
  }

  /**
   * Build request headers.
   */
  private _buildHeaders(contentType: string | null = null): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
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
   */
  private async _handleResponse<T = unknown>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `Registry request failed: ${response.status} ${response.statusText}`;
      let code: string | null = null;

      try {
        const body = (await response.json()) as { error?: { message?: string; code?: string } };
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

    return response.json() as Promise<T>;
  }

  /**
   * Build URL with query parameters.
   */
  private _buildUrl(path: string, params: Record<string, unknown> = {}): string {
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
   */
  async listDossiers(options: ListDossiersOptions = {}): Promise<ListDossiersResult> {
    const params: Record<string, unknown> = {
      page: options.page || 1,
      per_page: options.perPage || 20,
    };
    if (options.category) {
      params.category = options.category;
    }

    const response = await fetch(this._buildUrl('/dossiers', params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse<ListDossiersResult>(response);
  }

  /**
   * Get metadata for a dossier.
   */
  async getDossier(name: string, version: string | null = null): Promise<DossierInfo> {
    const params: Record<string, unknown> = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}`, params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse<DossierInfo>(response);
  }

  /**
   * Download dossier content.
   */
  async getDossierContent(
    name: string,
    version: string | null = null
  ): Promise<DossierContentResult> {
    const params: Record<string, unknown> = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}/content`, params), {
      headers: this._buildHeaders(),
    });

    if (!response.ok) {
      let message = `Failed to download dossier '${name}': ${response.status} ${response.statusText}`;
      let code: string | null = null;

      try {
        const body = (await response.json()) as { error?: { message?: string; code?: string } };
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
   */
  async searchDossiers(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const params: Record<string, unknown> = {
      q: query,
      page: options.page || 1,
      per_page: options.perPage || 20,
    };

    const response = await fetch(this._buildUrl('/search', params), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse<SearchResult>(response);
  }

  /**
   * Publish a dossier to the registry.
   */
  async publishDossier(
    namespace: string,
    content: string,
    changelog: string | null = null
  ): Promise<PublishResult> {
    const data: Record<string, string> = { namespace, content };
    if (changelog) {
      data.changelog = changelog;
    }

    const response = await fetch(this._buildUrl('/dossiers'), {
      method: 'POST',
      headers: this._buildHeaders('application/json'),
      body: JSON.stringify(data),
    });
    return this._handleResponse<PublishResult>(response);
  }

  /**
   * Delete a dossier from the registry.
   */
  async removeDossier(
    name: string,
    version: string | null = null
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (version) {
      params.version = version;
    }

    const response = await fetch(this._buildUrl(`/dossiers/${name}`, params), {
      method: 'DELETE',
      headers: this._buildHeaders(),
    });
    return this._handleResponse<Record<string, unknown>>(response);
  }

  /**
   * Get current user info.
   */
  async getMe(): Promise<Record<string, unknown>> {
    const response = await fetch(this._buildUrl('/me'), {
      headers: this._buildHeaders(),
    });
    return this._handleResponse<Record<string, unknown>>(response);
  }

  /**
   * Exchange OAuth code for access token.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<Record<string, unknown>> {
    const response = await fetch(this._buildUrl('/auth/token'), {
      method: 'POST',
      headers: this._buildHeaders('application/json'),
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    return this._handleResponse<Record<string, unknown>>(response);
  }
}

/**
 * Create a registry client for a specific resolved registry.
 */
function getClientForRegistry(registryUrl: string, token: string | null = null): RegistryClient {
  return new RegistryClient(registryUrl, token);
}

/**
 * Parse a name@version string.
 */
function parseNameVersion(name: string): [string, string | null] {
  if (name.includes('@')) {
    const idx = name.lastIndexOf('@');
    return [name.slice(0, idx), name.slice(idx + 1)];
  }
  return [name, null];
}

export { RegistryClient, RegistryError, getClientForRegistry, parseNameVersion };

export type {
  DossierInfo,
  DossierListItem,
  ListDossiersResult,
  DossierContentResult,
  PublishResult,
  SearchResult,
  ListDossiersOptions,
  SearchOptions,
};
