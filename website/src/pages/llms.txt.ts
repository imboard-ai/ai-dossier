import type { APIRoute } from 'astro';
import { llmsDocs } from '../lib/docs-llms';
import { buildLlmsTxt } from '../lib/seo.mjs';

export const GET: APIRoute = async ({ site }) => {
  const abs = (p: string) => new URL(p, site).href;
  const docs = (await llmsDocs()).map((d) => ({ title: d.title, url: abs(d.path), description: d.description, core: d.core }));
  const body = buildLlmsTxt({
    site: abs('/'),
    core: docs.filter((d) => d.core),
    optional: docs.filter((d) => !d.core),
    registryUrl: abs('/registry/'),
  });
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
