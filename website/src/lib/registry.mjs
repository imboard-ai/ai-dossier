// Build-time registry snapshot. The registry API has a CORS allowlist that does not
// include this site's origin, so the browser never calls it: every page is generated
// from data fetched here, once per build. Freshness = rebuild cadence.
const API = process.env.REGISTRY_API_URL || 'https://dossier-registry.vercel.app/api/v1';
const CONCURRENCY = 8;
const RETRIES = 2;

/** Split a `.ds.md` into its `---dossier` JSON header and markdown body. */
export function parseDossier(text) {
  const m = text.match(/^---dossier\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!m) return null;
  try {
    return { meta: JSON.parse(m[1]), body: text.slice(m[0].length) };
  } catch {
    return null;
  }
}

async function getText(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`GET ${url} failed: ${lastErr?.message ?? lastErr}`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' ? x : '');
const names = (x) =>
  arr(x)
    .map((o) => str(o?.name))
    .filter(Boolean);
const httpsOnly = (u) => {
  try {
    return new URL(u).protocol === 'https:' ? u : '';
  } catch {
    return '';
  }
};
// Names become output paths: keep them to a conservative alphabet, no traversal.
export const validName = (n) =>
  /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(n) &&
  !n.split('/').some((s) => s === '..' || s === '.');

function shape(entry, parsed) {
  const meta = parsed?.meta ?? {};
  return {
    name: entry.name,
    title: str(entry.title) || str(meta.title) || entry.name,
    version: str(entry.version) || str(meta.version),
    description: str(entry.description) || str(meta.description),
    categories: arr(entry.category ?? meta.category)
      .map(str)
      .filter(Boolean),
    tags: arr(entry.tags ?? meta.tags)
      .map(str)
      .filter(Boolean),
    authors: names(entry.authors ?? meta.authors),
    tools: names(entry.tools_required ?? meta.tools_required),
    sourceUrl: httpsOnly(entry.url),
    objective: str(meta.objective),
    status: str(meta.status),
    riskLevel: str(meta.risk_level) || 'unknown',
    riskFactors: arr(meta.risk_factors).map(str),
    requiresApproval: typeof meta.requires_approval === 'boolean' ? meta.requires_approval : null,
    checksum: meta.checksum?.hash ? `${meta.checksum.algorithm}:${meta.checksum.hash}` : '',
    signature: meta.signature
      ? {
          algorithm: meta.signature.algorithm,
          keyId: meta.signature.key_id ?? '',
          signedBy: meta.signature.signed_by ?? '',
          signedAt: meta.signature.signed_at ?? '',
          publicKey: meta.signature.public_key ?? '',
          covers: meta.signature.covers ?? '',
        }
      : null,
    detailLoaded: Boolean(parsed),
  };
}

let cache;

export async function loadRegistry() {
  cache ??= (async () => {
    const started = Date.now();
    let list;
    try {
      list = JSON.parse(await getText(`${API}/dossiers`)).dossiers;
      if (!Array.isArray(list)) throw new Error('unexpected /dossiers response shape');
    } catch (err) {
      if (process.env.REGISTRY_OPTIONAL === '1') {
        console.warn(`[registry] ${err.message} - REGISTRY_OPTIONAL=1, building with no entries`);
        return { fetchedAt: new Date().toISOString(), dossiers: [], api: API };
      }
      throw err;
    }
    const valid = list.filter((e) => {
      const ok = typeof e?.name === 'string' && validName(e.name);
      if (!ok)
        console.warn(`[registry] skipping entry with unusable name: ${JSON.stringify(e?.name)}`);
      return ok;
    });
    const dossiers = await mapLimit(valid, CONCURRENCY, async (entry) => {
      const url = httpsOnly(entry.url);
      try {
        if (!url) throw new Error('no https url');
        return shape(entry, parseDossier(await getText(url)));
      } catch (err) {
        console.warn(`[registry] no header for ${entry.name}: ${err.message}`);
        return shape(entry, null);
      }
    });
    dossiers.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[registry] ${dossiers.length} dossiers in ${Date.now() - started}ms from ${API}`);
    return { fetchedAt: new Date().toISOString(), dossiers, api: API };
  })();
  return cache;
}
