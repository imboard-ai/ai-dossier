# MVP1 Phase 2: Publish Flow Implementation Plan

## Status: COMPLETE

## Summary
Implement the publish endpoint that allows authenticated users to publish dossiers to the registry.

## Scope
- [x] `POST /api/v1/dossiers` endpoint
- [x] Dossier frontmatter parsing
- [x] Namespace permission checking
- [x] Content validation
- [x] GitHub API integration (commit to dossier-content repo)
- [x] Manifest (index.json) updates
- [x] `GET /api/v1/docs` - Self-describing API documentation endpoint

---

## Prerequisites

### 1. Create GitHub Bot Token
The registry needs a token to write to the `dossier-content` repo.

1. Go to: GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens
2. Generate new token with:
   - **Repository access:** Only `imboard-ai/dossier-content`
   - **Permissions:** Contents (Read and Write)
3. Add to Vercel:
   ```bash
   vercel env add GITHUB_BOT_TOKEN
   ```

---

## API Design

### POST /api/v1/dossiers

**Request:**
```
Authorization: Bearer <JWT>
Content-Type: application/json
```

```json
{
  "namespace": "imboard-ai/development",
  "content": "---dossier\n{\n  \"name\": \"setup-react\",\n  \"title\": \"Setup React Library\",\n  \"version\": \"1.0.0\"\n}\n---\n\n# Instructions\n...",
  "changelog": "Initial publish"
}
```

**Response (201 Created):**
```json
{
  "name": "imboard-ai/development/setup-react",
  "version": "1.0.0",
  "title": "Setup React Library",
  "content_url": "https://cdn.jsdelivr.net/gh/imboard-ai/dossier-content/imboard-ai/development/setup-react.ds.md",
  "published_at": "2024-12-04T12:00:00Z"
}
```

**Error Responses:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_CONTENT` | Missing/malformed frontmatter |
| 400 | `MISSING_FIELD` | Required field missing (name, title, version) |
| 400 | `INVALID_FIELD` | Invalid field value (e.g. changelog not a string) |
| 400 | `INVALID_NAMESPACE` | Dossier name fails validation (invalid characters, depth, or length) |
| 400 | `CHANGELOG_TOO_LONG` | Changelog exceeds maximum length (500 characters) |
| 400 | `INVALID_PATH` | Path traversal attempt detected |
| 401 | `MISSING_TOKEN` | No Authorization header |
| 401 | `INVALID_TOKEN` | Invalid/expired JWT |
| 403 | `FORBIDDEN` | User cannot publish to this namespace |
| 413 | `CONTENT_TOO_LARGE` | Content exceeds 1MB limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type is not application/json |
| 502 | `PUBLISH_ERROR` | GitHub API commit failed (includes request_id for log correlation) |

---

## Implementation Steps

### Step 1: Add GITHUB_BOT_TOKEN to config
Update `lib/config.js`:
```javascript
github: {
  botToken: process.env.GITHUB_BOT_TOKEN,
  contentRepo: {
    owner: 'imboard-ai',    // override with CONTENT_ORG env var
    repo: 'dossier-content', // override with CONTENT_REPO env var
  },
},
```

### Step 2: Create `lib/dossier.js` - Dossier parsing utilities
Functions:
- `parseFrontmatter(content)` - Extract JSON/YAML frontmatter from .ds.md
- `validateDossier(parsed)` - Check required fields (name, title, version)
- `buildFullName(namespace, name)` - Combine namespace + name

### Step 3: Create `lib/github.js` - GitHub API utilities
Functions:
- `getFileContent(path)` - Get file from content repo (for checking existence)
- `createOrUpdateFile(path, content, message)` - Commit file to repo
- `getManifest()` - Get current index.json
- `updateManifest(manifest)` - Commit updated index.json

### Step 4: Create `lib/permissions.js` - Permission checking
Functions:
- `canPublishTo(jwt, namespace)` - Check if user can publish to namespace
  - Extract root namespace (first segment)
  - Check if root === jwt.sub (personal) or root in jwt.orgs (org)

### Step 5: Create `api/v1/dossiers/index.js` - Publish endpoint
Update existing file to handle both GET (list) and POST (publish).

Flow:
1. Check method (GET = list, POST = publish)
2. For POST:
   a. Extract and verify JWT
   b. Parse request body (namespace, content, changelog)
   c. Parse frontmatter from content
   d. Validate dossier (required fields, format)
   e. Build full path: `{namespace}/{name}.ds.md`
   f. Check permissions
   g. Check if version already exists (optional: allow overwrite?)
   h. Commit dossier file to GitHub
   i. Update index.json manifest
   j. Return success response

### Step 6: Update HTTP test files
Add publish tests.

---

## File Structure

```
lib/
  auth.ts         # JWT utilities and request authentication
  config.ts       # Add github.botToken config
  constants.ts    # Shared constants (user agent, CDN URLs)
  cors.ts         # CORS handling utilities
  dossier.ts      # Dossier parsing/validation
  github.ts       # GitHub API for commits
  manifest.ts     # Manifest fetching and normalization
  permissions.ts  # Namespace permission checking
  responses.ts    # Shared HTTP response helpers
  types.ts        # TypeScript type definitions
api/v1/
  dossiers/
    index.ts      # UPDATE - Add POST handler
```

---

## Dossier Frontmatter Schema

Required fields:
```json
---dossier
{
  "name": "setup-react",
  "title": "Setup React Library",
  "version": "1.0.0"
}
---
```

Optional fields:
```json
---dossier
{
  "description": "Short description",
  "category": "development",
  "tags": ["react", "library"],
  "author": "yuvaldim"
}
---
```

---

## Validation Rules

1. **Content size:** Max 1MB
2. **Frontmatter:** Must be valid JSON/YAML between `---dossier` or `---` markers
3. **Required fields:** name, title, version
4. **Name format:** lowercase alphanumeric + hyphens, 1-64 chars
5. **Version format:** Valid semver (x.y.z)
6. **Namespace:** Must match user's permissions

---

## GitHub Commit Flow

1. **Get current manifest:**
   ```
   GET /repos/imboard-ai/dossier-content/contents/index.json
   ```

2. **Create/update dossier file:**
   ```
   PUT /repos/imboard-ai/dossier-content/contents/{path}.ds.md
   {
     "message": "Publish {name} v{version}",
     "content": "<base64 encoded>",
     "sha": "<if updating existing>"
   }
   ```

3. **Update manifest:**
   ```
   PUT /repos/imboard-ai/dossier-content/contents/index.json
   {
     "message": "Update manifest: add {name}",
     "content": "<base64 encoded new manifest>",
     "sha": "<current sha>"
   }
   ```

---

## Security Considerations

1. **Path traversal:** Reject names containing `..`, `/`, or non-alphanumeric chars
2. **Namespace validation:** Always verify against JWT claims
3. **Bot token scope:** Limited to content repo only
4. **Content validation:** Parse JSON/YAML safely, reject malformed input

---

## Testing Checklist

### Happy Path
- [ ] Publish new dossier to personal namespace
- [ ] Publish new dossier to org namespace
- [ ] Verify file created in GitHub
- [ ] Verify manifest updated
- [ ] Verify CDN serves new dossier

### Error Cases
- [ ] Missing auth token → 401
- [ ] Invalid token → 401
- [ ] Missing frontmatter → 400
- [ ] Missing required field → 400
- [ ] Wrong namespace → 403
- [ ] Content too large → 413
