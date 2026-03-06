# Dossier Registry API Design

## Overview

Design a registry API for dossiers (similar to npm/Docker registries) supporting:
- **Push/publish** dossiers to the registry
- **Pull/download** dossiers from the registry
- **Search/discover** dossiers by various criteria

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Naming | Hierarchical (`org/project/name`) | Flexible depth, familiar to Docker/GitHub users |
| Auth | OAuth (GitHub, Google) + API keys | Social login for users, API keys for CI/CD |
| Storage | Both hosted + external refs | Maximum flexibility |
| Visibility | Public + Private | Like npm/Docker |
| Hosting | Self-hosted + SaaS | Single API spec, multiple deployments |

---

## Phase Overview

| Phase | Focus | Key Capabilities |
|-------|-------|-----------------|
| **MVP0** | Read-only public access | List, browse, download public dossiers |
| **MVP1** | Publishing | Add auth + publish workflow |
| **Prod0** | Production-ready | Search, orgs, versioning, signatures |
| **Prod1** | Scale & Enterprise | Private dossiers, teams, webhooks |

---

## Authentication Overview

**Auth Legend:**
- 🌐 **Public** - No authentication required
- 🔑 **Auth Required** - Bearer token or API key required
- 🔐 **Owner/Admin** - Must own resource or have admin role

Most consumer operations (browsing, searching, downloading public dossiers) require **no authentication**.

### Quick Reference: Public vs Authenticated

| Public (🌐) | Authenticated (🔑/🔐) |
|------------|----------------------|
| **List all dossiers** | Publish dossiers |
| Search dossiers | Manage versions/tags |
| Browse categories/tags | Delete dossiers |
| Download public dossiers | Access private dossiers |
| View dossier metadata | Manage org members |
| View org/user profiles | Register signing keys |
| List trusted keys | Manage API keys |
| Verify signatures | Update own profile |
| Health check / API info | |

---

## API Specification

### Base URL
```
/api/v1/
```

---

# MVP0: Read-Only Public Access

**Goal:** Users can browse and download public dossiers without authentication.

## MVP0 Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | 🌐 | API info & discovery |
| `GET` | `/health` | 🌐 | Health check |
| `GET` | `/dossiers` | 🌐 | List all dossiers |
| `GET` | `/dossiers/{name}` | 🌐 | Get dossier metadata |
| `GET` | `/dossiers/{name}/content` | 🌐 | Download .ds.md file |
| `GET` | `/dossiers/{name}/versions` | 🌐 | List all versions |
| `GET` | `/categories` | 🌐 | List categories |

### MVP0 CLI Commands
```bash
dossier list                      # List all dossiers
dossier list --category devops    # Filter by category
dossier info myorg/deploy         # Show metadata
dossier pull myorg/deploy         # Download dossier
dossier pull myorg/deploy@1.0.0   # Download specific version
```

### MVP0 Response Examples

**`GET /dossiers`**
```json
{
  "dossiers": [
    {
      "name": "imboard-ai/devops/deploy-to-aws",
      "title": "Deploy to AWS",
      "version": "1.2.0",
      "category": ["devops"],
      "updated_at": "2025-12-01T00:00:00Z"
    }
  ],
  "pagination": { "page": 1, "per_page": 20, "total": 156 }
}
```

**`GET /dossiers/{name}/content`**
```
Content-Type: text/markdown; charset=utf-8
X-Dossier-Digest: sha256:abc123...

---dossier
{ "title": "Deploy to AWS", ... }
---
# Deploy to AWS
...
```

---

# MVP1: Publishing

**Goal:** Authenticated users can publish dossiers to the registry.

## MVP1 New Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/auth/login` | 🌐 | Initiate GitHub OAuth |
| `GET` | `/auth/callback` | 🌐 | OAuth callback |
| `POST` | `/auth/token` | 🌐 | Exchange code for token |
| `POST` | `/auth/revoke` | 🔑 | Revoke token |
| `GET` | `/me` | 🔑 | Get current user |
| `POST` | `/dossiers/{name}` | 🔑 | **Publish dossier** |
| `GET` | `/users/{username}` | 🌐 | View user profile |
| `GET` | `/users/{username}/dossiers` | 🌐 | List user's dossiers |

### MVP1 CLI Commands
```bash
dossier login                     # OAuth via browser
dossier whoami                    # Show current user
dossier publish ./deploy.ds.md    # Publish dossier
dossier publish --name myorg/deploy ./deploy.ds.md
```

