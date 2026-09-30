import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import remarkDocsLinks from './src/plugins/remark-docs-links.mjs';

// SITE_URL is the single source for canonical, og:url, sitemap and robots.txt. Deliberately
// not derived from VERCEL_PROJECT_PRODUCTION_URL (a different alias than the public site).
export const DEFAULT_SITE_URL = 'https://ai-dossier-imboard.vercel.app';
const site = process.env.SITE_URL || DEFAULT_SITE_URL;

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    // Internal working notes stay reachable but out of the sitemap.
    sitemap({
      filter: (page) => !/\/docs\/(reports|agent-traps|contributing\/mcp)(\/|$)/.test(page),
    }),
  ],
  markdown: {
    remarkPlugins: [remarkDocsLinks],
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark-default' } },
  },
});
