# Authentication and Publishing Architecture

This document describes how users authenticate with the Dossier Registry CLI and how dossiers are published to the content repository. It focuses on the *narrative flow* — the "why" and "how" of auth and publishing.

> **Canonical API reference:** For endpoint specifications, CLI command listings, error codes, and phased rollout details, see [`registry-api-design.md`](./registry-api-design.md).

---

## System Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│                           ┌─────────────────┐                          │
│              OAuth login  │                 │                          │
│            ┌─────────────>│  GitHub         │                          │
│            │              │  (identity)     │                          │
│            │              │                 │                          │
│            │              └────────┬────────┘                          │
│            │                       │ redirect with code                │
│            │                       ▼                                   │
│   ┌────────┴────┐         ┌─────────────────┐       ┌───────────────┐  │
│   │             │         │                 │       │               │  │
│   │  CLI        │ ──────> │  Registry API   │ ────> │ Content Store │  │
│   │  (client)   │  JWT    │  (Vercel)       │  Bot  │ (GitHub/S3)   │  │
│   │             │ <────── │                 │ Token │               │  │
│   └─────────────┘         └─────────────────┘       └───────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

| Component | Scope | Responsibility |
|-----------|-------|----------------|
| **CLI** | Client-side | User interaction, OAuth initiation, credential storage, HTTP requests to Registry |
| **Registry API** | Server-side | OAuth callback handling, JWT issuance, authorization, validation, write to content store |
| **Content Store** | Storage | Stores dossier files (currently GitHub, future S3) |
| **GitHub** | Identity provider | OAuth for user identity and org membership (user login only) |

---

## Why Registry is Involved in OAuth

GitHub OAuth returns a temporary `code`, not user info directly. To get user info:
1. Exchange `code` for `access_token` (requires `client_secret`)
2. Use `access_token` to call GitHub API for user info + orgs

**The `client_secret` cannot live in the CLI** - it would be exposed to all users. The Registry holds the secret and performs the exchange.

Additionally, the Registry must issue its own JWT (signed with `JWT_SECRET`) that it can verify on publish requests. If CLI issued tokens directly, anyone could forge them.

---

# Part 1: CLI Scope

The CLI is a client-side tool that runs on the user's machine.

## CLI Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **User commands** | Parse and execute `dossier list`, `dossier publish`, etc. |
| **OAuth initiation** | Open browser to GitHub OAuth URL |
| **Credential storage** | Store JWT in `~/.dossier/credentials` after login |
| **HTTP requests** | Send requests to Registry API with appropriate headers |
| **Display results** | Show success/error messages to user |

## CLI Commands

For the full CLI command reference and endpoint mappings, see the [MVP0](./registry-api-design.md#mvp0-read-only-public-access) and [MVP1](./registry-api-design.md#mvp1-publishing) sections in the API design doc.

Key auth-related commands: `dossier login`, `dossier logout`, `dossier whoami`, `dossier publish`.

## CLI Credential Storage

After successful login, CLI stores the JWT locally:

```
~/.dossier/
└── credentials                        # JWT token (plaintext, 600 permissions)
```

**Format:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "alex-turner",
  "orgs": ["arctic-monkeys", "the-last-shadow-puppets"],
  "expires_at": "2025-12-04T10:00:00Z"
}
```

The CLI reads this file and includes the token in requests that require authentication.

---

# Part 2: Registry API Scope

The Registry API is a server-side service hosted on Vercel.

## Registry Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **OAuth callback** | Receive GitHub callback, exchange code for token, fetch user info |
| **JWT issuance** | Create and sign JWTs containing user identity + orgs |
| **JWT verification** | Verify JWT signature and expiry on protected endpoints |
| **Authorization** | Check if user can publish to requested namespace |
| **Validation** | Validate dossier content (format, size, path safety) |
| **Write to store** | Commit dossier to content store using bot credentials |

## Registry API Endpoints

For the complete endpoint specification (public, protected, and phased rollout), see the [API Specification](./registry-api-design.md#api-specification) in the API design doc.

The auth-specific endpoints are `/auth/login`, `/auth/callback`, `/api/v1/me`, `POST /api/v1/dossiers`, and `DELETE /api/v1/dossiers/{name}`. Their detailed flows are documented below in [Part 3](#part-3-cli--registry-communication) and [Part 4](#part-4-flows).

## Registry Environment Variables

| Variable | Purpose |
|----------|---------|
| `GITHUB_CLIENT_ID` | OAuth App client ID (public, can be in CLI) |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret (private, only in Registry) |
| `JWT_SECRET` | Secret key to sign/verify JWTs |
| `GITHUB_BOT_TOKEN` | Token to write to content repo |
| `REGISTRY_BASE_URL` | Base URL for OAuth redirect (e.g., `https://registry.dossier.dev`) |
| `CONTENT_ORG` | GitHub org owning the content repo (optional, defaults to `imboard-ai`) |
| `CONTENT_REPO` | GitHub repo name for dossier content (optional, defaults to `dossier-content`) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed CORS origins (optional, has defaults) |

