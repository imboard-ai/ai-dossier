import crypto from 'node:crypto';
import * as auth from '../../../lib/auth';
import config from '../../../lib/config';
import { handleCors } from '../../../lib/cors';
import { getRootNamespace, validateNamespace } from '../../../lib/dossier';
import * as github from '../../../lib/github';
import { canPublishTo } from '../../../lib/permissions';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD, and DELETE are allowed' },
    });
  }

  const { name, version } = req.query as Record<string, string | string[]>;
  const pathParts = Array.isArray(name) ? name : (name as string).split('/');

  const isContentRequest = pathParts[pathParts.length - 1] === 'content';
  const dossierName = isContentRequest ? pathParts.slice(0, -1).join('/') : pathParts.join('/');

  const namespaceCheck = validateNamespace(dossierName);
  if (!namespaceCheck.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_NAMESPACE', message: namespaceCheck.error },
    });
  }

  if (req.method === 'DELETE') {
    return handleDelete(req, res, dossierName, version as string);
  }

  try {
    const manifest = await github.getManifest();
    const dossierEntry = manifest.dossiers.find((d) => d.name === dossierName);

    if (!dossierEntry) {
      return res.status(404).json({
        error: {
          code: 'DOSSIER_NOT_FOUND',
          message: `Dossier '${dossierName}' not found`,
        },
      });
    }

    if (version && dossierEntry.version !== version) {
      return res.status(404).json({
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `Dossier '${dossierName}' version '${version}' not found (latest: ${dossierEntry.version})`,
        },
      });
    }

    if (isContentRequest) {
      const fileContent = await github.getFileContent(dossierEntry.path);

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

    return res.status(200).json({
      name: dossierEntry.name,
      title: dossierEntry.title,
      version: dossierEntry.version,
      category: dossierEntry.category,
      content_url: config.getCdnUrl(dossierEntry.path),
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
}

async function handleDelete(
  req: VercelRequest,
  res: VercelResponse,
  dossierName: string,
  version: string | undefined
) {
  const token = auth.extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header required. Use: Bearer <token>',
      },
    });
  }

  let jwtPayload: import('../../../lib/types').JwtPayload;
  try {
    jwtPayload = auth.verifyJwt(token);
  } catch (err) {
    if (err instanceof Error && err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: { code: 'TOKEN_EXPIRED', message: 'Token has expired. Please login again.' },
      });
    }
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid token. Please login again.' },
    });
  }

  const rootNamespace = getRootNamespace(dossierName);
  const permission = canPublishTo(jwtPayload, rootNamespace);
  if (!permission.allowed) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: permission.reason },
    });
  }

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

    const response: Record<string, string> = {
      message: 'Dossier deleted',
      name: dossierName,
    };

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
