import { sha256Hex } from '@ai-dossier/core';
import { authorizePublish } from '../../../lib/auth';
import config from '../../../lib/config';
import { handleCors } from '../../../lib/cors';
import { validateNamespace } from '../../../lib/dossier';
import * as github from '../../../lib/github';
import { methodNotAllowed, serverError } from '../../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    return methodNotAllowed(res, 'GET', 'HEAD', 'DELETE');
  }

  const name = req.query.name;
  const version = Array.isArray(req.query.version) ? req.query.version[0] : req.query.version;
  const pathParts = Array.isArray(name) ? name : typeof name === 'string' ? name.split('/') : [];

  const isContentRequest = pathParts[pathParts.length - 1] === 'content';
  const dossierName = isContentRequest ? pathParts.slice(0, -1).join('/') : pathParts.join('/');

  const namespaceCheck = validateNamespace(dossierName);
  if (!namespaceCheck.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_NAMESPACE', message: namespaceCheck.error },
    });
  }

  if (req.method === 'DELETE') {
    return handleDelete(req, res, dossierName, version);
  }

  return handleGet(res, dossierName, version, isContentRequest);
}

async function handleGet(
  res: VercelResponse,
  dossierName: string,
  version: string | undefined,
  isContentRequest: boolean
) {
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

      const digest = sha256Hex(fileContent.content);

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
    if (error instanceof github.PathTraversalError) {
      return res.status(400).json({
        error: { code: 'INVALID_PATH', message: 'Path traversal is not allowed' },
      });
    }
    return serverError(res, {
      operation: `dossier.get(${dossierName})`,
      error,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to fetch dossier information',
    });
  }
}

async function handleDelete(
  req: VercelRequest,
  res: VercelResponse,
  dossierName: string,
  version: string | undefined
) {
  const authorized = await authorizePublish(req, res, dossierName);
  if (!authorized) return;

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
    if (err instanceof github.PathTraversalError) {
      return res.status(400).json({
        error: { code: 'INVALID_PATH', message: 'Path traversal is not allowed' },
      });
    }
    return serverError(res, {
      operation: `dossier.delete(${dossierName})`,
      error: err,
      code: 'DELETE_ERROR',
      message: 'Failed to delete dossier. Please try again.',
    });
  }
}
