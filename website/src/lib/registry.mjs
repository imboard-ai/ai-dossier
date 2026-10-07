// Build-time registry snapshot. The registry API has a CORS allowlist that does not
// include this site's origin, so the browser never calls it: every page is generated
// from data fetched here, once per build. Freshness = rebuild cadence.
import { load as loadYaml } from 'js-yaml';

const API = process.env.REGISTRY_API_URL || 'https://dossier-registry.vercel.app/api/v1';
const CONCURRENCY = 8;
const RETRIES = 2;

// Minimal port of @ai-dossier/core's parseDossierContent + fromSpecFrontmatter
// (packages/core/src/parser.ts, spec-shape.ts). The site is not an npm workspace and
// the published core lags main, so it cannot depend on it; the fixtures under
// __fixtures__/registry pin both implementations to the same logical objects
// (this package's registry.test.mjs and scripts/website-registry-parity.test.mjs).
const SPEC_TOP_LEVEL = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
]);
const PREFIX = 'dossier.';

const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));

const isSpecShaped = (fm) =>
  isPlainObject(fm) &&
  isPlainObject(fm.metadata) &&
  Object.keys(fm.metadata).some((k) => k.startsWith(PREFIX));

const hasYamlMergeKey = (yaml) => /^[ \t]*(?:-[ \t]+)?<<[ \t]*:|[{,][ \t]*<<[ \t]*:/m.test(yaml);

const decodeSpecValue = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Spec shape -> flat logical frontmatter; throws on anything core's strict reader refuses. */
function fromSpecFrontmatter(spec) {
  const logical = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'metadata') continue;
    if (!SPEC_TOP_LEVEL.has(key)) throw new Error(`unexpected top-level field "${key}"`);
    if (typeof value !== 'string') throw new Error(`top-level "${key}" must be a string`);
    logical[key] = value;
  }
  for (const [key, value] of Object.entries(spec.metadata)) {
    if (typeof value !== 'string') throw new Error(`metadata "${key}" must be a string`);
    if (!key.startsWith(PREFIX)) continue;
    const field = key.slice(PREFIX.length);
    if (!field || field === '__proto__') throw new Error(`metadata "${key}" is not a valid field`);
    if (SPEC_TOP_LEVEL.has(field))
      throw new Error(`metadata "${key}" duplicates a top-level field`);
    if (Object.hasOwn(logical, field)) throw new Error(`field "${field}" appears more than once`);
    logical[field] = decodeSpecValue(value);
  }
  if (isSpecShaped(logical)) throw new Error(`metadata "${PREFIX}metadata" carries dossier.* keys`);
  return logical;
}

/**
 * Split a `.ds.md` into its logical frontmatter and markdown body. Reads the legacy
 * `---dossier` JSON header and the spec-shaped (Agent Skills) `---` YAML header alike;
 * `meta` is always the flat logical view, so `meta.checksum`/`meta.signature` are found
 * in both. Returns null for anything core would refuse to parse.
 */
export function parseDossier(text) {
  // Same openings core accepts: `---dossier`/`---json` (any trailing text), `---`, `---yaml`.
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const opening = text.slice(0, nl).trimEnd();
  const jsonFence = text.startsWith('---dossier') || text.startsWith('---json');
  if (!jsonFence && opening !== '---' && opening !== '---yaml') return null;
  const rest = text.slice(nl + 1);
  const close = rest.match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!close) return null;
  const yaml = rest.slice(0, close.index);
  try {
    const raw = yaml.trim() ? loadYaml(yaml) : {};
    if (!isPlainObject(raw)) return null;
    const shape = isSpecShaped(raw) ? 'spec' : 'legacy';
    if (shape === 'spec' && hasYamlMergeKey(yaml)) return null;
    const meta = shape === 'spec' ? fromSpecFrontmatter(raw) : raw;
    return { meta, body: rest.slice(close.index + close[0].length), shape };
  } catch {
    return null;
  }
}

// Signature schemes by `covers` (core's SIGNATURE_COVERAGES); absent means v1.
const SIGNATURE_SCHEMES = {
  body: 'v1',
  'frontmatter+body': 'v2',
  'spec-frontmatter+body': 'v3',
};
const signatureScheme = (covers) =>
  typeof covers === 'string' && Object.hasOwn(SIGNATURE_SCHEMES, covers)
    ? SIGNATURE_SCHEMES[covers]
    : 'unrecognized';
const coversLabel = (covers) =>
  covers === undefined ? 'body' : typeof covers === 'string' ? covers : JSON.stringify(covers);

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

export function shape(entry, parsed) {
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
          covers: coversLabel(meta.signature.covers),
          scheme: signatureScheme(meta.signature.covers ?? 'body'),
        }
      : null,
    headerShape: parsed?.shape ?? '',
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
