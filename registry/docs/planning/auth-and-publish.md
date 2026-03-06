# Authentication and Publishing Architecture

This document describes how users authenticate with the Dossier Registry CLI and how dossiers are published to the content repository.

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

### No Authentication Required

These commands hit public Registry API endpoints:

```bash
dossier list                           # GET /api/v1/dossiers
dossier list --category devops         # GET /api/v1/dossiers?category=devops
dossier info org/name                  # GET /api/v1/dossiers/{name}
dossier pull org/name                  # GET /api/v1/dossiers/{name}/content
dossier run ./local.ds.md              # Local only, no API call
dossier create                         # Local only, no API call
```

### Authentication Required

These commands require a stored JWT:

```bash
dossier login                          # Opens browser → GitHub OAuth → copy/paste code
dossier logout                         # Deletes ~/.dossier/credentials
dossier whoami                         # GET /api/v1/me (with JWT)
dossier publish ./my.ds.md             # POST /api/v1/dossiers/{name} (with JWT)
```

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

### Public Endpoints (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/dossiers` | List all dossiers |
| `GET` | `/api/v1/dossiers/{name}` | Get dossier metadata |
| `GET` | `/api/v1/dossiers/{name}/content` | Returns dossier content with `X-Dossier-Digest` header |
| `GET` | `/auth/login` | Initiates OAuth flow - sets CSRF state cookie, redirects to GitHub |
| `GET` | `/auth/callback` | OAuth callback - exchanges code, displays JWT for copy/paste |

### Protected Endpoints (JWT Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/me` | Get current user info from JWT |
| `POST` | `/api/v1/dossiers/{name}` | Publish a dossier |

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

### POST /api/v1/dossiers/{name}

**Request:**
```http
POST /api/v1/dossiers/arctic-monkeys/songs/do-i-wanna-know
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: text/markdown

---dossier
{
  "title": "Do I Wanna Know",
  "version": "1.0.0",
  ...
}
---

# Do I Wanna Know

Dossier content here...
```

**Response (201 Created):**
```json
{
  "name": "arctic-monkeys/songs/do-i-wanna-know",
  "version": "1.0.0",
  "content_url": "https://cdn.jsdelivr.net/gh/imboard-ai/dossier-content/arctic-monkeys/songs/do-i-wanna-know.ds.md",
  "published_at": "2025-12-04T10:00:00Z",
  "published_by": "alex-turner"
}
```

**Response (401 Unauthorized):**

Same three distinct error codes as `GET /api/v1/me` above (`MISSING_TOKEN`, `TOKEN_EXPIRED`, `INVALID_TOKEN`).

**Response (403 Forbidden):**
```json
{
  "error": {
    "code": "NAMESPACE_FORBIDDEN",
    "message": "You don't have permission to publish to 'other-org/*'"
  }
}
```

**Response (400 Bad Request):**
```json
{
  "error": {
    "code": "INVALID_DOSSIER_FORMAT",
    "message": "Invalid frontmatter: missing required field 'title'"
  }
}
```

**Response (409 Conflict):**
```json
{
  "error": {
    "code": "VERSION_EXISTS",
    "message": "Version 1.0.0 already exists for this dossier"
  }
}
```

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
│   │             │   dossiers/arctic-   │                     │           │
│   │             │   monkeys/songs/diwk │                     │           │
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

### 5. Bot Token Scope

**MVP1:** Personal Access Token with `repo` scope.

**Prod0:** GitHub App with write access only to `dossier-content` repo.

### 6. Client Secret Protection

The `GITHUB_CLIENT_SECRET` is stored only in Registry environment variables, never exposed to CLI users. This is why we need the Registry in the OAuth flow.

### 7. CSRF Protection (OAuth State Parameter)

**Problem:** Without CSRF protection, an attacker could trick a user into completing an OAuth flow that logs them into the attacker's account (login CSRF).

**Mitigation:** The login endpoint generates a cryptographically random `state` parameter (32 bytes, hex-encoded) and stores it in an `HttpOnly; Secure; SameSite=Lax` cookie (`dossier_oauth_state`). The same value is sent to GitHub as the `state` query parameter. On callback, the Registry validates that the `state` from GitHub matches the cookie value using a timing-safe comparison. If the state is missing or mismatched, the request is rejected.

---

# Part 9: Implementation Phases

### Phase 1: Auth Foundation
- [ ] Create GitHub OAuth App
- [ ] Implement `GET /auth/callback` - exchange code, display JWT code for copy/paste
- [ ] Implement `GET /api/v1/me` - return user info from JWT
- [ ] JWT signing and verification

### Phase 2: Publish Endpoint
- [ ] Implement `POST /api/v1/dossiers/{name}`
- [ ] JWT verification middleware
- [ ] Namespace permission checking
- [ ] Path validation (security)
- [ ] Content validation (format, size)

### Phase 3: Content Store Integration
- [ ] Set up bot token with repo access
- [ ] Implement GitHub commit via API
- [ ] Update index.json on publish
- [ ] Handle conflicts (version exists)

### Phase 4: CLI Integration (separate repo)
- [ ] `dossier login` command (open browser, prompt for code)
- [ ] `dossier logout` command
- [ ] `dossier whoami` command
- [ ] `dossier publish` command
- [ ] Credential storage in `~/.dossier/credentials`
