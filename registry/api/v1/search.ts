import { DEFAULT_PER_PAGE, HTTP_STATUS, MAX_PER_PAGE, MAX_QUERY_LENGTH } from '../../lib/constants';
import { handleCors } from '../../lib/cors';
import { fetchManifestDossiers, normalizeDossier } from '../../lib/manifest';
import { queryString } from '../../lib/query';
import { badRequest, getRequestId, methodNotAllowed, serverError } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return methodNotAllowed(req, res, 'GET');
  }

  const requestId = getRequestId(req);
  res.setHeader('X-Request-Id', requestId);

  const q = queryString(req.query.q);
  const pageStr = queryString(req.query.page);
  const perPageStr = queryString(req.query.per_page);

  if (!q || !q.trim()) {
    return badRequest(res, 'MISSING_QUERY', 'Query parameter "q" is required', requestId);
  }

  if (q.length > MAX_QUERY_LENGTH) {
    return badRequest(
      res,
      'QUERY_TOO_LONG',
      `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
      requestId
    );
  }

  const page = Math.max(1, Number.parseInt(pageStr, 10) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Number.parseInt(perPageStr, 10) || DEFAULT_PER_PAGE)
  );

  try {
    const allDossiers = await fetchManifestDossiers();

    const query = q.toLowerCase();
    const matched = allDossiers.filter((d) => {
      if (d.name?.toLowerCase().includes(query)) return true;
      if (d.title?.toLowerCase().includes(query)) return true;
      if (typeof d.description === 'string' && d.description.toLowerCase().includes(query))
        return true;
      if (Array.isArray(d.category) && d.category.some((c) => c.toLowerCase().includes(query)))
        return true;
      if (Array.isArray(d.tags) && d.tags.some((t) => t.toLowerCase().includes(query))) return true;
      return false;
    });

    const total = matched.length;
    const start = (page - 1) * perPage;
    const paged = matched.slice(start, start + perPage);

    const dossiers = paged.map(normalizeDossier);

    return res.status(HTTP_STATUS.OK).json({
      dossiers,
      pagination: { page, per_page: perPage, total },
    });
  } catch (error) {
    return serverError(res, {
      operation: 'dossier.search',
      error,
      code: 'UPSTREAM_ERROR',
      message: 'Failed to search dossiers',
      requestId,
      context: { query: q },
    });
  }
}
