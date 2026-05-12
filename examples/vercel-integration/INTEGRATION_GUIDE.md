# Vercel Tracing Integration - Gap-Filling Guide

**For Local Agent with Vercel Access**

This guide is designed for an AI agent that has access to your actual Vercel project. The implementation is 95% complete with clearly marked gaps that need to be adapted to your specific project.

---

## 📋 Overview

**What's Complete**:
- ✅ All API route implementations
- ✅ Prisma schema definitions
- ✅ Database setup instructions
- ✅ Test suite

**What Has Gaps** (needs your project-specific info):
- 🔶 Authentication integration (your auth system)
- 🔶 Import paths (your project structure)
- 🔶 User/Space model references (your existing models)

---

## 🎯 Instructions for Agent

### Step 1: Understand the Project

Before filling gaps, analyze the target Vercel project:

```bash
# Examine project structure
ls -la app/api/
ls -la lib/
cat prisma/schema.prisma | head -50

# Identify auth system
grep -r "NextAuth\|Clerk\|Auth0\|getSession" app/ lib/

# Find existing User/Space models
grep -r "model User\|model Space" prisma/

# Check existing API patterns
cat app/api/*/route.ts | head -20
```

**Document findings**:
- Auth system: [NextAuth / Clerk / Auth0 / Custom]
- User model location: [path]
- Space/tenant model: [exists? / needs creation]
- Import alias: [@/lib or ../lib or other]

---

## 🔧 Gap #1: Authentication Middleware

**File**: `lib/auth.ts`

**Current code** (in this repo):
```typescript
// GAP: Adapt this to your authentication system
export async function authenticate(req: NextRequest) {
  // EXAMPLE implementations provided
  // You need to: Replace with actual auth logic
  
  throw new Error('Unauthorized');
}
```

**What you need to do**:

1. **Identify auth system in target project**:
   ```bash
   # Check for NextAuth
   grep -r "next-auth" package.json app/
   
   # Check for Clerk
   grep -r "@clerk" package.json app/
   
   # Check for custom auth
   find lib/ -name "*auth*" -o -name "*session*"
   ```

2. **Copy the appropriate example** from `lib/auth.example.ts`:
   - If NextAuth: Lines 15-29
   - If Clerk: Lines 31-45
   - If Custom JWT: Lines 47-60
   - If API Key: Lines 62-80

3. **Adapt to actual code**:
   ```typescript
   // Example for NextAuth (adapt to actual imports)
   import { getServerSession } from 'next-auth';
   import { authOptions } from '@/app/api/auth/[...nextauth]/route';
   
   export async function authenticate(req: NextRequest) {
     const session = await getServerSession(authOptions);
     
     if (!session?.user) {
       throw new Error('Unauthorized');
     }
     
     return {
       userId: session.user.id,
       spaceId: session.user.claimedSpace?.id || session.user.id, // GAP: Adapt space access
       user: session.user,
     };
   }
   ```

