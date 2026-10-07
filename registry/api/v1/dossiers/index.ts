import type { EvidenceRecord } from '@ai-dossier/core';
import {
  EVIDENCE_MAX_BYTES,
  evidenceMatchesDossier,
  getErrorMessage,
  parseEvidence,
} from '@ai-dossier/core';
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
  invalidPathError,
  jsonError,
  methodNotAllowed,
  serverError,
} from '../../../lib/responses';
import { checkPublishSignature } from '../../../lib/signature';
import type { VercelRequest, VercelResponse } from '../../../lib/types';

const log = createLogger('dossiers/index');

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

    // List returns all dossiers in a single page (no pagination params accepted).
    // Search (api/v1/search.ts) supports page/per_page query params for real pagination.
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

export type PublishInput = {
  namespace: string;
  content: string;
  changelog: string | undefined;
  evidence: string | undefined;
};

export type ValidationSuccess = { ok: true; data: PublishInput };
export type ValidationFailure = { ok: false; status: number; code: string; message: string };
export type ValidationResult = ValidationSuccess | ValidationFailure;

/** Pure validation: returns a discriminated union instead of writing to `res`. */
export function validatePublishInput(req: VercelRequest): ValidationResult {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    return {
      ok: false,
      status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: `Content-Type must be application/json, received: ${contentType || '(none)'}`,
    };
  }

  const { namespace, content, changelog, evidence } = req.body || {};

  if (!namespace || typeof namespace !== 'string') {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'MISSING_FIELD',
      message: 'Missing required field: namespace (must be a string)',
    };
  }

  if (!content || typeof content !== 'string') {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'MISSING_FIELD',
      message: 'Missing required field: content (must be a string)',
    };
  }

  if (changelog !== undefined && typeof changelog !== 'string') {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'INVALID_FIELD',
      message: 'Field changelog must be a string',
    };
  }

  if (typeof changelog === 'string' && changelog.length > MAX_CHANGELOG_LENGTH) {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'CHANGELOG_TOO_LONG',
      message: `Changelog exceeds maximum length of ${MAX_CHANGELOG_LENGTH} characters`,
    };
  }

  if (content.length > MAX_CONTENT_SIZE) {
    return {
      ok: false,
      status: HTTP_STATUS.CONTENT_TOO_LARGE,
      code: 'CONTENT_TOO_LARGE',
      message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024}KB`,
    };
  }

  const namespaceValidation = dossier.validateNamespace(namespace);
  if (!namespaceValidation.valid) {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'INVALID_NAMESPACE',
      message: namespaceValidation.error,
    };
  }

  if (evidence !== undefined && typeof evidence !== 'string') {
    return {
      ok: false,
      status: HTTP_STATUS.BAD_REQUEST,
      code: 'INVALID_FIELD',
      message: 'Field evidence must be a JSON string',
    };
  }

  if (typeof evidence === 'string' && Buffer.byteLength(evidence, 'utf8') > EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      status: HTTP_STATUS.CONTENT_TOO_LARGE,
      code: 'EVIDENCE_TOO_LARGE',
      message: `Evidence exceeds maximum size of ${EVIDENCE_MAX_BYTES / 1024}KB`,
    };
  }

  return { ok: true, data: { namespace, content, changelog, evidence } };
}

async function handlePublish(req: VercelRequest, res: VercelResponse, requestId: string) {
  const result = validatePublishInput(req);
  if (!result.ok) {
    return jsonError(res, result.status, result.code, result.message, requestId);
  }

  const input = result.data;

  const { namespace, content, changelog, evidence } = input;
  let publishedBy: string | null = null;

  try {
    const auth = await authorizePublish(req, res, namespace);
    if (!auth) return;
    // The publisher is the verified JWT subject — never anything from the request body.
    // publishDossier re-applies the same sanitizer at the commit boundary (idempotent).
    publishedBy = dossier.sanitizeActor(auth.sub);
    if (publishedBy !== auth.sub) {
      log.warn('Publisher login sanitized or empty — provenance may be incomplete', {
        requestId,
        namespace,
        user: auth.sub,
        published_by: publishedBy,
      });
    }
    log.info('Publishing dossier', { requestId, namespace, user: auth.sub });

    let parsed: ReturnType<typeof dossier.parseFrontmatter>;
    try {
      parsed = dossier.parseFrontmatter(content);
    } catch (err) {
      return badRequest(res, 'INVALID_CONTENT', getErrorMessage(err), requestId);
    }

    const validation = dossier.validateDossier(parsed.frontmatter);
    if (!validation.valid) {
      return badRequest(res, 'INVALID_CONTENT', validation.errors.join('; '), requestId);
    }

    // A signature the registry can show to be wrong is refused here, before anything is
    // stored: clients would reject it on install anyway, and serving it would make the
    // registry vouch for bytes the signer never covered.
    const signatureCheck = await checkPublishSignature(parsed);
    if (signatureCheck.status === 'invalid') {
      return badRequest(
        res,
        'INVALID_SIGNATURE',
        `Signature verification failed: ${signatureCheck.reason}`,
        requestId
      );
    }

    const fullPath = dossier.buildFullName(namespace, parsed.frontmatter.name as string);

    let evidenceRecord: EvidenceRecord | undefined;
    if (evidence !== undefined) {
      try {
        evidenceRecord = parseEvidence(evidence);
      } catch (err) {
        return badRequest(
          res,
          'INVALID_EVIDENCE',
          `Invalid evidence record: ${getErrorMessage(err)}`,
          requestId
        );
      }

      const mismatches = evidenceMatchesDossier(evidenceRecord, parsed.frontmatter, fullPath);
      if (mismatches.length > 0) {
        return badRequest(
          res,
          'EVIDENCE_MISMATCH',
          `Evidence does not match dossier: ${mismatches.join('; ')}`,
          requestId
        );
      }
    }

    // Strip control characters (except space) to prevent git commit message injection
    const sanitizedChangelog = changelog ? dossier.sanitizeCommitText(changelog) : '';
    if (changelog && sanitizedChangelog !== changelog) {
      log.warn('Stripped control characters from changelog', { requestId, namespace });
    }
    const changelogMessage = sanitizedChangelog || 'No changelog provided';
    const publishedAt = new Date().toISOString();
    await github.publishDossier(fullPath, content, parsed.frontmatter, changelogMessage, {
      evidence: evidence ?? null,
      publishedBy,
      publishedAt,
    });

    log.info('Dossier published', {
      requestId,
      namespace,
      name: fullPath,
      version: parsed.frontmatter.version,
      published_by: publishedBy,
      evidence: evidence !== undefined ? 'attached' : 'none',
    });

    return res.status(HTTP_STATUS.CREATED).json({
      name: fullPath,
      version: parsed.frontmatter.version,
      title: parsed.frontmatter.title,
      content_url: config.getCdnUrl(dossier.dossierFilePath(fullPath)),
      published_at: publishedAt,
      published_by: publishedBy,
      signature:
        signatureCheck.status === 'unsigned'
          ? null
          : { status: signatureCheck.status, covers: signatureCheck.covers },
      ...(evidence !== undefined
        ? { evidence_url: config.getCdnUrl(dossier.evidenceFilePath(fullPath)) }
        : {}),
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
      context: { namespace, published_by: publishedBy },
    });
  }
}
