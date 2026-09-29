# Website

Static site for AI Dossier: landing page, docs and registry browser, built with
[Astro](https://astro.build). It is a standalone project (its own `package-lock.json`), **not** an
npm workspace, so `make build-all`, the publish pipeline and the version-bump check never see it.

```bash
cd website
npm ci
npm run dev        # http://localhost:4321
npm run build      # -> dist/
npm test           # link-rewriting + registry parsing unit tests
npm run check:links  # after a build: every internal link/anchor in dist/ resolves, and every
                     # GitHub link to a repo file points at a file that exists
```

Needs Node 22.12+.

## Where content comes from

| Page | Source |
|---|---|
| `/docs/**` | The repository's own `../docs/**/*.md`, rendered in place at build time (no copy). `docs/planning/**` and `docs/reports/evidence/**` are skipped. A remark plugin (`src/plugins/remark-docs-links.mjs`) turns relative links between docs into site routes and links to anything else (source files, repo-root files, images) into GitHub URLs. |
| `/registry/**` | The registry API, fetched **at build time** (`src/lib/registry.mjs`): `GET /dossiers`, then each dossier's `.ds.md` header for risk level and signature. The browser never calls the API, so the registry's CORS allowlist needs no change. The registry pages show header values as published; they do not verify signatures. |
| `/case-study/` | Hand-written (`src/pages/case-study.astro`); every figure is sourced on the page. |

Registry freshness equals rebuild cadence. Follow-up (not set up): a Vercel deploy hook triggered by
a daily GitHub Action cron, or on registry publish.

Environment: `REGISTRY_API_URL` (default the production registry), `REGISTRY_OPTIONAL=1` (build with
no registry pages if the API is unreachable; used in PR CI), `SITE_URL` (canonical/sitemap origin;
defaults to Vercel's production URL, else `https://ai-dossier.vercel.app`).

## Vercel settings

| Setting | Value |
|---|---|
| Root Directory | `website` |
| Framework Preset | Astro |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js version | 22.x |
| Include files outside Root Directory | enabled (the default): the build reads `../docs` |

No analytics, cookies or third-party requests.

## Design system

Tokens (colors, type scale, radii) live in `src/styles/global.css`: dark-first, light via `prefers-color-scheme`, one accent. Fonts are self-hosted in `public/fonts/` (Inter and JetBrains Mono variable, latin subset from `@fontsource-variable/*`, SIL OFL, licenses alongside); the site loads nothing from third-party origins.
