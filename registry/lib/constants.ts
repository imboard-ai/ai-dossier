/** Default fields for dossier list/search responses. */
export const DOSSIER_DEFAULTS = {
  description: null,
  category: null,
  tags: [],
  authors: [],
  tools_required: [],
};

/** Maximum dossier content size (1MB). */
export const MAX_CONTENT_SIZE = 1024 * 1024;

/** Maximum namespace depth. */
export const MAX_NAMESPACE_DEPTH = 5;

/** Maximum dossier name length. */
export const MAX_NAME_LENGTH = 64;

/** JWT token expiry in seconds (7 days). */
export const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Valid slug pattern: lowercase alphanumeric with hyphens, no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** GitHub API version header value. */
export const GITHUB_API_VERSION = '2022-11-28';

/** User-Agent header for outgoing GitHub API requests. */
export const USER_AGENT = 'Dossier-Registry';

/** Cookie name for OAuth CSRF state parameter. */
export const OAUTH_STATE_COOKIE = 'dossier_oauth_state';

/** OAuth state cookie max age in seconds (10 minutes). */
export const OAUTH_STATE_MAX_AGE = 600;

/** Default items per page for search/list. */
export const DEFAULT_PER_PAGE = 20;

/** Maximum items per page for search/list. */
export const MAX_PER_PAGE = 100;
