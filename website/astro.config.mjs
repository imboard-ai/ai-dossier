import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import remarkDocsLinks from './src/plugins/remark-docs-links.mjs';

// Vercel sets VERCEL_PROJECT_PRODUCTION_URL for every build; SITE_URL overrides it
// (use it once a custom domain exists).
const site =
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'https://ai-dossier.vercel.app');

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
