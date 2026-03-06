# Dossier Registry

Serverless API for discovering, publishing, and managing dossiers. Deployed on Vercel.

## Part of the Monorepo

This package (`@ai-dossier/registry`) is an npm workspace within the [ai-dossier](https://github.com/imboard-ai/ai-dossier) monorepo. It depends on `@ai-dossier/core` for shared verification logic.

## Tech Stack

- **Runtime**: Vercel serverless functions (TypeScript)
- **Content storage**: GitHub repo ([dossier-content](https://github.com/imboard-ai/dossier-content)) served via jsDelivr CDN
- **Auth**: GitHub OAuth + JWT
- **Dependencies**: `@ai-dossier/core`, `jsonwebtoken`

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/health` | No | Health check |
| GET | `/api/v1/docs` | No | Self-describing API documentation |
| GET | `/api/v1/dossiers` | No | List all dossiers |
| GET | `/api/v1/dossiers/{name}` | No | Get dossier metadata |
| GET | `/api/v1/dossiers/{name}/content` | No | Get raw dossier content |
| GET | `/api/v1/search?q=...` | No | Search dossiers |
| POST | `/api/v1/dossiers` | Yes | Publish a dossier |
| DELETE | `/api/v1/dossiers/{name}` | Yes | Delete a dossier |
| GET | `/api/v1/me` | Yes | Current user info |
| GET | `/auth/login` | No | Start GitHub OAuth flow |
| GET | `/auth/callback` | No | GitHub OAuth callback (returns JWT) |

**Production**: https://dossier-registry.vercel.app

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Run tests
npm run test -w registry

# Type-check
npm run typecheck -w registry
```

## Project Structure

```
registry/
├── api/              # Vercel serverless function handlers
│   ├── auth/         # OAuth login + callback
│   └── v1/           # Versioned API endpoints
├── lib/              # Shared utilities (auth, config, CORS, GitHub client)
├── scripts/          # Helper scripts (auth, publish, delete)
├── tests/            # Vitest test files
├── docs/             # Planning and design documents
├── package.json
├── vercel.json       # Vercel routing config
└── tsconfig.json
```

## CORS & Security

The registry enforces origin-based CORS with CSRF protection:

- **Allowed origins**: `https://dossier.imboard.ai`, `https://registry.dossier.dev` (default). Override with the `CORS_ALLOWED_ORIGINS` environment variable (comma-separated list).
- **Read-only requests** (`GET`, `HEAD`): allowed from any origin.
- **Mutating requests** (`POST`, `PUT`, `PATCH`, `DELETE`): blocked with `403 ORIGIN_NOT_ALLOWED` if the browser origin is not on the allowlist.
- **Non-browser clients** (no `Origin` header): always allowed through.

See [`lib/cors.ts`](lib/cors.ts) for the implementation and the [API design doc](docs/planning/registry-api-design.md#cors-configuration) for the full specification.

## Design Docs

- [MVP0 Implementation](docs/planning/mvp0-implementation.md) — read-only registry architecture
- [Registry API Design](docs/planning/registry-api-design.md) — full API specification
- [Auth & Publish](docs/planning/auth-and-publish.md) — authentication architecture
