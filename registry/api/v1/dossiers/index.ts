import { authenticateRequest } from '../../../lib/auth';
import config from '../../../lib/config';
import { MAX_CONTENT_SIZE } from '../../../lib/constants';
import { handleCors } from '../../../lib/cors';
import * as dossier from '../../../lib/dossier';
import * as github from '../../../lib/github';
import { fetchManifestDossiers, normalizeDossier } from '../../../lib/manifest';
import { canPublishTo } from '../../../lib/permissions';
import type { ManifestDossier, VercelRequest, VercelResponse } from '../../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method === 'GET') {
    return handleList(req, res);
  }

  if (req.method === 'POST') {
    return handlePublish(req, res);
  }

  return res.status(405).json({
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed' },
  });
}

async function handleList(_req: VercelRequest, res: VercelResponse) {
  try {
    const raw = await fetchManifestDossiers();
    const dossiers = raw.map(normalizeDossier);

    return res.status(200).json({
      dossiers,
      pagination: {
        page: 1,
        per_page: dossiers.length,
        total: dossiers.length,
      },
    });
  } catch (error) {
    console.error('Error fetching dossiers:', error);
    return res.status(502).json({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to fetch dossier list',
      },
    });
  }
}

async function handlePublish(req: VercelRequest, res: VercelResponse) {
  const jwtPayload = await authenticateRequest(req, res);
  if (!jwtPayload) return;

  const { namespace, content, changelog } = req.body || {};

  if (!namespace) {
    return res.status(400).json({
      error: { code: 'MISSING_FIELD', message: 'Missing required field: namespace' },
    });
  }

  if (!content) {
    return res.status(400).json({
      error: { code: 'MISSING_FIELD', message: 'Missing required field: content' },
    });
  }

  if (content.length > MAX_CONTENT_SIZE) {
    return res.status(413).json({
      error: {
        code: 'CONTENT_TOO_LARGE',
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024}KB`,
      },
    });
  }

  const namespaceValidation = dossier.validateNamespace(namespace);
  if (!namespaceValidation.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_NAMESPACE', message: namespaceValidation.error },
    });
  }

  const permission = canPublishTo(jwtPayload, namespace);
  if (!permission.allowed) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: permission.reason },
    });
  }

  let parsed: ReturnType<typeof dossier.parseFrontmatter>;
  try {
    parsed = dossier.parseFrontmatter(content);
  } catch (err) {
    return res.status(400).json({
      error: { code: 'INVALID_CONTENT', message: err instanceof Error ? err.message : String(err) },
    });
  }

  const validation = dossier.validateDossier(parsed.frontmatter);
  if (!validation.valid) {
    return res.status(400).json({
      error: { code: 'INVALID_CONTENT', message: validation.errors.join('; ') },
    });
  }

  const fullPath = dossier.buildFullName(namespace, parsed.frontmatter.name as string);
  const changelogMessage = changelog || 'No changelog provided';

  try {
    await github.publishDossier(
      fullPath,
      content,
      parsed.frontmatter as unknown as ManifestDossier,
      changelogMessage
    );

    return res.status(201).json({
      name: fullPath,
      version: parsed.frontmatter.version,
      title: parsed.frontmatter.title,
      content_url: config.getCdnUrl(`${fullPath}.ds.md`),
      published_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error publishing dossier:', err);
    return res.status(502).json({
      error: {
        code: 'PUBLISH_ERROR',
        message: 'Failed to publish dossier',
      },
    });
  }
}
