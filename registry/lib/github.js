// GitHub API utilities for content repo operations

const config = require('./config');

const GITHUB_API = 'https://api.github.com';

/**
 * Make authenticated request to GitHub API
 */
async function githubRequest(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.content.botToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Dossier-Registry',
      ...options.headers,
    },
  });

  return response;
}

/**
 * Get file content from content repo
 * @param {string} path - File path in repo
 * @returns {Object|null} { content, sha } or null if not found
 */
async function getFileContent(path) {
  const { org, repo } = config.content;
  const response = await githubRequest(`/repos/${org}/${repo}/contents/${path}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

/**
 * Delete file from content repo
 * @param {string} path - File path in repo
 * @param {string} message - Commit message
 * @param {string} sha - File SHA (required for deletion)
 * @returns {Object} GitHub API response
 */
async function deleteFile(path, message, sha) {
  const { org, repo } = config.content;

  const response = await githubRequest(`/repos/${org}/${repo}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`GitHub API error: ${response.status} - ${error.message || JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Create or update file in content repo
 * @param {string} path - File path in repo
 * @param {string} content - File content
 * @param {string} message - Commit message
 * @param {string|null} sha - Existing file SHA (for updates)
 * @returns {Object} { commit, content }
 */
async function createOrUpdateFile(path, content, message, sha = null) {
  const { org, repo } = config.content;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await githubRequest(`/repos/${org}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`GitHub API error: ${response.status} - ${error.message || JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Get current manifest (index.json)
 * @returns {Object} { dossiers: [...], sha: string }
 */
async function getManifest() {
  const result = await getFileContent('index.json');

  if (!result) {
    // Return empty manifest if doesn't exist
    return { dossiers: [], sha: null };
  }

  const manifest = JSON.parse(result.content);
  return { ...manifest, sha: result.sha };
}

/**
 * Update manifest with new/updated dossier entry
 * @param {Object} currentManifest - Current manifest with sha
 * @param {Object} dossierEntry - New dossier entry to add/update
 * @returns {Object} GitHub API response
 */
async function updateManifest(currentManifest, dossierEntry) {
  const { sha, ...manifest } = currentManifest;

  // Find existing entry by name
  const existingIndex = manifest.dossiers.findIndex(d => d.name === dossierEntry.name);

  if (existingIndex >= 0) {
    // Update existing
    manifest.dossiers[existingIndex] = dossierEntry;
  } else {
    // Add new
    manifest.dossiers.push(dossierEntry);
  }

  // Sort by name for consistent ordering
  manifest.dossiers.sort((a, b) => a.name.localeCompare(b.name));

  const content = JSON.stringify(manifest, null, 2) + '\n';
  const message = existingIndex >= 0
    ? `Update manifest: ${dossierEntry.name} v${dossierEntry.version}`
    : `Add to manifest: ${dossierEntry.name} v${dossierEntry.version}`;

  return createOrUpdateFile('index.json', content, message, sha);
}

/**
 * Remove dossier from manifest
 * @param {Object} currentManifest - Current manifest with sha
 * @param {string} dossierName - Name of dossier to remove
 * @returns {Object} GitHub API response
 */
async function removeFromManifest(currentManifest, dossierName) {
  const { sha, ...manifest } = currentManifest;

  // Find and remove the entry
  const existingIndex = manifest.dossiers.findIndex(d => d.name === dossierName);

  if (existingIndex < 0) {
    throw new Error(`Dossier '${dossierName}' not found in manifest`);
  }

  manifest.dossiers.splice(existingIndex, 1);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  const message = `Remove from manifest: ${dossierName}`;

  return createOrUpdateFile('index.json', content, message, sha);
}

/**
 * Publish a dossier (file + manifest update)
 * @param {string} fullPath - Full path including namespace, e.g., "imboard-ai/dev/setup-react"
 * @param {string} content - Dossier content
 * @param {Object} metadata - { name, title, version, ... }
 * @param {string} changelog - Changelog message
 * @returns {Object} { file, manifest }
 */
async function publishDossier(fullPath, content, metadata, changelog) {
  const filePath = `${fullPath}.ds.md`;

  // Check if file exists (for update)
  const existing = await getFileContent(filePath);

  // Commit the dossier file
  const fileMessage = existing
    ? `Update ${metadata.name} to v${metadata.version}: ${changelog}`
    : `Publish ${metadata.name} v${metadata.version}: ${changelog}`;

  const fileResult = await createOrUpdateFile(
    filePath,
    content,
    fileMessage,
    existing?.sha
  );

  // Update manifest
  const manifest = await getManifest();

  // Optional fields to include in manifest (add new fields here as needed)
  const OPTIONAL_MANIFEST_FIELDS = ['description', 'category', 'tags', 'authors', 'tools_required'];

  const dossierEntry = {
    name: fullPath,
    title: metadata.title,
    version: metadata.version,
    path: filePath,
  };

  // Add optional fields if present
  for (const field of OPTIONAL_MANIFEST_FIELDS) {
    if (metadata[field] !== undefined) {
      dossierEntry[field] = metadata[field];
    }
  }

  const manifestResult = await updateManifest(manifest, dossierEntry);

  return {
    file: fileResult,
    manifest: manifestResult,
  };
}

/**
 * Delete a dossier (file + manifest update)
 * @param {string} dossierName - Full dossier name, e.g., "imboard-ai/dev/setup-react"
 * @param {string|null} expectedVersion - If provided, only delete if version matches
 * @returns {Object} { file, manifest, version }
 */
async function deleteDossier(dossierName, expectedVersion = null) {
  const filePath = `${dossierName}.ds.md`;

  // Get the file to verify it exists and get SHA
  const existing = await getFileContent(filePath);

  if (!existing) {
    return { found: false };
  }

  // Get manifest to check version and get the dossier entry
  const manifest = await getManifest();
  const dossierEntry = manifest.dossiers.find(d => d.name === dossierName);

  if (!dossierEntry) {
    // File exists but not in manifest - clean up file only
    const fileResult = await deleteFile(
      filePath,
      `Delete orphaned file: ${dossierName}`,
      existing.sha
    );
    return { found: true, version: null, file: fileResult };
  }

  // If expectedVersion is provided, verify it matches
  if (expectedVersion && dossierEntry.version !== expectedVersion) {
    return {
      found: true,
      versionMismatch: true,
      currentVersion: dossierEntry.version,
      requestedVersion: expectedVersion,
    };
  }

  // Delete the file
  const fileResult = await deleteFile(
    filePath,
    `Delete ${dossierName} v${dossierEntry.version}`,
    existing.sha
  );

  // Remove from manifest
  const manifestResult = await removeFromManifest(manifest, dossierName);

  return {
    found: true,
    version: dossierEntry.version,
    file: fileResult,
    manifest: manifestResult,
  };
}

module.exports = {
  getFileContent,
  createOrUpdateFile,
  deleteFile,
  getManifest,
  updateManifest,
  removeFromManifest,
  publishDossier,
  deleteDossier,
};
