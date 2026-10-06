import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { docsPageLastmod } from './src/lib/lastmod.mjs';
import remarkDocsLinks from './src/plugins/remark-docs-links.mjs';
import remarkMermaid from './src/plugins/remark-mermaid.mjs';

// SITE_URL is the single source for canonical, og:url, sitemap and robots.txt. Deliberately
// not derived from VERCEL_PROJECT_PRODUCTION_URL (a different alias than the public site).
export const DEFAULT_SITE_URL = 'https://ai-dossier.dev';
const site = process.env.SITE_URL || DEFAULT_SITE_URL;

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  // Alias: /brand is where people look for logos; the page lives at /logo-showcase.
  redirects: { '/brand': '/logo-showcase/' },
  integrations: [
    // Internal working notes stay reachable but out of the sitemap.
    sitemap({
      filter: (page) => !/\/docs\/(reports|agent-traps|contributing\/mcp)(\/|$)/.test(page),
      // lastmod from the git history of the markdown behind each docs page; other pages omit it
      // rather than claim every deploy changed them.
      serialize(item) {
        const lastmod = docsPageLastmod(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkDocsLinks, remarkMermaid],
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark-default' } },
  },
});
