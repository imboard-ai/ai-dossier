// GET /api/v1/dossiers/{name} - Get dossier metadata
// GET /api/v1/dossiers/{name}/content - Return content with digest header
// DELETE /api/v1/dossiers/{name} - Delete dossier
// DELETE /api/v1/dossiers/{name}?version={version} - Delete specific version

const crypto = require('crypto');
const config = require('../../../lib/config');
const auth = require('../../../lib/auth');
const github = require('../../../lib/github');
const { getRootNamespace } = require('../../../lib/dossier');
const { canPublishTo } = require('../../../lib/permissions');
const { handleCors } = require('../../../lib/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD, and DELETE are allowed' } });
  }

  const { name, version } = req.query;
  // Handle both array (from Vercel) and string (from rewrite) formats
  const pathParts = Array.isArray(name) ? name : name.split('/');

  // Check if this is a /content request
  const isContentRequest = pathParts[pathParts.length - 1] === 'content';
  const dossierName = isContentRequest ? pathParts.slice(0, -1).join('/') : pathParts.join('/');

  if (req.method === 'DELETE') {
    return handleDelete(req, res, dossierName, version);
  }

  try {
    // Fetch manifest to find the dossier
    const manifestUrl = config.getManifestUrl();
    const response = await fetch(manifestUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }

    const manifest = await response.json();
    const dossier = manifest.dossiers.find((d) => d.name === dossierName);

    if (!dossier) {
      return res.status(404).json({
        error: {
          code: 'DOSSIER_NOT_FOUND',
          message: `Dossier '${dossierName}' not found`,
        },
      });
    }

    // Handle /content endpoint - fetch and return content with digest
    if (isContentRequest) {
      const fileContent = await github.getFileContent(dossier.path);

      if (!fileContent) {
        return res.status(404).json({
          error: {
            code: 'CONTENT_NOT_FOUND',
            message: `Content for dossier '${dossierName}' not found`,
          },
        });
      }

      const digest = crypto.createHash('sha256').update(fileContent.content).digest('hex');

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('X-Dossier-Digest', `sha256:${digest}`);
      return res.status(200).send(fileContent.content);
    }

    // Return metadata
    return res.status(200).json({
      name: dossier.name,
      title: dossier.title,
      version: dossier.version,
      category: dossier.category,
      content_url: config.getCdnUrl(dossier.path),
    });
  } catch (error) {
    console.error('Error fetching dossier:', error);
    return res.status(502).json({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to fetch dossier information',
      },
    });
  }
};

/**
 * DELETE /api/v1/dossiers/{name} - Delete a dossier
 * DELETE /api/v1/dossiers/{name}?version={version} - Delete specific version
 */
async function handleDelete(req, res, dossierName, version) {
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

  // 2. Check permissions - user must own the namespace
  const rootNamespace = getRootNamespace(dossierName);
  const permission = canPublishTo(jwtPayload, rootNamespace);
  if (!permission.allowed) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: permission.reason },
    });
  }

  // 3. Delete the dossier
  try {
    const result = await github.deleteDossier(dossierName, version || null);

    if (!result.found) {
      return res.status(404).json({
        error: {
          code: 'DOSSIER_NOT_FOUND',
          message: `Dossier '${dossierName}' not found`,
        },
      });
    }

    if (result.versionMismatch) {
      return res.status(404).json({
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `Version '${result.requestedVersion}' not found. Current version is '${result.currentVersion}'`,
        },
      });
    }

    // Success response
    const response = {
      message: 'Dossier deleted',
      name: dossierName,
    };

    // Include version in response if specific version was deleted
    if (version) {
      response.version = version;
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('Error deleting dossier:', err);
    return res.status(502).json({
      error: {
        code: 'DELETE_ERROR',
        message: 'Failed to delete dossier. Please try again.',
      },
    });
  }
}
