// CORS helper for API handlers

/**
 * Set CORS headers on a response.
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
}

/**
 * Handle CORS for a request. Sets headers and handles OPTIONS preflight.
 * Returns true if the request was an OPTIONS preflight (caller should return early).
 */
function handleCors(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  return false;
}

module.exports = { setCorsHeaders, handleCors };
