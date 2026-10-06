// Pure SEO helpers (meta descriptions, JSON-LD builders, llms.txt text). Free of Astro imports so
// they can be unit tested with `node --test`.

export const SITE_NAME = 'AI Dossier';
export const REPO_URL = 'https://github.com/imboard-ai/ai-dossier';
export const NPM_URL = 'https://www.npmjs.com/package/@ai-dossier/cli';
export const VSCODE_URL =
  'https://marketplace.visualstudio.com/items?itemName=imboard-ai.ai-dossier-vscode';
export const OG_IMAGE_PATH = '/og-image.png';
export const OG_IMAGE_ALT =
  'AI Dossier: signed, versioned agent skills for model-driven orchestration';

// Canonical copy from epic #1030. Do not reword per surface.
export const CATEGORY_LINE = 'Signed, versioned agent skills for model-driven orchestration';
export const EXPLAINER =
  "In *model-driven orchestration* the model decides the steps, the tool calls, the retries and when the work is done. A hand-coded DAG doesn't. Dossier makes that safe to share and repeat. Every skill is signed and version-pinned. Multi-step runs sit inside a deterministic scheduler that never calls an LLM.";

export const SHORT_DESCRIPTION =
  'An open standard for signed, versioned agent skills. Model-driven orchestration with a deterministic shell — host anywhere, verify who wrote it. CLI, registry, MCP, VS Code.';

const MAX_DESCRIPTION = 155;

/** Strip inline markdown down to plain text. */
function plain(text) {
  // Code spans are unwrapped first and parked behind placeholders so an identifier such as
  // GITHUB_ISSUES_PROPOSAL.md survives the emphasis pass.
  const code = [];
  const out = text
    .replace(/`+([^`]+)`+/g, (_, c) => `\uE000${code.push(c) - 1}\uE000`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    // Paired emphasis only: a lone `_` or `*` inside a word is content, not markup.
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\uE000(\d+)\uE000/g, (_, i) => code[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

/** Trim to `max` chars on a word boundary, adding an ellipsis when cut. */
export function trimTo(text, max = MAX_DESCRIPTION) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// Metadata lines ("Version: 1.0 Status: Stable ...") are not summary material; a leading
// "Purpose:" style label is dropped and the sentence after it kept.
const META = /^(version|status|last updated|date|audience|time|prerequisites|difficulty)\s*:/i;
function clean(raw) {
  const text = plain(raw);
  if (META.test(text)) return '';
  return text.replace(/^(purpose|goal|summary|overview)\s*:\s*/i, '');
}

// A paragraph that ends with ":" only introduces the list or code block after it.
const isSummary = (text) => text.length >= 40 && !text.endsWith(':');

/** First prose paragraph of a markdown body (skips headings, lists, tables, code, quotes). */
export function firstParagraph(body = '') {
  const lines = body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/\r/g, '')
    .split('\n');
  let inFence = false;
  let para = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      para = [];
      continue;
    }
    if (inFence) continue;
    const t = line.trim();
    if (t === '') {
      const text = clean(para.join(' '));
      if (isSummary(text)) return text;
      para = [];
      continue;
    }
    // Structural lines end any paragraph in progress and are never summary material.
    if (/^(#|>|\||[-*+]\s|\d+[.)]\s|<|!\[|---|===)/.test(t)) {
      para = [];
      continue;
    }
    para.push(t);
  }
  const text = clean(para.join(' '));
  return isSummary(text) ? text : '';
}

/** Meta description for a docs page: frontmatter `description`, else the first paragraph, else the title. */
export function docDescription({ data = {}, body = '', title = '' }) {
  const fm = typeof data.description === 'string' ? plain(data.description) : '';
  if (fm) return trimTo(fm);
  const para = firstParagraph(body);
  if (para) return trimTo(para);
  return `${title}: AI Dossier documentation.`;
}

export function organizationSchema(site) {
  return {
    '@type': 'Organization',
    '@id': `${site}#organization`,
    name: SITE_NAME,
    url: site,
    logo: `${site}brand/ai-dossier-mark-512.png`,
    sameAs: [REPO_URL, NPM_URL, VSCODE_URL],
  };
}

export function websiteSchema(site) {
  return {
    '@type': 'WebSite',
    '@id': `${site}#website`,
    name: SITE_NAME,
    url: site,
    description: CATEGORY_LINE,
    publisher: { '@id': `${site}#organization` },
  };
}

const ORG_REF = (site) => ({ '@id': `${site}#organization` });

export function softwareApplicationSchema(site, description = SHORT_DESCRIPTION) {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${site}#software`,
    name: SITE_NAME,
    description,
    url: site,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Cross-platform',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: NPM_URL,
    author: ORG_REF(site),
    publisher: ORG_REF(site),
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    sameAs: [REPO_URL, NPM_URL, VSCODE_URL],
  };
}

export function techArticleSchema({ url, headline, description, site, dateModified }) {
  return {
    '@type': 'TechArticle',
    headline: trimTo(headline, 110),
    description,
    url,
    mainEntityOfPage: url,
    ...(dateModified ? { dateModified } : {}),
    image: new URL(OG_IMAGE_PATH, site).href,
    isPartOf: { '@id': `${site}#website` },
    author: ORG_REF(site),
    publisher: ORG_REF(site),
    inLanguage: 'en',
  };
}

/** Wrap schema nodes in one JSON-LD document. `<` is escaped so a value can never close the script tag. */
export function jsonLd(nodes) {
  const graph = { '@context': 'https://schema.org', '@graph': nodes };
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

const oneLine = (t) => t.replace(/\s+/g, ' ').trim();

/**
 * llmstxt.org document. `core` and `optional` are `{ title, url, description }[]` (absolute urls).
 */
export function buildLlmsTxt({ site, core, optional, registryUrl }) {
  const item = (d) =>
    `- [${d.title}](${d.url})${d.description ? `: ${oneLine(d.description)}` : ''}`;
  const out = [
    `# ${SITE_NAME}`,
    '',
    `> ${EXPLAINER}`,
    '',
    `${CATEGORY_LINE}. Open source (AGPL-3.0). CLI, registry, MCP server and VS Code extension.`,
    '',
    '## Docs',
    '',
    ...core.map(item),
    '',
    '## Registry',
    '',
    `- [Dossier registry](${registryUrl}): browse and install published, signed dossiers`,
    '',
    '## Install',
    '',
    `- [CLI on npm](${NPM_URL}): \`npm i -g @ai-dossier/cli\``,
    `- [VS Code extension](${VSCODE_URL}): verify and run dossiers in the editor`,
    `- [Source on GitHub](${REPO_URL}): issues, releases and the protocol spec`,
    `- [Full documentation text](${new URL('llms-full.txt', site).href}): the core docs concatenated in one file`,
  ];
  if (optional.length) out.push('', '## Optional', '', ...optional.map(item));
  return `${out.join('\n')}\n`;
}