### MVP1 Publish Request
```http
POST /dossiers/myorg/deploy
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <deploy.ds.md>
changelog: "Added blue-green deployment"
```

---

# Prod0: Production-Ready

**Goal:** Full-featured public registry with search, organizations, and verification.

## Prod0 New Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/search` | 🌐 | Full-text search |
| `GET` | `/categories/{category}` | 🌐 | Dossiers by category |
| `GET` | `/tags/popular` | 🌐 | Popular tags |
| `GET` | `/dossiers/{name}/versions/{version}` | 🌐 | Version details |
| `PUT` | `/dossiers/{name}/tags/{tag}` | 🔐 | Update version tag |
| `POST` | `/dossiers/{name}/deprecate` | 🔐 | Deprecate version |
| `GET` | `/orgs/{org}` | 🌐 | Org details |
| `POST` | `/orgs` | 🔑 | Create organization |
| `GET` | `/keys` | 🌐 | List trusted keys |
| `POST` | `/keys` | 🔑 | Register signing key |
| `POST` | `/verify` | 🌐 | Verify signature |
| `GET` | `/auth/keys` | 🔑 | List API keys |
| `POST` | `/auth/keys` | 🔑 | Create API key |
| `DELETE` | `/auth/keys/{id}` | 🔑 | Delete API key |

### Prod0 CLI Commands
```bash
dossier search "aws deploy"       # Full-text search
dossier search --signed --risk low
dossier verify myorg/deploy       # Verify signature
dossier keys add <public-key>     # Trust a signing key
dossier tag myorg/deploy stable   # Tag version as stable
dossier deprecate myorg/deploy@1.0.0 --reason "Security fix in 1.0.1"
```

### Prod0 Search Response
```json
{
  "results": [...],
  "facets": {
    "category": [{"value": "devops", "count": 156}],
    "risk_level": [{"value": "low", "count": 234}],
    "signed": [{"value": "official", "count": 42}]
  },
  "pagination": { "page": 1, "total": 156 }
}
```

---

# Prod1: Scale & Enterprise

**Goal:** Private dossiers, team permissions, webhooks, advanced features.

## Prod1 New Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/auth/google` | 🌐 | Google OAuth |
| `GET` | `/dossiers/{name}/visibility` | 🔐 | Get visibility |
| `PUT` | `/dossiers/{name}/visibility` | 🔐 | Set public/private |
| `GET` | `/dossiers/{name}/permissions` | 🔐 | List permissions |
| `PUT` | `/dossiers/{name}/permissions` | 🔐 | Update permissions |
| `DELETE` | `/dossiers/{name}/versions/{version}` | 🔐 | Delete version |
| `GET` | `/orgs/{org}/members` | 🌐 | List org members |
| `PUT` | `/orgs/{org}/members/{user}` | 🔐 | Add/update member |
| `DELETE` | `/orgs/{org}/members/{user}` | 🔐 | Remove member |
| `DELETE` | `/keys/{key_id}` | 🔐 | Revoke signing key |
| `PUT` | `/me` | 🔑 | Update profile |
| `GET` | `/webhooks` | 🔑 | List webhooks |
| `POST` | `/webhooks` | 🔑 | Create webhook |

### Prod1 Features
- **Private dossiers**: Visible only to authorized users/teams
- **Team permissions**: `owner`, `maintainer`, `publisher`, `reader` roles
- **Webhooks**: `dossier.published`, `dossier.deprecated`, etc.
- **Audit logs**: Track who published/modified dossiers
- **Rate limiting tiers**: Free, Pro, Enterprise

---

# Phase Summary

| Endpoint | MVP0 | MVP1 | Prod0 | Prod1 |
|----------|:----:|:----:|:-----:|:-----:|
| `GET /dossiers` | ✅ | ✅ | ✅ | ✅ |
| `GET /dossiers/{name}` | ✅ | ✅ | ✅ | ✅ |
| `GET /dossiers/{name}/content` | ✅ | ✅ | ✅ | ✅ |
| `GET /categories` | ✅ | ✅ | ✅ | ✅ |
| `GET /health` | ✅ | ✅ | ✅ | ✅ |
| Auth (GitHub OAuth) | | ✅ | ✅ | ✅ |
| `POST /dossiers/{name}` (publish) | | ✅ | ✅ | ✅ |
| `GET /search` | | | ✅ | ✅ |
| `POST /verify` | | | ✅ | ✅ |
| Organizations | | | ✅ | ✅ |
| API keys | | | ✅ | ✅ |
| Private dossiers | | | | ✅ |
| Team permissions | | | | ✅ |
| Webhooks | | | | ✅ |