4. **Handle space/tenant logic**:
   - If project has spaces: Use `session.user.claimedSpace.id`
   - If no spaces yet: Use `session.user.id` as spaceId
   - If needs spaces: Create Space model first (see Gap #3)

**Verification**:
```bash
# After filling gap, test auth works
curl http://localhost:3000/api/traces -H "Authorization: Bearer test-token"
# Should return 401 Unauthorized (correct behavior when not logged in)
```

---

## 🔧 Gap #2: Prisma Schema Integration

**File**: `prisma/schema.prisma`

**What you need to do**:

1. **Check existing User model**:
   ```bash
   grep -A 10 "model User" prisma/schema.prisma
   ```

2. **Check if Space model exists**:
   ```bash
   grep -A 10 "model Space" prisma/schema.prisma
   ```

3. **Add Trace models**:
   - Copy `Trace` and `TraceStep` models from `examples/vercel-integration/prisma/schema.prisma`
   - **Adapt field names** to match your existing models:
     ```prisma
     // If your User model uses different ID field:
     model Trace {
       userId String
       user   User @relation(fields: [userId], references: [id])  // GAP: Change 'id' if different
     }
     ```

4. **Handle Space relationship**:
   
   **If Space model exists**:
   ```prisma
   model Trace {
     spaceId String
     space   Space @relation(fields: [spaceId], references: [id])
   }
   ```
   
   **If no Space model** (add it):
   ```prisma
   model Space {
     id        String   @id @default(cuid())
     userId    String
     name      String
     slug      String   @unique
     createdAt DateTime @default(now())
     
     user      User     @relation(fields: [userId], references: [id])
     traces    Trace[]
   }
   
   model User {
     // ... existing fields
     spaces    Space[]
     traces    Trace[]
   }
   ```
   
   **If no need for multi-tenancy** (single space per user):
   ```prisma
   model Trace {
     userId  String
     spaceId String  // Just store userId here too
     user    User @relation(fields: [userId], references: [id])
     // No Space relation needed
   }
   ```

5. **Run migration**:
   ```bash
   npx prisma migrate dev --name add-dossier-tracing
   npx prisma generate
   ```

**Verification**:
```bash
# Check migration succeeded
npx prisma studio
# Navigate to Trace model - should exist with all fields
```

---

## 🔧 Gap #3: Import Paths

**Files**: All API routes (`api/traces/*.ts`)

**What you need to do**:

1. **Identify import alias**:
   ```bash
   # Check tsconfig.json
   cat tsconfig.json | grep "paths"
   
   # Common patterns:
   # @/lib/prisma     (most Next.js projects)
   # ../../../lib/prisma  (relative)
   # ~/lib/prisma     (some configs)
   ```

2. **Update imports in API routes**:
   ```typescript
   // Current (might need changing):
   import { prisma } from '@/lib/prisma';
   import { authenticate } from '@/lib/auth';
   
   // If your project uses different alias:
   import { prisma } from '~/lib/prisma';  // or
   import { prisma } from '../../../lib/prisma';  // or
   import { db } from '@/lib/db';  // if you call it 'db' not 'prisma'
   ```

3. **Find and replace**:
   ```bash
   # If you use '~/lib' instead of '@/lib':
   find app/api/traces -name "*.ts" -exec sed -i 's/@\/lib/~\/lib/g' {} \;
   
   # If you call it 'db' not 'prisma':
   find app/api/traces -name "*.ts" -exec sed -i 's/{ prisma }/{ db as prisma }/g' {} \;
   ```

**Verification**:
```bash
# TypeScript should compile without errors
npm run build
# or
npx tsc --noEmit
```

---

## 🔧 Gap #4: Environment Variables

**What you need to do**:

1. **Create Vercel Postgres database** (if not exists):
   ```bash
   vercel storage create postgres dossier-traces
   ```

2. **Pull environment variables**:
   ```bash
   vercel env pull .env.local
   ```

3. **Verify env vars exist**:
   ```bash
   cat .env.local | grep POSTGRES
   # Should show:
   # POSTGRES_URL=...
   # POSTGRES_PRISMA_URL=...
   # POSTGRES_URL_NON_POOLING=...
   ```

4. **Update Prisma datasource** (if needed):
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("POSTGRES_PRISMA_URL")
     directUrl = env("POSTGRES_URL_NON_POOLING")
   }
   ```

**Verification**:
```bash
# Test database connection
npx prisma db pull
# Should not error
```

---

## 🧪 Step 2: Run Tests

After filling all gaps, run the verification tests:

### Test 1: Compilation

```bash
npm run build
# Should succeed with no TypeScript errors
```

### Test 2: Database Connection

```bash
npx prisma studio
# Should open Prisma Studio showing Trace and TraceStep models
```

### Test 3: Local Server

```bash
npm run dev

# In another terminal:
curl http://localhost:3000/api/traces
# Should return: {"error": "unauthorized", ...}  (correct - no auth provided)
```

### Test 4: Create Trace (with auth)

```bash
# Get a valid auth token from your system (login first)
TOKEN="your-session-token-here"

