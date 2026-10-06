import type { APIRoute } from 'astro';
import { llmsDocs } from '../lib/docs-llms';
import { CATEGORY_LINE, EXPLAINER, SITE_NAME } from '../lib/seo.mjs';

export const GET: APIRoute = async ({ site }) => {
  const core = (await llmsDocs()).filter((d) => d.core);
  const sections = core.map(
    (d) => `<doc url="${new URL(d.path, site).href}">\n${d.body.trim()}\n</doc>`
  );
  const body = `# ${SITE_NAME}\n\n> ${EXPLAINER}\n\n${CATEGORY_LINE}. Core documentation follows, one <doc> block per page.\n\n${sections.join('\n\n')}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