---

# Appendix: Detailed Reference

## Naming Rules

**Path segments:**
- Lowercase alphanumeric, hyphens, underscores
- Each segment: 1-64 characters
- Total path: max 256 characters
- Max depth: 5 levels
- Reserved: `api`, `auth`, `search`, `admin`, `_`

**Versioning:**
- Semantic versioning: `MAJOR.MINOR.PATCH`
- Pre-release: `1.0.0-beta.1`
- Default tags: `latest` (auto), `stable` (manual)

---

## Content Addressing

**Digest format:**
```
sha256:35aab70823edd888a2c4a6650d19f403de5a30f74dc91b7868b62d38a43d02f0
```

**Immutable fetch:**
```
GET /dossiers/myorg/deploy/content?digest=sha256:35aab...
```

---

## Error Format

```json
{
  "error": {
    "code": "DOSSIER_NOT_FOUND",
    "message": "Dossier 'myorg/unknown' not found",
    "request_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

All responses include the `X-Request-Id` header for request correlation. Server errors (5xx) always include `request_id` in the response body.

**Common codes:** `DOSSIER_NOT_FOUND`, `CONTENT_NOT_FOUND`, `UPSTREAM_ERROR`, `DELETE_ERROR`, `PUBLISH_ERROR`, `MISSING_FIELD`, `INVALID_NAMESPACE`, `INVALID_CONTENT`, `CONTENT_TOO_LARGE`, `INVALID_PATH`, `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `FORBIDDEN`, `METHOD_NOT_ALLOWED`, `LOGIN_ERROR`, `VERSION_NOT_FOUND`, `VERSION_EXISTS`, `RATE_LIMITED`

---

## Pagination

**Cursor-based (for search):**
```json
{
  "results": [...],
  "pagination": {
    "has_more": true,
    "next_cursor": "eyJwIjoz..."
  }
}
```

**Offset-based (for versions):**
```json
{
  "versions": [...],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total_items": 45
  }
}
```

---

## Rate Limits

| Tier | Read | Write | Search |
|------|------|-------|--------|
| Anonymous | 60/hr | 0 | 10/hr |
| Free | 1000/hr | 100/hr | 100/hr |
| Pro | 10000/hr | 1000/hr | 1000/hr |

**Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## CLI Integration

```bash
# Login via browser OAuth
dossier login

# Publish
dossier publish ./my-dossier.ds.md --name myorg/project/deploy

# Publish from Git reference
dossier publish --source https://github.com/org/repo/blob/main/deploy.ds.md

# Pull
dossier pull myorg/project/deploy
dossier pull myorg/project/deploy@1.2.0
dossier pull myorg/project/deploy@sha256:abc...

# Search
dossier search "aws deploy" --category devops --signed
```

---

## Response Schemas

### Dossier Metadata Response
```json
{
  "name": "imboard-ai/devops/deploy-to-aws",
  "title": "Deploy to AWS",
  "visibility": "public",
  "latest_version": "1.2.0",
  "tags": { "latest": "1.2.0", "stable": "1.1.0" },
  "versions": ["1.0.0", "1.1.0", "1.2.0"],
  "metadata": {
    "category": ["devops", "deployment"],
    "tags": ["aws", "terraform"],
    "risk_level": "high"
  },
  "signature": {
    "algorithm": "ed25519",
    "key_id": "author-2024",
    "trust_level": "community"
  },
  "source": {
    "type": "hosted | git",
    "url": "https://github.com/org/repo/blob/main/dossiers/deploy.ds.md"
  },
  "stats": { "downloads": 15420, "stars": 234 }
}
```

### Search Response
```json
{
  "results": [
    {
      "name": "imboard-ai/devops/deploy-to-aws",
      "title": "Deploy to AWS",
      "version": "1.2.0",
      "category": ["devops"],
      "risk_level": "high",
      "signature": { "status": "verified", "trust_level": "official" },
      "relevance_score": 0.95
    }
  ],
  "facets": {
    "category": [{"value": "devops", "count": 156}],
    "risk_level": [{"value": "high", "count": 45}]
  },
  "pagination": { "page": 1, "total": 156 }
}
```

