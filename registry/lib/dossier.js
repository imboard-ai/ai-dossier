// Dossier parsing and validation utilities

const matter = require('gray-matter');

/**
 * Parse frontmatter from dossier content (supports YAML, JSON via gray-matter)
 * @param {string} content - Full .ds.md file content
 * @returns {Object} { frontmatter: Object, body: string }
 * @throws {Error} If frontmatter is missing or malformed
 */
function parseFrontmatter(content) {
  // Check for frontmatter delimiters first (gray-matter is lenient without them)
  // Support both standard "---" and dossier-specific "---dossier" delimiters
  if (!content.startsWith('---')) {
    throw new Error('Missing or malformed frontmatter. Content must start with --- or ---dossier and end with ---');
  }

  // Normalize ---dossier to --- for gray-matter parsing
  let normalizedContent = content;
  if (content.startsWith('---dossier')) {
    normalizedContent = '---' + content.slice('---dossier'.length);
  }

  let parsed;
  try {
    parsed = matter(normalizedContent);
  } catch (err) {
    throw new Error(`Invalid frontmatter: ${err.message}`);
  }

  // gray-matter returns empty object {} for empty frontmatter, and content in .content
  // It returns the body after the closing --- in .content
  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    // Check if there was actually frontmatter (not just ---)
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
    if (!frontmatterRegex.test(normalizedContent)) {
      throw new Error('Missing or malformed frontmatter. Content must start with --- or ---dossier and end with ---');
    }
  }

  return { frontmatter: parsed.data || {}, body: parsed.content };
}

/**
 * Validate dossier has required fields
 * @param {Object} frontmatter - Parsed frontmatter
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateDossier(frontmatter) {
  const errors = [];
  const required = ['name', 'title', 'version'];

  for (const field of required) {
    if (!frontmatter[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate name format (lowercase, alphanumeric, hyphens)
  if (frontmatter.name) {
    if (typeof frontmatter.name !== 'string') {
      errors.push(`Name must be a string, got ${typeof frontmatter.name}`);
    } else {
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(frontmatter.name)) {
        errors.push(`Invalid name "${frontmatter.name}": must be lowercase alphanumeric with hyphens, cannot start/end with hyphen`);
      }
      if (frontmatter.name.length > 64) {
        errors.push(`Name too long (${frontmatter.name.length} chars): must be 64 characters or less`);
      }
    }
  }

  // Validate version format (semver-like)
  if (frontmatter.version) {
    if (typeof frontmatter.version !== 'string') {
      errors.push(`Version must be a string, got ${typeof frontmatter.version} (use quotes: version: "1.0.0")`);
    } else if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(frontmatter.version)) {
      errors.push(`Invalid version "${frontmatter.version}": must be in semver format (x.y.z)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Build full dossier path from namespace and name
 * @param {string} namespace - e.g., "imboard-ai/development"
 * @param {string} name - e.g., "setup-react"
 * @returns {string} Full path, e.g., "imboard-ai/development/setup-react"
 */
function buildFullName(namespace, name) {
  // Normalize: remove trailing slashes
  const normalizedNamespace = namespace.replace(/\/+$/, '');
  return `${normalizedNamespace}/${name}`;
}

/**
 * Extract root namespace (first segment) for permission checking
 * @param {string} namespace - e.g., "imboard-ai/development"
 * @returns {string} Root namespace, e.g., "imboard-ai"
 */
function getRootNamespace(namespace) {
  return namespace.split('/')[0];
}

/**
 * Validate namespace format
 * @param {string} namespace
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateNamespace(namespace) {
  if (!namespace) {
    return { valid: false, error: 'Namespace is required' };
  }

  // Check for path traversal
  if (namespace.includes('..')) {
    return { valid: false, error: 'Invalid namespace: contains ..' };
  }

  // Check format (segments separated by /, each segment alphanumeric + hyphens)
  const segments = namespace.split('/');
  if (segments.length > 5) {
    return { valid: false, error: 'Namespace too deep (max 5 levels)' };
  }

  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(segment)) {
      return { valid: false, error: `Invalid namespace segment: ${segment}` };
    }
  }

  return { valid: true, error: null };
}

module.exports = {
  parseFrontmatter,
  validateDossier,
  buildFullName,
  getRootNamespace,
  validateNamespace,
};
