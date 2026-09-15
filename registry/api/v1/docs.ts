import config from '../../lib/config';
import { HTTP_STATUS } from '../../lib/constants';
import { handleCors } from '../../lib/cors';
import { methodNotAllowed } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

const healthEndpoint = {
  description: 'Health check',
  authentication: false,
  response: {
    status: 'string',
    service: 'string',
    version: 'string',
  },
};

const docsEndpoint = {
  description: 'This documentation endpoint',
  authentication: false,
};

const meEndpoint = {
  description: 'Get current authenticated user info',
  authentication: true,
  response: {
    username: 'string - GitHub username',
    email: 'string | null - GitHub email',
    orgs: 'string[] - GitHub organizations',
    can_publish_to: 'string[] - Namespaces user can publish to',
  },
};

const paginationDoc = {
  page: 'number',
  per_page: 'number',
  total: 'number',
};

const listDossiersEndpoint = {
  description: 'List all dossiers',
  authentication: false,
  response: {
    dossiers: 'array - List of dossier metadata',
    pagination: paginationDoc,
  },
};

const getDossierEndpoint = {
  description: 'Get dossier metadata by name',
  authentication: false,
  parameters: {
    name: 'string - Full dossier name (e.g., imboard-ai/development/setup-react)',
  },
  response: {
    name: 'string',
    title: 'string',
    version: 'string',
    category: 'string',
    content_url: 'string - CDN URL to fetch content',
  },
};

const searchEndpoint = {
  description: 'Search dossiers by query',
  authentication: false,
  parameters: {
    q: 'string - Search query (matches name, title, description, category, tags). Max 1000 characters.',
    page: 'number - Page number (default: 1)',
    per_page: 'number - Results per page (default: 20, max: 100)',
  },
  response: {
    dossiers: 'array - List of matching dossier metadata',
    pagination: paginationDoc,
  },
  errors: {
    400: 'MISSING_QUERY, QUERY_TOO_LONG',
  },
};

const getDossierContentEndpoint = {
  description: 'Get dossier content with integrity digest',
  authentication: false,
  response: 'text/markdown body with X-Dossier-Digest header (sha256:<hex>)',
};

const getDossierEvidenceEndpoint = {
  description: 'Get the evidence sidecar record for a dossier (GET/HEAD only)',
  authentication: false,
  parameters: {
    name: 'string - Full dossier name (e.g., imboard-ai/development/setup-react)',
    version: 'string (query, optional) - Must match the current version, else 404',
  },
  response:
    'application/json body (the stored evidence record) with X-Evidence-Checksum header (sha256:<hex> — the dossier body checksum the record is keyed to, not a digest of this JSON)',
  errors: {
    404: 'DOSSIER_NOT_FOUND, VERSION_NOT_FOUND, EVIDENCE_NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED - Only GET and HEAD are allowed; DELETE is rejected',
    502: 'EVIDENCE_CORRUPT - Stored evidence record failed to parse or does not match the dossier',
  },
};

const publishDossierEndpoint = {
  description: 'Publish a new dossier',
  authentication: true,
  request: {
    contentType: 'application/json',
    body: {
      namespace: {
        type: 'string',
        required: true,
        description: 'Target namespace (e.g., "imboard-ai/development")',
        example: 'yuvaldim/tools',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Full .ds.md file content with YAML frontmatter',
        example:
          '---\nname: my-dossier\ntitle: My Dossier\nversion: 1.0.0\n---\n\n# Instructions\n...',
      },
      changelog: {
        type: 'string',
        required: false,
        description: 'Description of changes for this version. Max 500 characters.',
        example: 'Initial release',
      },
      evidence: {
        type: 'string',
        required: false,
        description:
          'JSON-encoded evidence record (.evidence.json) for this dossier body checksum; its dossier/version/checksum must match the published content. Max 256KB. Omitting it removes any existing sidecar from a prior version.',
        example:
          '{"evidence_schema_version":"1.0.0","dossier":"yuvaldim/tools/my-dossier","version":"1.0.0","checksum":{"algorithm":"sha256","hash":"<64 hex chars>"},"entries":[]}',
      },
    },
  },
  response: {
    name: 'string - Full dossier name (namespace + name)',
    version: 'string',
    title: 'string',
    content_url: 'string - CDN URL',
    published_at: 'string - ISO timestamp',
    evidence_url: 'string - CDN URL to the evidence sidecar (present only when evidence was sent)',
  },
  errors: {
    400: 'MISSING_FIELD, INVALID_FIELD, INVALID_NAMESPACE, INVALID_CONTENT, CHANGELOG_TOO_LONG, INVALID_EVIDENCE, EVIDENCE_MISMATCH',
    401: 'MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED',
    403: 'FORBIDDEN - Cannot publish to this namespace (includes `namespace` field)',
    413: 'CONTENT_TOO_LARGE - Max 1MB; EVIDENCE_TOO_LARGE - Max 256KB',
    415: 'UNSUPPORTED_MEDIA_TYPE - Content-Type must be application/json',
    502: 'PUBLISH_ERROR - Includes request_id for log correlation',
  },
};