# Create trace
curl -X POST http://localhost:3000/api/traces \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "dossier": {
      "title": "Test Dossier",
      "version": "1.0.0"
    },
    "agent": {
      "name": "Test Agent",
      "version": "1.0"
    },
    "started_at": "2026-05-12T10:30:00Z",
    "status": "running"
  }'

# Should return: {"trace_id": "550e8400...", "created_at": "...", "url": "..."}
```

### Test 5: Retrieve Trace

```bash
curl http://localhost:3000/api/traces/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer $TOKEN"

# Should return: Full trace JSON
```

### Test 6: Append Step

```bash
curl -X POST http://localhost:3000/api/traces/550e8400-e29b-41d4-a716-446655440000/steps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "step_id": "step_001",
    "type": "action",
    "timestamp": "2026-05-12T10:31:00Z",
    "description": "Test step",
    "action": {"type": "command", "command": "echo test"},
    "result": {"status": "success", "exit_code": 0}
  }'

# Should return: {"trace_id": "...", "step_id": "step_001", "step_number": 1}
```

### Test 7: List Traces

```bash
curl http://localhost:3000/api/traces \
  -H "Authorization: Bearer $TOKEN"

# Should return: {"traces": [...], "pagination": {...}}
```

---

## ✅ Step 3: Verification Checklist

Run through this checklist and verify each item:

- [ ] **Compilation**: `npm run build` succeeds
- [ ] **Database**: Prisma Studio shows Trace/TraceStep tables
- [ ] **Auth**: Unauthenticated requests return 401
- [ ] **Create**: Can create a trace with valid auth
- [ ] **Read**: Can retrieve created trace
- [ ] **Update**: Can append steps to trace
- [ ] **List**: Can list traces with filters
- [ ] **Isolation**: User can only see their own traces (test with 2 users)
- [ ] **Deploy**: `vercel deploy` succeeds
- [ ] **Production**: All tests pass on deployed site

---

## 🚀 Step 4: Deploy

Once all tests pass locally:

```bash
# Deploy to Vercel
vercel deploy --prod

# Run production tests
PROD_URL="https://your-app.vercel.app"
curl $PROD_URL/api/traces -H "Authorization: Bearer $PROD_TOKEN"
```

---

## 📊 Gap Summary

| Gap | Location | Complexity | Required Info |
|-----|----------|------------|---------------|
| **Authentication** | `lib/auth.ts` | Medium | Your auth system (NextAuth/Clerk/etc) |
| **Prisma Schema** | `prisma/schema.prisma` | Low | User/Space model field names |
| **Import Paths** | All API routes | Low | Your import alias (@/lib vs ~/lib) |
| **Env Vars** | `.env.local` | Low | Vercel Postgres credentials |

---

## 🤖 Agent Instructions Summary

**Your mission**: Fill 4 gaps, run 7 tests, verify checklist, deploy.

**Process**:
1. Analyze target project (auth system, models, imports)
2. Fill Gap #1 (auth) - copy appropriate example
3. Fill Gap #2 (schema) - add models, handle Space
4. Fill Gap #3 (imports) - fix paths
5. Fill Gap #4 (env vars) - create database
6. Run Test Suite (7 tests)
7. Verify Checklist (10 items)
8. Deploy
9. Report results

**Expected time**: 10-15 minutes

**If stuck**: All examples are in `lib/auth.example.ts` and comments explain each choice.

---

## 📝 Reporting Template

After completion, report:

```
✅ Dossier Tracing Integration Complete

Gaps Filled:
- Auth: [NextAuth/Clerk/Custom] - Used [file] pattern
- Schema: [With Spaces / Without Spaces] - Added [X] models
- Imports: [Alias used]
- Env: Vercel Postgres created

Tests Passed:
- ✅ Compilation
- ✅ Database connection
- ✅ Auth (401 on unauth)
- ✅ Create trace
- ✅ Retrieve trace
- ✅ Append step
- ✅ List traces

Deployment:
- URL: https://your-app.vercel.app/api/traces
- Status: ✅ Live and tested

Next Steps:
- Configure agents to use: https://your-app.vercel.app/api
- Update documentation
- Monitor trace logs
```

---

**Last Updated**: 2026-05-12  
**Version**: 1.0.0
