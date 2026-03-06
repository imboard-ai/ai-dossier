import { DEFAULT_PER_PAGE, HTTP_STATUS, MAX_PER_PAGE } from '../../lib/constants';
import { handleCors } from '../../lib/cors';
import { fetchManifestDossiers, normalizeDossier } from '../../lib/manifest';
import { methodNotAllowed, serverError } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return methodNotAllowed(req, res, 'GET');
  }

  const q = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
  const pageStr = Array.isArray(req.query.page) ? req.query.page[0] : req.query.page;
  const perPageStr = Array.isArray(req.query.per_page) ? req.query.per_page[0] : req.query.per_page;

  if (!q || !q.trim()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: { code: 'MISSING_QUERY', message: 'Query parameter "q" is required' },
    });
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
    });
  }
}
