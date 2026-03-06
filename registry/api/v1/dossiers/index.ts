import { authorizePublish } from '../../../lib/auth';
import config from '../../../lib/config';
import { HTTP_STATUS, MAX_CHANGELOG_LENGTH, MAX_CONTENT_SIZE } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import * as dossier from '../../../lib/dossier';
import * as github from '../../../lib/github';
import createLogger from '../../../lib/logger';
import { fetchManifestDossiers, normalizeDossier } from '../../../lib/manifest';
import {
  badRequest,
  getRequestId,
  invalidNamespaceError,
  invalidPathError,
  jsonError,
  methodNotAllowed,
  serverError,
} from '../../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

const log = createLogger('dossiers/index');

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping dangerous chars
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  if (req.method === 'GET') {
    return handleList(req, res, requestId);
  }

  if (req.method === 'POST') {
    return handlePublish(req, res, requestId);
  }

  return methodNotAllowed(req, res, 'GET', 'POST');
}

async function handleList(_req: VercelRequest, res: VercelResponse, requestId: string) {
  try {
    const raw = await fetchManifestDossiers();
    const dossiers = raw.map(normalizeDossier);

    return res.status(HTTP_STATUS.OK).json({
      dossiers,
      pagination: {
        page: 1,
        per_page: dossiers.length,
        total: dossiers.length,
      },
    });
  } catch (error) {
    return serverError(res, {
      operation: 'dossier.list',
      error,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to fetch dossier list',
      requestId,
    });
  }
}

async function handlePublish(req: VercelRequest, res: VercelResponse, requestId: string) {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    return jsonError(
      res,
      HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_MEDIA_TYPE',
      `Content-Type must be application/json, received: ${contentType || '(none)'}`,
      requestId
    );
  }

  const { namespace, content, changelog } = req.body || {};

  if (!namespace || typeof namespace !== 'string') {
    return badRequest(
      res,
      'MISSING_FIELD',
      'Missing required field: namespace (must be a string)',
      requestId
    );
  }

  if (!content || typeof content !== 'string') {
    return badRequest(
      res,
      'MISSING_FIELD',
      'Missing required field: content (must be a string)',
      requestId
    );
  }

  if (changelog !== undefined && typeof changelog !== 'string') {
    return badRequest(res, 'INVALID_FIELD', 'Field changelog must be a string', requestId);
  }

  if (typeof changelog === 'string' && changelog.length > MAX_CHANGELOG_LENGTH) {
    return badRequest(
      res,
      'CHANGELOG_TOO_LONG',
      `Changelog exceeds maximum length of ${MAX_CHANGELOG_LENGTH} characters`,
      requestId
    );
  }

  if (content.length > MAX_CONTENT_SIZE) {
    return jsonError(
      res,
      HTTP_STATUS.CONTENT_TOO_LARGE,
      'CONTENT_TOO_LARGE',
      `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024}KB`,
      requestId
    );
  }

  const namespaceValidation = dossier.validateNamespace(namespace);
  if (!namespaceValidation.valid) {
    return invalidNamespaceError(res, requestId, namespaceValidation.error);
  }

  try {
    const authorized = await authorizePublish(req, res, namespace);
    if (!authorized) return;

    let parsed: ReturnType<typeof dossier.parseFrontmatter>;
    try {
      parsed = dossier.parseFrontmatter(content);
    } catch (err) {
      return badRequest(
        res,
        'INVALID_CONTENT',
        err instanceof Error ? err.message : String(err),
        requestId
      );
    }

    const validation = dossier.validateDossier(parsed.frontmatter);
    if (!validation.valid) {
      return badRequest(res, 'INVALID_CONTENT', validation.errors.join('; '), requestId);
    }

    const fullPath = dossier.buildFullName(namespace, parsed.frontmatter.name as string);
    // Strip control characters (except space) to prevent git commit message injection
    const sanitizedChangelog = changelog ? changelog.replace(CONTROL_CHARS, '').trim() : '';
    if (changelog && sanitizedChangelog !== changelog) {
      log.warn('Stripped control characters from changelog', { requestId, namespace });
    }
    const changelogMessage = sanitizedChangelog || 'No changelog provided';
    await github.publishDossier(fullPath, content, parsed.frontmatter, changelogMessage);

    log.info('Dossier published', {
      requestId,
      namespace,
      name: fullPath,
      version: parsed.frontmatter.version,
    });

    return res.status(HTTP_STATUS.CREATED).json({
      name: fullPath,
      version: parsed.frontmatter.version,
      title: parsed.frontmatter.title,
      content_url: config.getCdnUrl(`${fullPath}.ds.md`),
      published_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof github.PathTraversalError) {
      return invalidPathError(res, requestId, namespace);
    }
    return serverError(res, {
      operation: 'dossier.publish',
      error: err,
      code: 'PUBLISH_ERROR',
      message: 'Failed to publish dossier',
      requestId,
      context: { namespace },
    });
  }
}
