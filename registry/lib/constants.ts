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

/** JWT token expiry in seconds (30 days). */
export const JWT_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