> **Note:** All variables except `CONTENT_ORG`, `CONTENT_REPO`, and `CORS_ALLOWED_ORIGINS` are required. The Registry uses lazy validation — a missing variable causes a clear error (`Missing required environment variable: <name>`) on the first request that needs it.

---

# Part 3: CLI ↔ Registry Communication

## Authentication Header

For protected endpoints, CLI must include the JWT in the `Authorization` header:

```
Authorization: Bearer <JWT>
```

## API Request/Response Specs

### Login Flow (Copy/Paste Method)

```
1. User runs: dossier login

2. CLI opens browser to {REGISTRY_URL}/auth/login
   The Registry generates a random `state` parameter (32 bytes, hex-encoded),
   stores it in an HttpOnly cookie, and redirects the browser to GitHub:
   https://github.com/login/oauth/authorize?
     client_id={GITHUB_CLIENT_ID}
     &scope=read:user,read:org
     &redirect_uri={REGISTRY_URL}/auth/callback
     &state={random_state}

3. User sees GitHub consent screen, clicks "Authorize"

4. GitHub redirects browser to:
   {REGISTRY_URL}/auth/callback?code=abc123&state={random_state}

5. Registry /auth/callback endpoint:
   a. Validates `state` parameter against the value stored in an HttpOnly cookie
      (set during the login redirect) to prevent CSRF attacks
   b. Exchanges code for GitHub access token (using client_secret)
   c. Calls GitHub API to get user info + org memberships
   d. Creates JWT with username + orgs, signs with JWT_SECRET (expires in 7 days)
   e. Displays webpage: "Your login code: XXXX-XXXX-XXXX"

6. User copies the code from browser

7. CLI prompts: "Enter the code from your browser:"
   User pastes: XXXX-XXXX-XXXX

8. CLI stores JWT in ~/.dossier/credentials

9. CLI displays: "✓ Logged in as alex-turner"
```

**Why copy/paste?** Simplest approach for MVP:
- No local server needed in CLI
- No temporary storage needed in Registry
- Works in all environments (including SSH sessions)

### GET /api/v1/me

