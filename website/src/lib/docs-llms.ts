import { getCollection } from 'astro:content';
import { titleOf } from './docs-nav';
import { docDescription } from './seo.mjs';

// Groups whose pages are the "core" docs surfaced in llms.txt and concatenated in llms-full.txt.
// Everything else is listed under Optional in llms.txt; internal notes are left out entirely.
const CORE_GROUPS = ['getting-started', 'explanation', 'reference'];
const SKIP = /^(reports|agent-traps|contributing\/mcp|explanation\/infrastructure-lessons)(\/|$)/;

const rank = (id: string) =>
  id === 'index' ? -1 : (CORE_GROUPS.indexOf(id.split('/')[0]) + 1 || CORE_GROUPS.length + 1);

export async function llmsDocs() {
  const entries = (await getCollection('docs'))
    .filter((e) => !SKIP.test(e.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  const rows = entries.map((e) => {
    const title = titleOf(e.id, e.body);
    return {
      id: e.id,
      title,
      path: e.id === 'index' ? '/docs/' : `/docs/${e.id}/`,
      description: docDescription({ data: e.data, body: e.body, title }),
      body: e.body ?? '',
      core: e.id === 'index' || CORE_GROUPS.includes(e.id.split('/')[0]),
    };
  });
  // Pillar page first when present, so it is the most prominent link.
  const pillar = 'explanation/model-driven-orchestration';
  rows.sort((a, b) => Number(b.id === pillar) - Number(a.id === pillar));
  return rows;
}
