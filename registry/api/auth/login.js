// GET /auth/login - Initiate GitHub OAuth flow
// Redirects user to GitHub for authentication

const config = require('../../lib/config');

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const params = new URLSearchParams({
    client_id: config.auth.github.clientId,
    redirect_uri: `https://${req.headers.host}/auth/callback`,
    scope: config.auth.github.scopes,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
};