**Request:**
```http
GET /api/v1/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response (200 OK):**
```json
{
  "username": "alex-turner",
  "email": "alex.turner@gmail.com",
  "orgs": ["arctic-monkeys", "the-last-shadow-puppets"],
  "can_publish_to": [
    "alex-turner/*",
    "arctic-monkeys/*",
    "the-last-shadow-puppets/*"
  ]
}
```

**Response (401 Unauthorized):**

Three distinct error codes are returned depending on the failure:

| Code | Message | When |
|------|---------|------|
| `MISSING_TOKEN` | `Authorization header required. Use: Bearer <token>` | No Authorization header |
| `TOKEN_EXPIRED` | `Token has expired. Please login again.` | JWT has expired |
| `INVALID_TOKEN` | `Invalid token. Please login again.` | JWT signature invalid |

```json
{
  "error": {
    "code": "MISSING_TOKEN",
    "message": "Authorization header required. Use: Bearer <token>"
  }
}
```

### POST /api/v1/dossiers

All responses include the `X-Request-Id` header for request tracing (see [Request Tracing](#request-tracing)).

**Request:**
```http
POST /api/v1/dossiers
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
  "namespace": "arctic-monkeys/songs",
  "content": "---dossier\n{\n  \"name\": \"do-i-wanna-know\",\n  \"title\": \"Do I Wanna Know\",\n  \"version\": \"1.0.0\"\n}\n---\n\n# Do I Wanna Know\n\nDossier content here..."
}
```

**Response (201 Created):**
```json
{
  "name": "arctic-monkeys/songs/do-i-wanna-know",
  "version": "1.0.0",
  "title": "Do I Wanna Know",
  "content_url": "https://cdn.jsdelivr.net/gh/imboard-ai/dossier-content/arctic-monkeys/songs/do-i-wanna-know.ds.md",
  "published_at": "2025-12-04T10:00:00Z"
}
```

**Response (401 Unauthorized):**

Same three distinct error codes as `GET /api/v1/me` above (`MISSING_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN`).

**Response (403 Forbidden):**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Cannot publish to namespace 'other-org/some-dossier'",
    "namespace": "other-org/some-dossier"
  }
}
```

**Validation Errors:**

| Status | Code | When | Example message |
|--------|------|------|-----------------|
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not `application/json` | `Content-Type must be application/json, received: text/plain` |
| 400 | `MISSING_FIELD` | Required field `namespace` or `content` is missing or not a string | `Missing required field: namespace (must be a string)` |
| 400 | `INVALID_FIELD` | Optional field `changelog` is present but not a string | `Field changelog must be a string` |
| 400 | `CHANGELOG_TOO_LONG` | `changelog` exceeds maximum length | `Changelog exceeds maximum length of 500 characters` |
| 413 | `CONTENT_TOO_LARGE` | `content` exceeds 1 MB | `Content exceeds maximum size of 1024KB` |
| 400 | `INVALID_NAMESPACE` | Namespace fails format validation | *(varies by validation rule)* |
| 400 | `INVALID_PATH` | Path traversal detected in namespace | `Path traversal is not allowed` |
| 400 | `INVALID_CONTENT` | Frontmatter is missing, malformed, or fails schema validation | `Missing required field: name; Missing required field: title` |

All error responses from the publish endpoint (validation, server, and path errors) include `request_id` in the body:
```json
{
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<human-readable detail>",
    "request_id": "<X-Request-Id value>"
  }
}
```

