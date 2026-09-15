import type { EvidenceRecord } from '@ai-dossier/core';
import { parseEvidence, sha256Hex } from '@ai-dossier/core';
import { authorizePublish } from '../../../lib/auth';
import config from '../../../lib/config';
import { HTTP_STATUS } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import { evidenceFilePath, validateNamespace } from '../../../lib/dossier';
import * as github from '../../../lib/github';
import createLogger from '../../../lib/logger';
import { queryString } from '../../../lib/query';
import {
  getRequestId,
  invalidNamespaceError,
  invalidPathError,
  methodNotAllowed,
  notFound,
  serverError,
} from '../../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

const log = createLogger('dossiers/[name]');

/** `content` and `evidence` are reserved trailing path segments: a dossier whose own last
 * name segment is one of these cannot be addressed for metadata through this route. */
type Subresource = 'content' | 'evidence' | null;

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

  const tail = pathParts[pathParts.length - 1];
  const subresource: Subresource =
    tail === 'content' ? 'content' : tail === 'evidence' ? 'evidence' : null;
  const dossierName = subresource !== null ? pathParts.slice(0, -1).join('/') : pathParts.join('/');

  const namespaceCheck = validateNamespace(dossierName);
  if (!namespaceCheck.valid) {
    return invalidNamespaceError(res, requestId, namespaceCheck.error);
  }

  if (req.method === 'DELETE') {
    if (subresource === 'evidence') {
      return methodNotAllowed(req, res, 'GET', 'HEAD');
    }
    return handleDelete(req, res, dossierName, version, requestId);
  }

  return handleGet(res, dossierName, version, subresource, requestId);
}

async function handleGet(
  res: VercelResponse,
  dossierName: string,
  version: string | undefined,
  subresource: Subresource,
  requestId: string
) {
  try {
    log.info('Getting manifest', { requestId, dossier: dossierName });
    const manifest = await github.getManifest();
    const dossierEntry = manifest.dossiers.find((d) => d.name === dossierName);

    if (!dossierEntry) {
      return notFound(res, 'DOSSIER_NOT_FOUND', `Dossier '${dossierName}' not found`, requestId);
    }

    if (version && dossierEntry.version !== version) {
      return notFound(
        res,
        'VERSION_NOT_FOUND',
        `Dossier '${dossierName}' version '${version}' not found (latest: ${dossierEntry.version})`,
        requestId
      );
    }

    if (subresource === 'content') {
      log.info('Getting file content', { requestId, path: dossierEntry.path });
      const fileContent = await github.getFileContent(dossierEntry.path);

      if (!fileContent) {
        return notFound(
          res,
          'CONTENT_NOT_FOUND',
          `Content for dossier '${dossierName}' not found`,
          requestId
        );
      }

      const digest = sha256Hex(fileContent.content);

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('X-Dossier-Digest', `sha256:${digest}`);
      return res.status(HTTP_STATUS.OK).send(fileContent.content);
    }

    if (subresource === 'evidence') {
      const sidecarPath = evidenceFilePath(dossierName);
      log.info('Getting evidence sidecar', { requestId, path: sidecarPath });
      const sidecarContent = await github.getFileContent(sidecarPath);

      if (!sidecarContent) {
        return notFound(
          res,
          'EVIDENCE_NOT_FOUND',
          `No evidence for dossier '${dossierName}'`,
          requestId
        );
      }

      let record: EvidenceRecord;
      try {
        record = parseEvidence(sidecarContent.content);
      } catch (err) {
        return serverError(res, {
          operation: `dossier.evidence(${dossierName})`,
          error: err,
          code: 'EVIDENCE_CORRUPT',
          message: 'Stored evidence record is corrupt',
          status: HTTP_STATUS.BAD_GATEWAY,
          requestId,
          context: { dossier: dossierName, path: sidecarPath },
        });
      }

      // Defense in depth: publish already binds the sidecar to this exact dossier/version, but
      // a partial-write race (content written, sidecar step failed before the manifest update —
      // see publishDossier) can leave a sidecar the manifest no longer agrees with. Never vouch
      // for a checksum on the wrong record.
      if (record.dossier !== dossierName || record.version !== dossierEntry.version) {
        return serverError(res, {
          operation: `dossier.evidence(${dossierName})`,
          error: new Error(
            `stored evidence binds ${record.dossier}@${record.version}, expected ${dossierName}@${dossierEntry.version}`
          ),
          code: 'EVIDENCE_CORRUPT',
          message: 'Stored evidence record is corrupt',
          status: HTTP_STATUS.BAD_GATEWAY,
          requestId,
          context: { dossier: dossierName, path: sidecarPath },
        });
      }

      // X-Evidence-Checksum is the dossier BODY checksum this record is keyed to — not a
      // digest of the JSON bytes below (contrast X-Dossier-Digest on the /content branch).
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Evidence-Checksum', `sha256:${record.checksum.hash}`);
      return res.status(HTTP_STATUS.OK).send(sidecarContent.content);
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
      context: { dossier: dossierName, subresource },
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
  try {
    const authorized = await authorizePublish(req, res, dossierName, 'delete');
    if (!authorized) return;

    log.info('Deleting dossier', { requestId, dossier: dossierName, version });
    const result = await github.deleteDossier(dossierName, version || null);

    if (!result.found) {
      return notFound(res, 'DOSSIER_NOT_FOUND', `Dossier '${dossierName}' not found`, requestId);
    }

    if (result.versionMismatch) {
      return notFound(
        res,
        'VERSION_NOT_FOUND',
        `Version '${result.requestedVersion}' not found. Current version is '${result.currentVersion}'`,
        requestId
      );
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
      context: { dossier: dossierName, version },
    });
  }
}