const deleteDossierEndpoint = {
  description: 'Delete a dossier (also removes its evidence sidecar, best-effort)',
  authentication: true,
  parameters: {
    name: 'string - Full dossier name (e.g., imboard-ai/development/setup-react)',
    version: 'string (query, optional) - Specific version to delete',
  },
  response: {
    message: 'string - "Dossier deleted"',
    name: 'string - Full dossier name',
    version: 'string (optional) - Deleted version',
  },
  errors: {
    401: 'MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED',
    403: 'FORBIDDEN - Cannot delete from this namespace (includes `namespace` field)',
    404: 'DOSSIER_NOT_FOUND, VERSION_NOT_FOUND',
    502: 'DELETE_ERROR - Includes request_id for log correlation',
  },
};

const errorResponseDoc = {
  description: 'Server errors (5xx) include a request_id for correlating with server logs',
  format: {
    error: {
      code: 'string - Error code (e.g., UPSTREAM_ERROR)',
      message: 'string - Human-readable error description',
      request_id:
        'string - Correlation ID for server log lookup (echoed from X-Request-Id header, or server-generated UUID if absent)',
    },
  },
};

const endpoints = {
  'GET /api/v1/health': healthEndpoint,
  'GET /api/v1/docs': docsEndpoint,
  'GET /api/v1/me': meEndpoint,
  'GET /api/v1/dossiers': listDossiersEndpoint,
  'GET /api/v1/dossiers/{name}': getDossierEndpoint,
  'GET /api/v1/search': searchEndpoint,
  'GET /api/v1/dossiers/{name}/content': getDossierContentEndpoint,
  'GET /api/v1/dossiers/{name}/evidence': getDossierEvidenceEndpoint,
  'DELETE /api/v1/dossiers/{name}': deleteDossierEndpoint,
  'POST /api/v1/dossiers': publishDossierEndpoint,
};

const frontmatterDocs = {
  description: 'Required YAML frontmatter for dossier content',
  required: {
    name: 'string - Dossier slug (lowercase, alphanumeric, hyphens)',
    title: 'string - Human-readable title',
    version: 'string - Semver format (x.y.z)',
  },
  optional: {
    description: 'string - Short description',
    category: 'string - Category name',
    tags: 'string[] - Array of tags',
    author: 'string - Author name',
  },
  example: `---
name: setup-react-library
title: Setup React Library
version: 1.0.0
description: Guide for setting up a React component library
category: development
tags: [react, library, setup]
---

# Instructions

Your dossier content here...`,
};

const namespaceDocs = {
  description: 'Publishing permissions based on GitHub identity',
  rules: [
    'Personal namespace: You can publish to {your-username}/*',
    'Organization namespace: You can publish to {org}/* if you are a member',
  ],
  example: 'User "yuvaldim" in org "imboard-ai" can publish to: yuvaldim/*, imboard-ai/*',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return methodNotAllowed(req, res, 'GET');
  }

  const baseUrl = `https://${req.headers.host}`;

  return res.status(HTTP_STATUS.OK).json({
    name: 'Dossier Registry API',
    version: config.apiVersion,
    baseUrl,
    authentication: {
      type: 'Bearer Token (JWT)',
      description: 'Obtain a token via GitHub OAuth flow',
      loginUrl: `${baseUrl}/auth/login`,
      header: 'Authorization: Bearer <token>',
    },
    endpoints,
    errorResponse: errorResponseDoc,
    frontmatter: frontmatterDocs,
    namespaces: namespaceDocs,
  });
}
