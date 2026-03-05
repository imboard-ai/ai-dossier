// GET /api/v1/dossiers - List all dossiers
// POST /api/v1/dossiers - Publish a dossier

const config = require('../../../lib/config');
const auth = require('../../../lib/auth');
const dossier = require('../../../lib/dossier');
const github = require('../../../lib/github');
const { canPublishTo } = require('../../../lib/permissions');
const { handleCors } = require('../../../lib/cors');

const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method === 'GET') {
    return handleList(req, res);
  }

  if (req.method === 'POST') {
    return handlePublish(req, res);
  }

  return res.status(405).json({
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed' },
  });
};

// Default values for optional fields - ensures consistent API response schema
const DOSSIER_DEFAULTS = {
  description: null,
  category: null,
  tags: [],
  authors: [],
  tools_required: [],
};

/**
 * GET /api/v1/dossiers - List all dossiers
 */
async function handleList(req, res) {
  try {
    const manifestUrl = config.getManifestUrl();
    const response = await fetch(manifestUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }

    const manifest = await response.json();

    // Normalize dossiers with consistent schema and add URL
    const dossiers = manifest.dossiers.map(dossier => ({
      ...DOSSIER_DEFAULTS,
      ...dossier,
      url: config.getCdnUrl(dossier.path),
    }));

    return res.status(200).json({
      dossiers,
      pagination: {
        page: 1,
        per_page: dossiers.length,
        total: dossiers.length,
      },
    });
  } catch (error) {
    console.error('Error fetching dossiers:', error);
    return res.status(502).json({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to fetch dossier list',
      },
    });
  }
}

/**
 * POST /api/v1/dossiers - Publish a dossier
 */
async function handlePublish(req, res) {
  // 1. Check authentication
  const token = auth.extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header required. Use: Bearer <token>',
      },
    });
  }

  let jwtPayload;
  try {
    jwtPayload = auth.verifyJwt(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: { code: 'TOKEN_EXPIRED', message: 'Token has expired. Please login again.' },
      });
    }
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid token. Please login again.' },
    });
  }

  // 2. Parse request body
  const { namespace, content, changelog } = req.body || {};

  if (!namespace) {
    return res.status(400).json({
      error: { code: 'MISSING_FIELD', message: 'Missing required field: namespace' },
    });
  }

  if (!content) {
    return res.status(400).json({
      error: { code: 'MISSING_FIELD', message: 'Missing required field: content' },
    });
  }

  // 3. Validate content size
  if (content.length > MAX_CONTENT_SIZE) {
    return res.status(413).json({
      error: {
        code: 'CONTENT_TOO_LARGE',
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024}KB`,
      },
    });
  }

  // 4. Validate namespace format
  const namespaceValidation = dossier.validateNamespace(namespace);
  if (!namespaceValidation.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_NAMESPACE', message: namespaceValidation.error },
    });
  }

  // 5. Check permissions
  const permission = canPublishTo(jwtPayload, namespace);
  if (!permission.allowed) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: permission.reason },
    });
  }

  // 6. Parse and validate dossier content
  let parsed;
  try {
    parsed = dossier.parseFrontmatter(content);
  } catch (err) {
    return res.status(400).json({
      error: { code: 'INVALID_CONTENT', message: err.message },
    });
  }

  const validation = dossier.validateDossier(parsed.frontmatter);
  if (!validation.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_CONTENT', message: validation.errors.join('; ') },
    });
  }

  // 7. Build full path and publish
  const fullPath = dossier.buildFullName(namespace, parsed.frontmatter.name);
  const changelogMessage = changelog || 'No changelog provided';

  try {
    const result = await github.publishDossier(
      fullPath,
      content,
      parsed.frontmatter,
      changelogMessage
    );

    return res.status(201).json({
      name: fullPath,
      version: parsed.frontmatter.version,
      title: parsed.frontmatter.title,
      content_url: config.getCdnUrl(`${fullPath}.ds.md`),
      published_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error publishing dossier:', err);
    return res.status(502).json({
      error: {
        code: 'PUBLISH_ERROR',
        message: `Failed to publish dossier: ${err.message}`,
      },
    });
  }
}
