import { sha256Hex } from '@ai-dossier/core';
import { authorizePublish } from '../../../lib/auth';
import config from '../../../lib/config';
import { HTTP_STATUS } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import { validateNamespace } from '../../../lib/dossier';
import * as github from '../../../lib/github';
import createLogger from '../../../lib/logger';
import { queryString } from '../../../lib/query';
import {
  getRequestId,
  invalidPathError,
  methodNotAllowed,
  serverError,
} from '../../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

const log = createLogger('dossiers/[name]');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    return methodNotAllowed(req, res, 'GET', 'HEAD', 'DELETE');
  }

  const name = req.query.name;
  const version = queryString(req.query.version);
  const pathParts = Array.isArray(name) ? name : typeof name === 'string' ? name.split('/') : [];

  const isContentRequest = pathParts[pathParts.length - 1] === 'content';
  const dossierName = isContentRequest ? pathParts.slice(0, -1).join('/') : pathParts.join('/');

  const namespaceCheck = validateNamespace(dossierName);
  if (!namespaceCheck.valid) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: { code: 'INVALID_NAMESPACE', message: namespaceCheck.error },
    });
  }

  if (req.method === 'DELETE') {
    return handleDelete(req, res, dossierName, version, requestId);
  }

  return handleGet(res, dossierName, version, isContentRequest, requestId);
}

async function handleGet(
  res: VercelResponse,
  dossierName: string,
  version: string | undefined,
  isContentRequest: boolean,
  requestId: string
) {
  try {
    log.info('Getting manifest', { requestId, dossier: dossierName });
    const manifest = await github.getManifest();
    const dossierEntry = manifest.dossiers.find((d) => d.name === dossierName);

    if (!dossierEntry) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: {
          code: 'DOSSIER_NOT_FOUND',
          message: `Dossier '${dossierName}' not found`,
        },
      });
    }

    if (version && dossierEntry.version !== version) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `Dossier '${dossierName}' version '${version}' not found (latest: ${dossierEntry.version})`,
        },
      });
    }

    if (isContentRequest) {
      log.info('Getting file content', { requestId, path: dossierEntry.path });
      const fileContent = await github.getFileContent(dossierEntry.path);

      if (!fileContent) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          error: {
            code: 'CONTENT_NOT_FOUND',
            message: `Content for dossier '${dossierName}' not found`,
          },
        });
      }

      const digest = sha256Hex(fileContent.content);

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('X-Dossier-Digest', `sha256:${digest}`);
      return res.status(HTTP_STATUS.OK).send(fileContent.content);
    }

    return res.status(HTTP_STATUS.OK).json({
      name: dossierEntry.name,
      title: dossierEntry.title,
      version: dossierEntry.version,
      category: dossierEntry.category,
      content_url: config.getCdnUrl(dossierEntry.path),
    });
  } catch (error) {
    if (error instanceof github.PathTraversalError) {
      return invalidPathError(res, requestId, dossierName);
    }
    return serverError(res, {
      operation: `dossier.get(${dossierName})`,
      error,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to fetch dossier information',
      requestId,
    });
  }
}

async function handleDelete(
  req: VercelRequest,
  res: VercelResponse,
  dossierName: string,
  version: string | undefined,
  requestId: string
) {
  const authorized = await authorizePublish(req, res, dossierName);
  if (!authorized) return;

  try {
    log.info('Deleting dossier', { requestId, dossier: dossierName, version });
    const result = await github.deleteDossier(dossierName, version || null);

    if (!result.found) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: {
          code: 'DOSSIER_NOT_FOUND',
          message: `Dossier '${dossierName}' not found`,
        },
      });
    }

    if (result.versionMismatch) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `Version '${result.requestedVersion}' not found. Current version is '${result.currentVersion}'`,
        },
      });
    }

    log.info('Dossier deleted', { requestId, dossier: dossierName, version });

    const response: Record<string, string> = {
      message: 'Dossier deleted',
      name: dossierName,
    };

    if (version) {
      response.version = version;
    }

    return res.status(HTTP_STATUS.OK).json(response);
  } catch (err) {
    if (err instanceof github.PathTraversalError) {
      return invalidPathError(res, requestId, dossierName);
    }
    return serverError(res, {
      operation: `dossier.delete(${dossierName})`,
      error: err,
      code: 'DELETE_ERROR',
      message: 'Failed to delete dossier. Please try again.',
      requestId,
    });
  }
}
