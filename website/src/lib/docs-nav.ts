import { getCollection } from 'astro:content';

const ORDER = [
  'getting-started',
  'tutorials',
  'guides',
  'how-to',
  'reference',
  'explanation',
  'architecture',
  'contributing',
  'reports',
];
const LABELS: Record<string, string> = {
  'getting-started': 'Getting started',
  'how-to': 'How-to',
  reports: 'Reports',
  'agent-traps': 'Agent traps',
};

export function titleOf(id: string, body = ''): string {
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].replace(/[`*_]/g, '').trim();
  return id.split('/').pop() || 'Docs';
}

export async function docsNav() {
  const entries = await getCollection('docs');
  const groups = new Map<string, { id: string; title: string; index: boolean }[]>();
  for (const e of entries) {
    if (e.id === 'index') continue;
    const [top, ...rest] = e.id.split('/');
    const list = groups.get(top) ?? [];
    list.push({ id: e.id, title: titleOf(e.id, e.body), index: rest.length === 0 });
    groups.set(top, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
    .map(([top, items]) => ({
      key: top,
      label: LABELS[top] ?? top.charAt(0).toUpperCase() + top.slice(1),
      items: items.sort((a, b) => Number(b.index) - Number(a.index) || a.title.localeCompare(b.title)),
    }));
}
