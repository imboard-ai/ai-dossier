// GET /api/v1/search?q=<query>&page=N&per_page=M - Search dossiers

const config = require('../../lib/config');
const { handleCors } = require('../../lib/cors');

// Default values for optional fields
const DOSSIER_DEFAULTS = {
  description: null,
  category: null,
  tags: [],
  authors: [],
  tools_required: [],
};

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const { q, page: pageStr, per_page: perPageStr } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({
      error: { code: 'MISSING_QUERY', message: 'Query parameter "q" is required' },
    });
  }

  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(perPageStr, 10) || 20));

  try {
    const manifestUrl = config.getManifestUrl();
    const response = await fetch(manifestUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }

    const manifest = await response.json();

    // Case-insensitive substring matching against name, title, description, category, tags
    const query = q.toLowerCase();
    const matched = manifest.dossiers.filter((d) => {
      if (d.name && d.name.toLowerCase().includes(query)) return true;
      if (d.title && d.title.toLowerCase().includes(query)) return true;
      if (d.description && typeof d.description === 'string' && d.description.toLowerCase().includes(query)) return true;
      if (d.category && typeof d.category === 'string' && d.category.toLowerCase().includes(query)) return true;
      if (Array.isArray(d.category) && d.category.some((c) => c.toLowerCase().includes(query))) return true;
      if (Array.isArray(d.tags) && d.tags.some((t) => t.toLowerCase().includes(query))) return true;
      return false;
    });

    // Paginate
    const total = matched.length;
    const start = (page - 1) * perPage;
    const paged = matched.slice(start, start + perPage);

    // Normalize with defaults and add URL
    const dossiers = paged.map((d) => ({
      ...DOSSIER_DEFAULTS,
      ...d,
      url: config.getCdnUrl(d.path),
    }));

    return res.status(200).json({
      dossiers,
      pagination: { page, per_page: perPage, total },
    });
  } catch (error) {
    console.error('Error searching dossiers:', error);
    return res.status(502).json({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to search dossiers',
      },
    });
  }
};
