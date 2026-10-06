import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', site).href}\n# LLM-readable site summary: ${new URL('llms.txt', site).href}\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
