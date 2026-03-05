// Authentication utilities for JWT and GitHub OAuth

const jwt = require('jsonwebtoken');
const config = require('./config');

/**
 * Sign a JWT with user claims
 * @param {Object} payload - { sub, email, orgs }
 * @returns {string} Signed JWT
 */
function signJwt(payload) {
  return jwt.sign(payload, config.auth.jwt.secret, {
    expiresIn: config.auth.jwt.expiresIn,
  });
}

/**
 * Verify and decode a JWT
 * @param {string} token - JWT to verify
 * @returns {Object} Decoded payload
 * @throws {Error} If token is invalid or expired
 */
function verifyJwt(token) {
  return jwt.verify(token, config.auth.jwt.secret);
}

/**
 * Extract JWT from Authorization header
 * @param {Object} req - Request object
 * @returns {string|null} JWT token or null
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Encode JWT as display code (base64url for copy/paste)
 * @param {string} token - JWT token
 * @returns {string} Base64url encoded token
 */
function encodeAsDisplayCode(token) {
  return Buffer.from(token).toString('base64url');
}

/**
 * Decode display code back to JWT
 * @param {string} code - Display code
 * @returns {string} Original JWT
 */
function decodeDisplayCode(code) {
  return Buffer.from(code, 'base64url').toString('utf-8');
}

/**
 * Exchange GitHub OAuth code for access token
 * @param {string} code - OAuth code from GitHub
 * @returns {Promise<string>} GitHub access token
 */
async function exchangeGitHubCode(code) {
  const response = await fetch(config.auth.github.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.auth.github.clientId,
      client_secret: config.auth.github.clientSecret,
      code: code,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

/**
 * Fetch GitHub user info
 * @param {string} accessToken - GitHub access token
 * @returns {Promise<Object>} User info { login, email }
 */
async function fetchGitHubUser(accessToken) {
  const response = await fetch(`${config.auth.github.apiUrl}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Dossier-Registry',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch GitHub user's org memberships
 * @param {string} accessToken - GitHub access token
 * @returns {Promise<string[]>} Array of org login names
 */
async function fetchGitHubOrgs(accessToken) {
  const response = await fetch(`${config.auth.github.apiUrl}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Dossier-Registry',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const orgs = await response.json();
  return orgs.map((org) => org.login);
}

module.exports = {
  signJwt,
  verifyJwt,
  extractBearerToken,
  encodeAsDisplayCode,
  decodeDisplayCode,
  exchangeGitHubCode,
  fetchGitHubUser,
  fetchGitHubOrgs,
};
