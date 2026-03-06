# Dossier Registry MVP0: Architecture and Implementation Plan

## 1. Project Goal: Minimum Viable Product (MVP0)

The goal of MVP0 is to create a **Read-Only Public Dossier Registry API**.

This API must serve two primary functions:

- **List**: Allow clients (the CLI) to quickly fetch a complete list of all available dossiers, including their metadata (name, version, title).
- **Pull**: Provide clients with a high-speed, direct link to the content of any specific dossier file.

---

## 2. Key Architectural Decisions

The core architecture uses a **Two-Repository, CDN-First Model** to achieve high read performance and zero infrastructure costs.

### Decision A: Two Separate Repositories

We are separating the application code from the static content.

| Repository | Purpose | Visibility | Hosted On |
|------------|---------|------------|-----------|
| [dossier-registry](https://github.com/imboard-ai/dossier-registry) | Vercel Serverless functions (`api/`) and configuration | Public | Vercel |
| [dossier-content](https://github.com/imboard-ai/dossier-content) | `.ds.md` files and `index.json` manifest | **Public** | GitHub / jsDelivr (CDN) |

**Reasoning:** Separating the content into a public repository enables free CDN delivery via jsDelivr.

### Decision B: Static Manifest for Metadata (No Database)

Instead of using a database (Vercel KV, Redis, etc.), we use a static `index.json` file in the content repo.

- **Flow:** The `GET /dossiers` endpoint fetches `index.json` from jsDelivr CDN
- **Result:** Zero database costs, no sync scripts, simple maintenance

**Update workflow:** When adding/modifying dossiers, update `index.json` in the same commit.

### Decision C: jsDelivr CDN for All Content

Both metadata and dossier content are served via jsDelivr CDN.

- **Metadata:** `https://cdn.jsdelivr.net/gh/imboard-ai/dossier-content/index.json`
- **Content:** `https://cdn.jsdelivr.net/gh/imboard-ai/dossier-content/{path}`

**Note:** We omit the `@branch` tag from URLs for faster cache updates (jsDelivr caches branch tags aggressively for 24h+).

### Decision D: Hierarchical Naming Convention

Dossiers follow an `org/category/name` pattern:

```
imboard-ai/development/setup-react-library
└── org ──┘ └─ category ─┘ └──── name ────┘
```

**Rules:**
- Max depth: 5 levels
- Each segment: lowercase alphanumeric, hyphens, underscores
- Max 256 characters total

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    MVP0 (Read-Only) - COMPLETE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐      ┌──────────────────┐                         │
│  │   CLI   │─────▶│  Vercel API      │                         │
│  │  Tool   │      │  /api/v1/...     │                         │
│  └────┬────┘      └────────┬─────────┘                         │
│       │                    │                                    │
│       │                    │ fetch index.json                   │
│       │                    │ or return content                  │
│       │                    ▼                                    │
│       │           ┌──────────────────┐                         │
│       └──────────▶│  jsDelivr CDN    │                         │
│         (follow   │                  │                         │
│          redirect)│  ├── index.json  │                         │
│                   │  └── **/*.ds.md  │                         │
│                   └────────┬─────────┘                         │
│                            │                                    │
│                            ▼                                    │
│                   ┌──────────────────┐                         │
│                   │  GitHub Repo     │                         │
│                   │  dossier-content │ ◀── manual commits      │
│                   └──────────────────┘     (MVP0)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Technology Stack

| Component | Technology | Role |
|-----------|------------|------|
| Serverless Functions | Vercel / Node.js | Hosting the API endpoints |
| Content & Metadata | GitHub Public Repo | Source of truth for `.ds.md` files and `index.json` |
| Content Delivery | jsDelivr CDN | Global delivery of all content |
| Dependencies | None (MVP0); `@ai-dossier/core`, `jsonwebtoken` added in MVP1 | Auth and shared verification added post-MVP0 |

### Content Repo Structure

```
dossier-content/
├── index.json                              # Manifest of all dossiers
├── getting-started/
│   └── hello.ds.md                         # Tutorial dossier
└── imboard-ai/
    └── development/
        ├── add-git-worktree-support.ds.md
        ├── code-refactoring-abstraction.ds.md
        ├── project-exploration.ds.md
        ├── setup-issue-workflow.ds.md
        ├── setup-react-library.ds.md
        └── test-coverage-gap-analysis.ds.md
```

---

## 5. Implementation Status

### Phase 1: Foundation ✅ Complete

- [x] Created GitHub repositories (Code Repo, Content Repo)
- [x] Initialized local Node.js project
- [x] Installed Vercel CLI and linked local project
- [x] Implemented and verified `api/v1/health.js` locally

### Phase 2: Content Repo Setup ✅ Complete

- [x] Created public content repo on GitHub
- [x] Added sample dossier file (`getting-started/hello.ds.md`)
- [x] Created `index.json` manifest
- [x] Added 6 development dossiers from examples
- [x] Verified files are accessible via jsDelivr CDN

### Phase 3: API Endpoint Implementation ✅ Complete

- [x] Created `lib/config.js` with content repo details
- [x] Implemented `GET /api/v1/dossiers` (List)
- [x] Implemented `GET /api/v1/dossiers/[...name]` (Metadata)
- [x] Implemented `GET /api/v1/dossiers/[...name]/content` (returns content with digest header)
- [x] Added `vercel.json` for route rewrites
- [x] Deployed to production

---

## 6. MVP0 Completion Summary ✅

| Endpoint | Description | Status |
|----------|-------------|--------|
| `GET /api/v1/health` | Health check | ✅ Done |
| `GET /api/v1/dossiers` | List all dossiers (7 total) | ✅ Done |
| `GET /api/v1/dossiers/{name}` | Get dossier metadata | ✅ Done |
| `GET /api/v1/dossiers/{name}/content` | Returns content with `X-Dossier-Digest` header | ✅ Done |

**Production API:** https://dossier-registry.vercel.app

---

## 7. Lessons Learned

### CDN Caching
- jsDelivr caches `@branch` tags aggressively (24h+)
- Solution: Omit branch tag from URLs for faster updates
- Alternative: Use commit hashes for immutable versioning

### Route Handling
- Vercel catch-all routes (`[...name].js`) need rewrites in `vercel.json`
- Query params come as strings when using rewrites, need to split on `/`

---

## 8. MVP1: Publishing with Authentication

MVP1 adds **publishing capabilities** with authentication. See [registry-api-design.md](./registry-api-design.md) for full spec.

### MVP1 Key Decisions Made

1. **Auth approach:** GitHub OAuth + JWT tokens (stateless, no database needed for auth)
2. **Storage for published dossiers:** API commits directly to `dossier-content` repo via GitHub API
3. **Namespace ownership:** Based on GitHub identity - personal namespace (`username/*`) and org namespaces (`org/*`)

### MVP1 Implementation Phases

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Auth Foundation - OAuth, JWT, `/me` endpoint | ✅ Complete |
| Phase 2 | Publish Flow - `POST /dossiers`, validation, GitHub commit | ✅ Complete |
| Phase 3 | User Features - profiles, list user's dossiers | Pending |

See [mvp1-phase1-implementation.md](./mvp1-phase1-implementation.md) for Phase 1 details.
See [auth-and-publish.md](./auth-and-publish.md) for full auth architecture.

### MVP1 Phase 1 Endpoints (Complete)

| Endpoint | Description | Status |
|----------|-------------|--------|
| `GET /auth/login` | Initiate GitHub OAuth (redirects to GitHub) | ✅ Done |
| `GET /auth/callback` | GitHub OAuth callback, returns JWT | ✅ Done |
| `GET /api/v1/me` | Current user info (protected) | ✅ Done |

### MVP1 Phase 2 Endpoints (Complete)

| Endpoint | Description | Status |
|----------|-------------|--------|
| `POST /api/v1/dossiers` | Publish a dossier (protected) | ✅ Done |
| `GET /api/v1/docs` | Self-describing API documentation | ✅ Done |

See [mvp1-phase2-implementation.md](./mvp1-phase2-implementation.md) for Phase 2 details.

---

## 9. Why No Database? (Reference)

| Aspect | With Database | With Static Manifest |
|--------|---------------|----------------------|
| **Complexity** | Higher | Lower |
| **Cost** | Free tier limited | Free forever |
| **Latency** | ~5-10ms | ~20-50ms (CDN) |
| **Update mechanism** | API writes | Git commits |
| **Failure modes** | DB outage, sync drift | CDN outage only |

For MVP0 (read-only), static manifest is sufficient. MVP1 uses stateless JWT auth (no database required).
