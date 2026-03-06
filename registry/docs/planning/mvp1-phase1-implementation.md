# MVP1 Phase 1: Auth Foundation Implementation Plan

## Status: COMPLETE

## Summary
Implement GitHub OAuth authentication with JWT tokens for the Dossier Registry. This enables users to authenticate via CLI and prepares the foundation for the publish flow in Phase 2.

## Scope
- [x] OAuth callback endpoint (`GET /auth/callback`)
- [x] Protected user info endpoint (`GET /api/v1/me`)
- [x] JWT signing/verification library
- [x] Environment variables setup

---

## Prerequisites (Manual Steps)

### 1. Create GitHub OAuth App
1. Go to: GitHub > Settings > Developer settings > OAuth Apps > New OAuth App
2. Fill in:
   - **Application name:** `Dossier Registry`
   - **Homepage URL:** `https://github.com/liberioai/dossier`
   - **Authorization callback URL:** `https://dossier-registry.vercel.app/auth/callback`
3. Click "Register application"
4. Note the **Client ID**
5. Click "Generate a new client secret" and copy the **Client Secret**

### 2. Set Vercel Environment Variables
```bash
vercel env add GITHUB_CLIENT_ID
vercel env add GITHUB_CLIENT_SECRET
vercel env add JWT_SECRET
```

Or via Vercel Dashboard: Project > Settings > Environment Variables

| Variable | Value |
|----------|-------|
| `GITHUB_CLIENT_ID` | From OAuth App |
| `GITHUB_CLIENT_SECRET` | From OAuth App |
| `JWT_SECRET` | Generate: `openssl rand -base64 32` |

### 3. Create `.env.local` for local development
```bash
vercel env pull .env.local
```

---

## Implementation Steps

### Step 1: Initialize npm and add dependencies
- [x] Run `npm init -y`
- [x] Run `npm install jsonwebtoken`
- [x] `.gitignore` already has `node_modules/`

### Step 2: Update `lib/config.js`
- [x] Add auth configuration section with GitHub OAuth and JWT settings

### Step 3: Create `lib/auth.js`
- [x] Create JWT and GitHub API utilities module

Functions implemented:
- `signJwt(payload)` - Create signed JWT with claims
- `verifyJwt(token)` - Verify and decode JWT
- `extractBearerToken(req)` - Extract token from Authorization header
- `authenticateRequest(req, res)` - Verify JWT from request, send 401 with specific error codes (MISSING_TOKEN, TOKEN_EXPIRED, INVALID_TOKEN)
- `authorizePublish(req, res, namespace)` - Authenticate and check namespace publish permission
- `encodeAsDisplayCode(token)` - Base64url encode JWT for display
- `decodeDisplayCode(code)` - Decode display code back to JWT
- `exchangeGitHubCode(code)` - Exchange OAuth code for access token
- `fetchGitHubUser(accessToken)` - Get user info from GitHub API
- `fetchGitHubOrgs(accessToken)` - Get user's org memberships

### Step 4: Create `api/auth/callback.js`
- [x] Create OAuth callback handler

Flow:
1. Receive `?code=xxx&state=xxx` from GitHub redirect
2. Validate `state` parameter against the value stored in an HttpOnly cookie (CSRF protection)
3. Handle errors from GitHub (`?error=...`)
4. Exchange code for GitHub access token (POST to GitHub)
5. Fetch user info + org memberships (parallel requests)
6. Create JWT: `{ sub: username, email, orgs, iat, exp }`
7. Display HTML page with:
   - Organizations list (with badges)
   - "Missing an org?" link to grant access
   - Base64-encoded JWT for copy/paste

### Step 5: Create `api/v1/me.js`
- [x] Create protected user info endpoint

Flow:
1. Extract JWT from `Authorization: Bearer <token>` header
2. Return 401 if missing
3. Verify JWT signature and expiry
4. Return 401 if invalid/expired
5. Return: `{ username, email, orgs, can_publish_to }`

### Step 6: Update `vercel.json`
- [x] Add rewrite for auth callback route

### Step 7: Update HTTP test files
- [x] Add auth test cases to `tests/http/local.http`
- [x] Add auth test cases to `tests/http/production.http`

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Created | npm package with jsonwebtoken dependency |
| `lib/config.js` | Modified | Added auth configuration |
| `lib/auth.js` | Created | JWT and GitHub API utilities |
| `api/auth/callback.js` | Created | OAuth callback endpoint |
| `api/v1/me.js` | Created | Current user endpoint |
| `vercel.json` | Modified | Added auth route rewrite |
| `tests/http/local.http` | Modified | Added auth tests |
| `tests/http/production.http` | Modified | Added auth tests |

---

## API Endpoints

### GET /auth/callback
OAuth callback from GitHub. Displays HTML page with login code.

### GET /api/v1/me
Protected endpoint returning current user info.

**Request:**
```
Authorization: Bearer <JWT>
```

**Response:**
```json
{
  "username": "yuvaldim",
  "email": null,
  "orgs": ["imboard-ai"],
  "can_publish_to": ["yuvaldim/*", "imboard-ai/*"]
}
```

---

## Error Response Format

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message" } }
```

| Code | HTTP Status | When |
|------|-------------|------|
| `MISSING_TOKEN` | 401 | No Authorization header |
| `INVALID_TOKEN` | 401 | JWT signature invalid |
| `TOKEN_EXPIRED` | 401 | JWT has expired |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |

---

## Testing

### OAuth Flow
1. Open: `https://dossier-registry.vercel.app/auth/login`
2. Authorize the app
3. Copy the displayed code
4. Decode: `echo "<CODE>" | base64 -d` to get JWT
5. Test: `curl -H "Authorization: Bearer <JWT>" https://dossier-registry.vercel.app/api/v1/me`

### Organization Access
- `read:org` scope only shows orgs where:
  - User's membership is public, OR
  - The org has approved the OAuth app
- Success page includes "Grant organization access" link for users to enable private org access

---

## JWT Claims Structure

```json
{
  "sub": "yuvaldim",
  "email": null,
  "orgs": ["imboard-ai"],
  "iat": 1764847354,
  "exp": 1765452154
}
```

- `sub` - GitHub username (personal namespace)
- `email` - From GitHub profile (may be null)
- `orgs` - Array of org logins user belongs to
- `iat` - Issued at timestamp
- `exp` - Expiry (7 days from issue)
