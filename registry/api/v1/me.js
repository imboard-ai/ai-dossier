// GET /api/v1/me - Get current user info (protected)

const auth = require('../../lib/auth');
const { handleCors } = require('../../lib/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  // Extract JWT from Authorization header
  const token = auth.extractBearerToken(req);

  if (!token) {
    return res.status(401).json({
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header required. Use: Bearer <token>',
      },
    });
  }

  try {
    // Verify and decode JWT
    const payload = auth.verifyJwt(token);

    // Build response with user info and computed permissions
    const username = payload.sub;
    const orgs = payload.orgs || [];

    // User can publish to their personal namespace and any org they belong to
    const canPublishTo = [
      `${username}/*`,
      ...orgs.map((org) => `${org}/*`),
    ];

    return res.status(200).json({
      username: username,
      email: payload.email || null,
      orgs: orgs,
      can_publish_to: canPublishTo,
    });
  } catch (err) {
    // Handle JWT errors
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'Token has expired. Please login again.',
        },
      });
    }

    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid token. Please login again.',
        },
      });
    }

    // Unexpected error
    console.error('JWT verification error:', err);
    return res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      },
    });
  }
};
