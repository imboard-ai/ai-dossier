import { handleCors } from '../../lib/cors';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const baseUrl = `https://${req.headers.host}`;

  return res.status(200).json({
    name: 'Dossier Registry API',
    version: 'MVP1',
    baseUrl,
    authentication: {
      type: 'Bearer Token (JWT)',
      description: 'Obtain a token via GitHub OAuth flow',
      loginUrl: `${baseUrl}/auth/login`,
      header: 'Authorization: Bearer <token>',
    },
    endpoints: {
      'GET /api/v1/health': {
        description: 'Health check',
        authentication: false,
        response: {
          status: 'string',
          service: 'string',
          version: 'string',
        },
      },
      'GET /api/v1/docs': {
        description: 'This documentation endpoint',
        authentication: false,
      },
      'GET /api/v1/me': {
        description: 'Get current authenticated user info',
        authentication: true,
        response: {
          username: 'string - GitHub username',
          email: 'string | null - GitHub email',
          orgs: 'string[] - GitHub organizations',
          can_publish_to: 'string[] - Namespaces user can publish to',
        },
      },
      'GET /api/v1/dossiers': {
        description: 'List all dossiers',
        authentication: false,
        response: {
          dossiers: 'array - List of dossier metadata',
          pagination: {
            page: 'number',
            per_page: 'number',
            total: 'number',
          },
        },
      },
      'GET /api/v1/dossiers/{name}': {
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
      },
      'GET /api/v1/search': {
        description: 'Search dossiers by query',
        authentication: false,
        parameters: {
          q: 'string - Search query (matches name, title, description, category, tags)',
          page: 'number - Page number (default: 1)',
          per_page: 'number - Results per page (default: 20, max: 100)',
        },
        response: {
          dossiers: 'array - List of matching dossier metadata',
          pagination: {
            page: 'number',
            per_page: 'number',
            total: 'number',
          },
        },
      },
      'GET /api/v1/dossiers/{name}/content': {
        description: 'Get dossier content with integrity digest',
        authentication: false,
        response: 'text/markdown body with X-Dossier-Digest header (sha256:<hex>)',
      },
      'DELETE /api/v1/dossiers/{name}': {
        description: 'Delete a dossier',
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
          403: 'FORBIDDEN - Cannot delete from this namespace',
          404: 'DOSSIER_NOT_FOUND, VERSION_NOT_FOUND',
          502: 'DELETE_ERROR - Failed to delete dossier',
        },
      },
      'POST /api/v1/dossiers': {
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
              description: 'Description of changes for this version',
              example: 'Initial release',
            },
          },
        },
        response: {
          name: 'string - Full dossier name (namespace + name)',
          version: 'string',
          title: 'string',
          content_url: 'string - CDN URL',
          published_at: 'string - ISO timestamp',
        },
        errors: {
          400: 'MISSING_FIELD, INVALID_NAMESPACE, INVALID_CONTENT',
          401: 'MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED',
          403: 'FORBIDDEN - Cannot publish to this namespace',
          413: 'CONTENT_TOO_LARGE - Max 1MB',
        },
      },
    },
    frontmatter: {
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
    },
    namespaces: {
      description: 'Publishing permissions based on GitHub identity',
      rules: [
        'Personal namespace: You can publish to {your-username}/*',
        'Organization namespace: You can publish to {org}/* if you are a member',
      ],
      example: 'User "yuvaldim" in org "imboard-ai" can publish to: yuvaldim/*, imboard-ai/*',
    },
  });
}
