/** Which side of a mixed npm + Python root an issue is about, read from the source paths
 * its title and body name (#1276). The text is untrusted: it is only scanned for
 * path-shaped tokens under a strict alphabet. Nothing in it is fetched, followed or run,
 * and no part of it is returned. */
import type { Ecosystem } from './detect';

/** Bounded scan: issue bodies are at most 65,536 characters on GitHub. */
const MAX_TEXT = 128 * 1024;
const MAX_TOKEN = 256;
/** Path characters only. Anything else (spaces, quotes, brackets, backticks, colons,
 * `#`, `?`) separates tokens, so `src/a.py:12` and `` `src/a.py` `` both yield `src/a.py`. */
const TOKEN = /[A-Za-z0-9_./-]+/gu;
const PYTHON_NAMES = new Set(['pyproject.toml', 'uv.lock', 'requirements.txt']);
const PYTHON_EXTENSIONS = /\.pyi?$/u;
const NODE_NAMES = new Set(['package.json', 'package-lock.json']);
const NODE_EXTENSIONS = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/u;
/** A bare file name must look like one: `index.ts`, `test_api.py`. A capitalized word
 * with a suffix (`Node.js`, `Vue.js`) is prose, so it only counts inside a path. */
const BARE_NAME = /^[a-z0-9_][a-z0-9_.-]*$/u;
/** Library and runtime names written like files (`next.js`, `node.js`): prose, not paths. */
const LIBRARY_NAME =
  /^(?:node|next|nuxt|vue|react|angular|ember|backbone|express|nest|chart|three|d3|p5|alpine|solid|svelte|preact|deno|bun|electron|socket|moment|day|anime|pixi|babylon|tensorflow|brain|ml5|video|highlight|marked|pdf|leaflet|mapbox-gl|handlebars|mustache|knockout|meteor|riot|mithril|htmx|lit)\.js$/u;

function side(token: string): Ecosystem | undefined {
  // `scheme://host/...` splits at `:`, leaving `//host/...`: a URL, never a repository path.
  if (token.startsWith('//')) return undefined;
  const trimmed = token.replace(/^[./]+(?=[A-Za-z0-9_])/u, '').replace(/[./-]+$/u, '');
  if (!trimmed || trimmed.length > MAX_TOKEN) return undefined;
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (
    !name ||
    (!trimmed.includes('/') && (!BARE_NAME.test(name) || LIBRARY_NAME.test(name.toLowerCase())))
  )
    return undefined;
  if (PYTHON_NAMES.has(name) || PYTHON_EXTENSIONS.test(name)) return 'python';
  if (NODE_NAMES.has(name) || NODE_EXTENSIONS.test(name)) return 'node';
  return undefined;
}

/** The one ecosystem every source path named in `texts` belongs to, or undefined when
 * the texts name no such path or name paths on both sides. */
export function issueEcosystem(...texts: readonly string[]): Ecosystem | undefined {
  const sides = new Set<Ecosystem>();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.slice(0, MAX_TEXT).matchAll(TOKEN)) {
      const found = side(match[0]);
      if (found) sides.add(found);
      if (sides.size > 1) return undefined;
    }
  }
  return sides.size === 1 ? [...sides][0] : undefined;
}
