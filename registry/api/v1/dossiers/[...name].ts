import { sha256Hex } from '@ai-dossier/core';
import { authorizePublish } from '../../../lib/auth';
import config from '../../../lib/config';
import { handleCors } from '../../../lib/cors';
import { validateNamespace } from '../../../lib/dossier';
import * as github from '../../../lib/github';
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

  return handleGet(res, dossierName, version as string | undefined, isContentRequest);
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
    console.error(`[dossier/get] Error fetching '${dossierName}':`, error);
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
    console.error(`[dossier/delete] Error deleting '${dossierName}':`, err);
    return res.status(502).json({
      error: {
        code: 'DELETE_ERROR',
        message: 'Failed to delete dossier. Please try again.',
      },
    });
  }
}
