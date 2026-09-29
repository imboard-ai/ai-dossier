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

function shape(entry, parsed) {
  const meta = parsed?.meta ?? {};
  return {
    name: entry.name,
    title: entry.title || meta.title || entry.name,
    version: entry.version || meta.version || '',
    description: entry.description || meta.description || '',
    categories: entry.category ?? meta.category ?? [],
    tags: entry.tags ?? meta.tags ?? [],
    authors: (entry.authors ?? meta.authors ?? []).map((a) => a.name).filter(Boolean),
    tools: (entry.tools_required ?? meta.tools_required ?? []).map((t) => t.name).filter(Boolean),
    sourceUrl: entry.url,
    objective: meta.objective ?? '',
    status: meta.status ?? '',
    riskLevel: meta.risk_level ?? 'unknown',
    riskFactors: meta.risk_factors ?? [],
    requiresApproval: meta.requires_approval ?? null,
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
    const dossiers = await mapLimit(list, CONCURRENCY, async (entry) => {
      try {
        return shape(entry, parseDossier(await getText(entry.url)));
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
