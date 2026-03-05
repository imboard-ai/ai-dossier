// Permission checking utilities

const { getRootNamespace } = require('./dossier');

/**
 * Check if a user can publish to a namespace
 * @param {Object} jwtPayload - Decoded JWT { sub, orgs }
 * @param {string} namespace - Target namespace, e.g., "imboard-ai/development"
 * @returns {Object} { allowed: boolean, reason: string }
 */
function canPublishTo(jwtPayload, namespace) {
  const rootNamespace = getRootNamespace(namespace);
  const username = jwtPayload.sub;
  const orgs = jwtPayload.orgs || [];

  // Personal namespace: root must match username
  if (rootNamespace === username) {
    return {
      allowed: true,
      reason: `Personal namespace: ${username}`,
    };
  }

  // Org namespace: root must be in user's orgs
  if (orgs.includes(rootNamespace)) {
    return {
      allowed: true,
      reason: `Organization namespace: ${rootNamespace}`,
    };
  }

  // Not allowed
  return {
    allowed: false,
    reason: `You cannot publish to namespace '${rootNamespace}'. You can publish to: ${username}, ${orgs.join(', ') || '(no orgs)'}`,
  };
}

module.exports = {
  canPublishTo,
};