### Verify Response
```json
{
  "integrity": { "status": "valid", "hash": "sha256:..." },
  "authenticity": {
    "status": "verified",
    "algorithm": "ed25519",
    "key_id": "author-2024",
    "is_trusted": true
  },
  "risk_assessment": { "risk_level": "high", "requires_approval": true },
  "recommendation": "ALLOW | WARN | BLOCK"
}
```

### Token Response
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 604800
}
```

> **Note:** The current implementation issues a single JWT with a 7-day expiry. There is no separate refresh token. The `scope` field is not used.

---

## API Key Scopes

- `read:private` - Read private dossiers with access
- `write` - Publish to your namespace
- `write:org/{org}/*` - Publish to org namespace
- `delete` - Delete versions
- `admin` - Manage org settings

---

## HTTP Headers & Caching

### Required Response Headers
```
X-Request-Id: req_abc123          # For debugging/support
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1701612000
```

### Caching Headers (for content endpoints)
```
ETag: "sha256:35aab70823edd..."
Cache-Control: public, max-age=31536000, immutable  # For versioned content
Last-Modified: Wed, 01 Dec 2025 00:00:00 GMT
```

### Conditional Requests
- `GET /dossiers/{name}/content` supports `If-None-Match` → returns `304 Not Modified`
- `HEAD /dossiers/{name}/content` → metadata without body (size, ETag, content-type)

### Range Requests (for large dossiers)
```
GET /dossiers/{name}/content
Range: bytes=0-1023

Response:
206 Partial Content
Content-Range: bytes 0-1023/15420
```

---

## CORS Configuration

CORS is restricted to an allowlist of known origins:
```
Access-Control-Allow-Origin: <allowed origin>     # Allowlisted origins only
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS, HEAD
Access-Control-Allow-Headers: Authorization, Content-Type, Accept
Vary: Origin
```

Default allowed origins: `https://dossier.imboard.ai`, `https://registry.dossier.dev`.
Override via `CORS_ALLOWED_ORIGINS` env var (comma-separated).

### CSRF Protection

Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) from browser origins not on the allowlist are rejected with:

```json
{
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "Origin not allowed for mutating requests"
  }
}
```
**HTTP status:** `403 Forbidden`

Read-only methods (`GET`, `HEAD`) are allowed from any origin. Requests without an `Origin` header (non-browser clients such as `curl` or the CLI) are also allowed, since CSRF is a browser-only attack vector.

---

## Version Immutability

**Rule:** Published versions are immutable. Once `myorg/deploy@1.0.0` exists:
- Content cannot be modified
- Can be deprecated (soft) or deleted (hard, with restrictions)
- New content requires new version number

---

## Namespace Ownership

**Rules:**
1. First user to publish to `username/...` owns that namespace
2. Organization namespaces (`org/...`) require org membership
3. Top-level names (`my-dossier`) are first-come-first-served
4. Reserved names blocked: `api`, `auth`, `admin`, `search`, `_*`

---

## Publish Validation Errors

| Error Code | HTTP | Cause |
|------------|------|-------|
| `INVALID_DOSSIER_FORMAT` | 400 | Not valid .ds.md format |
| `SCHEMA_VALIDATION_FAILED` | 400 | Frontmatter doesn't match schema |
| `CHECKSUM_MISMATCH` | 400 | Declared checksum != computed |
| `SIGNATURE_INVALID` | 400 | Signature verification failed |
| `VERSION_EXISTS` | 409 | Version already published |
| `VERSION_INVALID` | 400 | Not valid semver or not greater than existing |
| `NAMESPACE_FORBIDDEN` | 403 | No permission to publish to namespace |
| `RATE_LIMITED` | 429 | Too many publish requests (include `Retry-After`) |

---

## Token Lifetimes

**Token Lifetimes:**
- JWT token: 7 days (no refresh token; user must re-login after expiry)
- API key: configurable (default: 1 year)

---

## Implementation Notes

1. **Storage abstraction**: Support both hosted (S3/GCS/local) and Git references
2. **Signature verification**: Reuse existing `@imboard-ai/dossier-core` verification
3. **Schema validation**: Validate against `dossier-schema.json` on publish
4. **Search backend**: SQLite FTS for self-hosted, Elasticsearch for SaaS
5. **Idempotency**: Publish same content twice → return existing version (no error)
6. **Soft delete**: Deleted versions recoverable for 30 days