> **Note:** Authentication errors (401) do not include `request_id`. For the full error code reference, see [Publish Validation Errors](./registry-api-design.md#publish-validation-errors).

**Response (502 Bad Gateway):**

Returned when the content store write fails. Includes `request_id` for log correlation:
```json
{
  "error": {
    "code": "PUBLISH_ERROR",
    "message": "Failed to publish dossier",
    "request_id": "a1b2c3d4-..."
  }
}
```

### DELETE /api/v1/dossiers/{name}

All responses include the `X-Request-Id` header for request tracing (see [Request Tracing](#request-tracing)).

**Request:**
```http
DELETE /api/v1/dossiers/arctic-monkeys/songs/do-i-wanna-know
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Optional query parameter: `?version=1.0.0` to delete a specific version.

**Response (200 OK):**
```json
{
  "message": "Dossier deleted",
  "name": "arctic-monkeys/songs/do-i-wanna-know",
  "version": "1.0.0"
}
```

Note: `version` is only included when a specific version was requested via `?version=X.Y.Z`.

**Response (401 Unauthorized):**

Same three distinct error codes as `GET /api/v1/me` above (`MISSING_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN`).

**Response (400 Bad Request):**

Returned when the dossier name fails validation:

| Code | When |
|------|------|
| `INVALID_NAMESPACE` | Name fails namespace format validation |
| `INVALID_PATH` | Path traversal detected |

**Response (403 Forbidden):**
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Cannot delete from namespace 'other-org/some-dossier'",
    "namespace": "other-org/some-dossier"
  }
}
```

**Response (404 Not Found):**
```json
{
  "error": {
    "code": "DOSSIER_NOT_FOUND",
    "message": "Dossier 'arctic-monkeys/songs/do-i-wanna-know' not found"
  }
}
```

Also returned when the requested version doesn't match:
```json
{
  "error": {
    "code": "VERSION_NOT_FOUND",
    "message": "Version '1.0.0' not found. Current version is '2.0.0'"
  }
}
```

**Response (502 Bad Gateway):**

Returned when the content store delete fails. Includes `request_id` for log correlation:
```json
{
  "error": {
    "code": "DELETE_ERROR",
    "message": "Failed to delete dossier. Please try again.",
    "request_id": "a1b2c3d4-..."
  }
}
```

### Request Tracing

The dossier endpoints (`/api/v1/dossiers`, `/api/v1/dossiers/{name}`) and the search endpoint (`/api/v1/search`) return an `X-Request-Id` response header for request tracing and log correlation. Authentication endpoints (`/api/v1/me`, `/auth/*`) do not.

**How it works:**
- If the client sends an `X-Request-Id` request header with a valid value (alphanumeric/hyphens, 1–64 chars), the server echoes it back.
- If the header is missing or invalid, the server generates a new UUID and uses that instead. Invalid values are logged as warnings.
- All error responses from these endpoints (validation, not-found, and server errors) include the request ID in the JSON body as `request_id`, enabling users to reference it when reporting issues.

For additional details, see [Error Format](./registry-api-design.md#error-format) in the API design doc.

---

# Part 4: Flows

## Login Flow (Detailed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              LOGIN FLOW                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User          CLI                Registry API              GitHub       │
│   │             │                      │                       │         │
│   │ dossier     │                      │                       │         │
│   │ login       │                      │                       │         │
│   │ ──────────> │                      │                       │         │
│   │             │                      │                       │         │
│   │             │ Open browser to                              │         │
│   │             │ {REGISTRY}/auth/login                        │         │
│   │             │ ───────────────────> │                       │         │
│   │             │                      │ Generate random state │         │
│   │             │                      │ Set state cookie      │         │
│   │             │                      │ Redirect to GitHub:   │         │
│   │             │                      │ github.com/login/     │         │
│   │             │                      │   oauth/authorize?    │         │
│   │             │                      │   client_id=xxx&      │         │
│   │             │                      │   scope=read:user,    │         │
│   │             │                      │   read:org&           │         │
│   │             │                      │   state={state}       │         │
│   │             │                      │ ────────────────────> │         │
│   │ <────────── │ <──────────────────── ─────────────────────────────────>         │
│   │             │                      │                       │         │
│   │ Browser shows GitHub OAuth consent │                       │         │
│   │ (read:user, read:org scopes)       │                       │         │
│   │                                    │                       │         │
│   │ User clicks "Authorize"            │                       │         │
│   │ ───────────────────────────────────────────────────────────>         │
│   │                                    │                       │         │
│   │                                    │   GitHub redirects to │         │
│   │                                    │   {REGISTRY}/auth/    │         │
│   │                                    │   callback?code=xxx   │         │
│   │                                    │   &state={state}      │         │
│   │                                    │ <───────────────────── │         │
│   │                                    │                       │         │
│   │                                    │ Validate state param  │         │
│   │                                    │ against state cookie  │         │
│   │                                    │ (CSRF protection)     │         │
│   │                                    │                       │         │
│   │                                    │ Exchange code for     │         │
│   │                                    │ access token          │         │
│   │                                    │ (using client_secret) │         │
│   │                                    │ ────────────────────> │         │
│   │                                    │ <──────────────────── │         │
│   │                                    │                       │         │
│   │                                    │ Fetch user info +     │         │
│   │                                    │ orgs using token      │         │
│   │                                    │ ────────────────────> │         │
│   │                                    │                       │         │
│   │                                    │ User: alex-turner     │         │
│   │                                    │ Orgs: [arctic-        │         │
│   │                                    │   monkeys, ...]       │         │
│   │                                    │ <──────────────────── │         │
│   │                                    │                       │         │
│   │                                    │ Create JWT:           │         │
│   │                                    │ - sub: alex-turner    │         │
│   │                                    │ - orgs: [...]         │         │
│   │                                    │ - exp: +7 days        │         │
│   │                                    │ Sign with JWT_SECRET  │         │
│   │                                    │                       │         │
│   │ Browser shows page:                │                       │         │
│   │ "Your login code:                  │                       │         │
│   │  XXXX-XXXX-XXXX"                   │                       │         │
│   │ <─────────────────────────────────── (HTML page with code) │         │
│   │                                    │                       │         │
│   │ User copies code                   │                       │         │
│   │             │                      │                       │         │
│   │             │ CLI prompts:         │                       │         │
│   │             │ "Enter the code      │                       │         │
│   │             │  from your browser:" │                       │         │
│   │ ──────────> │                      │                       │         │
│   │ (pastes     │                      │                       │         │
│   │  code)      │                      │                       │         │
│   │             │                      │                       │         │
│   │             │ Decode code → JWT    │                       │         │
│   │             │ Store in             │                       │         │
│   │             │ ~/.dossier/          │                       │         │
│   │             │ credentials          │                       │         │
│   │             │                      │                       │         │
│   │ ✓ Logged in │                      │                       │         │
│   │   as alex-  │                      │                       │         │
│   │   turner    │                      │                       │         │
│   │ <────────── │                      │                       │         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key points:**
- CLI opens browser to Registry's `/auth/login`, which sets a CSRF state cookie and redirects to GitHub
- Registry only receives the callback after user approves
- Registry displays code in browser for user to copy/paste back to CLI
- CLI never needs to run a local server

## Publish Flow (Detailed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             PUBLISH FLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User          CLI                Registry API         Content Store     │
│   │             │                      │                     │           │
│   │ dossier     │                      │                     │           │
│   │ publish     │                      │                     │           │
│   │ ./song.ds.md│                      │                     │           │
│   │ --name      │                      │                     │           │
│   │ arctic-     │                      │                     │           │
│   │ monkeys/    │                      │                     │           │
│   │ songs/diwk  │                      │                     │           │
│   │ ──────────> │                      │                     │           │
│   │             │                      │                     │           │
│   │             │ Read JWT from        │                     │           │
│   │             │ ~/.dossier/          │                     │           │
│   │             │ credentials          │                     │           │
│   │             │                      │                     │           │
│   │             │ Read file content    │                     │           │
│   │             │ ./song.ds.md         │                     │           │
│   │             │                      │                     │           │
│   │             │ POST /api/v1/        │                     │           │
│   │             │   dossiers           │                     │           │
│   │             │ Headers:             │                     │           │
│   │             │   Authorization:     │                     │           │
│   │             │   Bearer <JWT>       │                     │           │
│   │             │ Body:                │                     │           │
│   │             │   <file content>     │                     │           │
│   │             │ ───────────────────> │                     │           │
│   │             │                      │                     │           │
│   │             │                      │ 1. Verify JWT       │           │
│   │             │                      │    signature        │           │
│   │             │                      │    (using           │           │
│   │             │                      │     JWT_SECRET)     │           │
│   │             │                      │                     │           │
│   │             │                      │ 2. Check JWT not    │           │
│   │             │                      │    expired          │           │
│   │             │                      │                     │           │
│   │             │                      │ 3. Extract          │           │
│   │             │                      │    namespace:       │           │
│   │             │                      │    "arctic-monkeys" │           │
│   │             │                      │                     │           │
│   │             │                      │ 4. Check: is        │           │
│   │             │                      │    "arctic-monkeys" │           │
│   │             │                      │    in JWT orgs?     │           │
│   │             │                      │    → YES            │           │
│   │             │                      │                     │           │
│   │             │                      │ 5. Validate path    │           │
│   │             │                      │    (no traversal)   │           │
│   │             │                      │                     │           │
│   │             │                      │ 6. Validate content │           │
│   │             │                      │    (format, size)   │           │
│   │             │                      │                     │           │
│   │             │                      │ 7. Write dossier    │           │
│   │             │                      │    using BOT TOKEN  │           │
│   │             │                      │    (GITHUB_BOT_     │           │
│   │             │                      │     TOKEN)          │           │
│   │             │                      │ ──────────────────> │           │
│   │             │                      │                     │           │
│   │             │                      │    ✓ Written        │           │
│   │             │                      │ <────────────────── │           │
│   │             │                      │                     │           │
│   │             │                      │ 8. Update           │           │
│   │             │                      │    index.json       │           │
│   │             │                      │ ──────────────────> │           │
│   │             │                      │ <────────────────── │           │
│   │             │                      │                     │           │
│   │             │  201 Created         │                     │           │
│   │             │  {name, version,     │                     │           │
│   │             │   content_url, ...}  │                     │           │
│   │             │ <─────────────────── │                     │           │
│   │             │                      │                     │           │
│   │ ✓ Published │                      │                     │           │
│   │   to arctic-│                      │                     │           │
│   │   monkeys/  │                      │                     │           │
│   │   songs/diwk│                      │                     │           │
│   │ <────────── │                      │                     │           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

# Part 5: Two Token System

> For token lifetimes and API key scopes, see [Token Lifetimes](./registry-api-design.md#token-lifetimes) and [API Key Scopes](./registry-api-design.md#api-key-scopes) in the API design doc.

| Token | Where Used | Purpose | Scope | Owner |
|-------|------------|---------|-------|-------|
| **User JWT** | CLI → Registry API | Prove user identity | Contains username + orgs | Issued by Registry, stored by CLI |
| **Bot Token** | Registry API → Content Store | Write dossiers | `repo` (GitHub) or S3 creds | Owned by Registry (env var) |

**Key principle:** The user's JWT is only used for authentication/authorization. All writes to the content store use the Registry's bot token (`GITHUB_BOT_TOKEN`).

### JWT Structure

```json
{
  "sub": "alex-turner",
  "email": "alex.turner@gmail.com",
  "orgs": ["arctic-monkeys", "the-last-shadow-puppets"],
  "iat": 1701684000,
  "exp": 1702288800
}
```

- **sub**: GitHub username (used for personal namespace)
- **orgs**: GitHub org memberships (used for org namespaces)
- **exp**: Expiry time (7 days from issue)

Signed by Registry using `JWT_SECRET` environment variable.

---

# Part 6: Namespace Permissions

> See also [Namespace Ownership](./registry-api-design.md#namespace-ownership) in the API design doc for naming rules and reserved names.

A user can publish to a namespace if:

| Namespace Type | Rule | Example |
|----------------|------|---------|
| **Personal** | `namespace === JWT.sub` | `alex-turner/*` → only alex-turner |
| **Organization** | `namespace in JWT.orgs` | `arctic-monkeys/*` → any org member |

### Example: Alex Turner

After login, Alex's JWT contains:
```json
{
  "sub": "alex-turner",
  "orgs": ["arctic-monkeys", "the-last-shadow-puppets"]
}
```

| Namespace | Can publish? | Reason |
|-----------|--------------|--------|
| `alex-turner/*` | ✅ Yes | `"alex-turner" === JWT.sub` |
| `arctic-monkeys/*` | ✅ Yes | `"arctic-monkeys" in JWT.orgs` |
| `the-last-shadow-puppets/*` | ✅ Yes | `"the-last-shadow-puppets" in JWT.orgs` |
| `random-org/*` | ❌ No | Not in JWT.sub or JWT.orgs |
| `jane-doe/*` | ❌ No | Not in JWT.sub or JWT.orgs |

---

# Part 7: Content Store Abstraction

The Registry writes to a content store using its bot token. Currently GitHub, designed to swap to S3.

### Current: GitHub

```
Registry API
    │
    │  Uses: GITHUB_BOT_TOKEN (repo scope)
    │  Repo:  imboard-ai/dossier-content
    │
    ▼
GitHub API
    │
    ├── PUT /repos/{owner}/{repo}/contents/{path}
    │   (create/update dossier file)
    │
    └── Triggers jsDelivr CDN update
```

### Future: S3

```
Registry API
    │
    │  Uses: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
    │  Bucket: dossier-content
    │
    ▼
S3 API
    │
    ├── PUT /{bucket}/{path}
    │   (create/update dossier file)
    │
    └── CloudFront CDN
```

**Migration path:** Copy all files from GitHub to S3, update `lib/config.js` to point to S3/CloudFront.

---

# Part 8: Security Considerations

This section covers auth-specific security concerns. For CORS configuration and request-level CSRF protection, see [CORS Configuration](./registry-api-design.md#cors-configuration) in the API design doc.

### 1. Stale Org Permissions ⚠️

**Problem:** If a user is removed from an org after login, their JWT still contains that org until expiry.

**Mitigation:** JWT expiry of 7 days. User must re-login to refresh org list.

### 2. JWT Storage on Client

**Approach:** Plaintext file at `~/.dossier/credentials` with `600` permissions.

**Rationale:** Same approach as npm, Docker, GitHub CLI. Acceptable for developer tools.

### 3. Path Traversal Prevention ⚠️

**Registry must validate:**
```javascript
// Reject if:
// - Contains ".."
// - Contains absolute paths (starts with /)
// - Contains characters outside [a-z0-9-_/]
// - Namespace not in user's allowed list
```

### 4. Content Validation

**On publish, Registry validates:**
- File size < 1MB
- Valid `.ds.md` format (YAML/JSON frontmatter)
- Schema validation on frontmatter

For publish validation error codes, see [Publish Validation Errors](./registry-api-design.md#publish-validation-errors) in the API design doc.

### 5. Bot Token Scope

**MVP1:** Personal Access Token with `repo` scope.

**Prod0:** GitHub App with write access only to `dossier-content` repo.

### 6. Client Secret Protection

The `GITHUB_CLIENT_SECRET` is stored only in Registry environment variables, never exposed to CLI users. This is why we need the Registry in the OAuth flow.

### 7. CSRF Protection (OAuth State Parameter)

**Problem:** Without CSRF protection, an attacker could trick a user into completing an OAuth flow that logs them into the attacker's account (login CSRF).

**Mitigation:** The login endpoint generates a cryptographically random `state` parameter (32 bytes, hex-encoded) and stores it in an `HttpOnly; Secure; SameSite=Lax` cookie (`dossier_oauth_state`). The same value is sent to GitHub as the `state` query parameter. On callback, the Registry validates that the `state` from GitHub matches the cookie value using a timing-safe comparison. If the state is missing or mismatched, the request is rejected.

For CORS-level CSRF protection on mutating API requests, see [CSRF Protection](./registry-api-design.md#csrf-protection) in the API design doc.

---

# Part 9: Implementation Phases

For the phased rollout plan (MVP0 → MVP1 → Prod0 → Prod1) and the full endpoint roadmap, see the [Phase Overview](./registry-api-design.md#phase-overview) and [Phase Summary](./registry-api-design.md#phase-summary) in the API design doc.
