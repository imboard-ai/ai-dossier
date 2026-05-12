# Vercel Integration Example for Dossier Tracing

Complete working example of integrating Dossier Tracing into your existing Vercel/Next.js app.

## Overview

This example shows how to add execution tracing to your Vercel backend, reusing your existing:
- ✅ User authentication
- ✅ User spaces/tenants
- ✅ Database
- ✅ API routes

**Result**: Users get tracing in their claimed space alongside their Dossiers.

---

## Database Setup

**Default: Vercel Postgres** (Serverless PostgreSQL, native Vercel integration)

### Quick Setup (2 minutes)

```bash
# 1. Create database (via Vercel dashboard or CLI)
vercel storage create postgres dossier-traces

# 2. Pull environment variables
vercel env pull .env.local
# This automatically adds:
#   POSTGRES_URL
#   POSTGRES_PRISMA_URL
#   POSTGRES_URL_NON_POOLING

# 3. Install Prisma (if not already installed)
npm install prisma @prisma/client

# 4. Initialize Prisma (if new project)
npx prisma init

# 5. Update prisma/schema.prisma datasource:
datasource db {
  provider = "postgresql"
  url      = env("POSTGRES_PRISMA_URL")
  directUrl = env("POSTGRES_URL_NON_POOLING")
}

# 6. Add trace models (copy from prisma/schema.prisma in this directory)

# 7. Run migration
npx prisma migrate dev --name add-dossier-tracing
npx prisma generate
```

**Done!** Your Vercel app now has a PostgreSQL database with trace tables.

### Why Vercel Postgres?

✅ **One-click setup** in Vercel dashboard  
✅ **JSONB support** for storing full traces  
✅ **Serverless** - scales automatically, pay per usage  
✅ **Free tier**: 512 MB storage, 1 GB bandwidth/month  
✅ **Team-friendly** - shared with your Vercel project  

**Storage estimate**:
- 512 MB = ~10,000-50,000 traces (depending on step count)
- With 90-day retention, free tier handles most teams

---

## Alternative Databases

<details>
<summary><strong>Option 2: Supabase</strong> (Better free tier, realtime features)</summary>

**Why**: PostgreSQL + auth + realtime, 500 MB free storage

**Setup**:
```bash
# 1. Create project at supabase.com
# 2. Get connection string from Settings → Database

# .env.local
DATABASE_URL="postgresql://postgres:[password]@[project-ref].supabase.co:5432/postgres"

# 3. Install
npm install @supabase/supabase-js prisma @prisma/client

# 4. Run migration
npx prisma migrate dev --name add-tracing
```

**When to use**: If you want realtime trace updates or better free tier.

</details>

<details>
<summary><strong>Option 3: Neon</strong> (Serverless PostgreSQL, 3 GB free)</summary>

**Why**: Generous free tier (3 GB), database branching

**Setup**:
```bash
# 1. Create project at neon.tech
# 2. Get connection string

# .env.local
DATABASE_URL="postgresql://..."

# 3. Run migration
npx prisma migrate dev --name add-tracing
```

**When to use**: If you need more free storage or branching features.

</details>

<details>
<summary><strong>Option 4: Direct SQL</strong> (No ORM)</summary>

**Why**: Simplest, no Prisma overhead

```typescript
// lib/db.ts
import { sql } from '@vercel/postgres';

export async function createTrace(trace: any) {
  const result = await sql`
    INSERT INTO traces (trace_id, user_id, space_id, dossier_title, started_at, status, data)
    VALUES (${trace.trace_id}, ${trace.userId}, ${trace.spaceId}, 
            ${trace.dossier.title}, ${trace.started_at}, ${trace.status}, 
            ${JSON.stringify(trace)}::jsonb)
    RETURNING *
  `;
  return result.rows[0];
}
```

**When to use**: If you prefer raw SQL over Prisma.

</details>

---

## Project Structure

```
your-vercel-app/
├── prisma/
│   └── schema.prisma          # Add Trace models here
├── lib/
│   ├── auth.ts                # Your existing auth
│   └── db.ts                  # Database helpers
├── app/api/                   # Next.js App Router
│   └── traces/
│       ├── route.ts           # POST /api/traces, GET /api/traces
│       ├── [traceId]/
│       │   └── route.ts       # GET /api/traces/[id]
│       └── [traceId]/steps/
│           └── route.ts       # POST /api/traces/[id]/steps
└── .env.local                 # Database URL
```

---

## Implementation

### 1. Database Schema

See [`prisma/schema.prisma`](./prisma/schema.prisma) for complete schema.

**Key tables**:
- `Trace`: Main trace record (linked to user/space)
- `TraceStep`: Individual execution steps

**Migration**:
```bash
npx prisma migrate dev --name add-tracing
npx prisma generate
```

### 2. Authentication Middleware

Reuse your existing auth:

```typescript
// lib/auth.ts
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session'; // Your existing auth

export async function authenticate(req: NextRequest) {
  const session = await getSession(req);
  
  if (!session?.user) {
    throw new Error('Unauthorized');
  }
  
  return {
    userId: session.user.id,
    spaceId: session.user.claimedSpace.id, // Your existing space
    user: session.user
  };
}
```

### 3. API Routes

#### Create Trace: `POST /api/traces`

```typescript
// app/api/traces/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  try {
    const { userId, spaceId } = await authenticate(req);
    const trace = await req.json();
    
    // Validate trace (optional)
    // validateTrace(trace); // Using Ajv + trace-schema.json
    
    // Store trace in user's space
    const result = await prisma.trace.create({
      data: {
        traceId: trace.trace_id,
        userId,
        spaceId,
        dossierTitle: trace.dossier.title,
        dossierVersion: trace.dossier.version,
        agentName: trace.agent?.name,
        agentVersion: trace.agent?.version,
        startedAt: new Date(trace.started_at),
        status: trace.status,
        data: trace, // Store full trace as JSON
      },
    });
    
    return NextResponse.json({
      trace_id: result.traceId,
      created_at: result.createdAt.toISOString(),
      url: `/api/traces/${result.traceId}`,
    }, { status: 201 });
  } catch (error) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'internal_error', message: error.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { userId, spaceId } = await authenticate(req);
    const { searchParams } = new URL(req.url);
    
    // Parse filters
    const dossier = searchParams.get('dossier');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    
    // Query traces in user's space
    const traces = await prisma.trace.findMany({
      where: {
        userId,
        spaceId,
        ...(dossier && { dossierTitle: dossier }),
        ...(status && { status }),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        traceId: true,
        dossierTitle: true,
        dossierVersion: true,
        agentName: true,
        startedAt: true,
        completedAt: true,
        status: true,
        durationMs: true,
      },
    });
    
    const total = await prisma.trace.count({
      where: { userId, spaceId },
    });
    
    return NextResponse.json({
      traces,
      pagination: {
        total,
        limit,
        offset,
        next: offset + limit < total ? `/api/traces?offset=${offset + limit}&limit=${limit}` : null,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

#### Get Trace: `GET /api/traces/[traceId]`

```typescript
// app/api/traces/[traceId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    const { userId } = await authenticate(req);
    
    // Get trace (enforce user owns it)
    const trace = await prisma.trace.findFirst({
      where: {
        traceId: params.traceId,
        userId, // Security: only show user's own traces
      },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
        },
      },
    });
    
    if (!trace) {
      return NextResponse.json(
        { error: 'not_found', message: 'Trace not found' },
        { status: 404 }
      );
    }
    
    // Return full trace data with steps
    const fullTrace = {
      ...trace.data, // Full trace JSON
      steps: trace.steps.map(s => s.data), // Merge steps from separate table
    };
    
    return NextResponse.json(fullTrace);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    const { userId } = await authenticate(req);
    const updates = await req.json();
    
    // Get existing trace
    const existing = await prisma.trace.findFirst({
      where: { traceId: params.traceId, userId },
    });
    
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    
    // Merge updates
    const updated = { ...existing.data, ...updates };
    
    // Update trace
    await prisma.trace.update({
      where: { id: existing.id },
      data: {
        status: updates.status || existing.status,
        completedAt: updates.completed_at ? new Date(updates.completed_at) : existing.completedAt,
        durationMs: updates.duration_ms || existing.durationMs,
        data: updated,
      },
    });
    
    return NextResponse.json({
      trace_id: params.traceId,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

#### Append Step: `POST /api/traces/[traceId]/steps`

```typescript
// app/api/traces/[traceId]/steps/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    const { userId } = await authenticate(req);
    const step = await req.json();
    
    // Verify trace exists and user owns it
    const trace = await prisma.trace.findFirst({
      where: { traceId: params.traceId, userId },
    });
    
    if (!trace) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    
    // Get next step number
    const lastStep = await prisma.traceStep.findFirst({
      where: { traceId: trace.id },
      orderBy: { stepNumber: 'desc' },
    });
    const stepNumber = (lastStep?.stepNumber || 0) + 1;
    
    // Create step
    await prisma.traceStep.create({
      data: {
        traceId: trace.id,
        stepId: step.step_id,
        stepNumber,
        timestamp: new Date(step.timestamp || new Date()),
        type: step.type,
        data: step,
      },
    });
    
    return NextResponse.json({
      trace_id: params.traceId,
      step_id: step.step_id,
      step_number: stepNumber,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

---

## Client Configuration

Users configure their agent to use your Vercel backend:

```bash
# User's .env (or agent config)
export TRACE_MODE=saas
export TRACE_SERVER_URL=https://your-app.vercel.app/api
export TRACE_API_KEY=<user-auth-token>  # From your login
```

**Authentication**: Use existing session token/JWT from your auth system.

---

## Testing

### 1. Create a Trace

```bash
curl -X POST https://your-app.vercel.app/api/traces \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "dossier": {
      "title": "Deploy to AWS",
      "version": "1.0.0"
    },
    "agent": {
      "name": "Claude Code",
      "version": "claude-sonnet-4-6"
    },
    "started_at": "2026-05-12T10:30:00Z",
    "status": "running"
  }'
```

### 2. Append a Step

```bash
curl -X POST https://your-app.vercel.app/api/traces/550e8400-e29b-41d4-a716-446655440000/steps \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "step_id": "step_001",
    "type": "action",
    "description": "Deploying infrastructure",
    "action": {"type": "command", "command": "terraform apply"},
    "result": {"status": "success"}
  }'
```

### 3. Get Traces

```bash
curl https://your-app.vercel.app/api/traces \
  -H "Authorization: Bearer $USER_TOKEN"
```

---

## UI Integration (Optional)

Add trace viewing to your existing UI:

```tsx
// app/[space]/traces/page.tsx
'use client';

import { useEffect, useState } from 'react';

export default function TracesPage() {
  const [traces, setTraces] = useState([]);
  
  useEffect(() => {
    fetch('/api/traces')
      .then(res => res.json())
      .then(data => setTraces(data.traces));
  }, []);
  
  return (
    <div>
      <h1>Execution Traces</h1>
      {traces.map(trace => (
        <div key={trace.traceId}>
          <h3>{trace.dossierTitle} v{trace.dossierVersion}</h3>
          <p>Status: {trace.status}</p>
          <p>Started: {new Date(trace.startedAt).toLocaleString()}</p>
          <a href={`/traces/${trace.traceId}`}>View Details</a>
        </div>
      ))}
    </div>
  );
}
```

---

## Benefits of This Approach

✅ **Reuse Existing Infrastructure**: No new deployments
✅ **Unified Experience**: Traces in same UI as Dossiers
✅ **Existing Auth**: Leverages your login system
✅ **Tenant Isolation**: Uses your claimed spaces model
✅ **Easy Onboarding**: Users just configure URL + token

---

## Comparison: Vercel vs Self-Hosted

| Feature | Vercel Integration | Self-Hosted Server |
|---------|-------------------|-------------------|
| **Deployment** | No extra deployment | Deploy trace server |
| **Auth** | Reuse existing | Separate API keys |
| **Database** | Reuse existing | Separate database |
| **UI** | Integrate with app | Separate dashboard |
| **Privacy** | Vercel-hosted | Customer-hosted |
| **For** | 95% of users | Enterprise/on-prem |

**Recommendation**: Start with Vercel integration. Add self-hosted option for enterprise customers later.

---

## Next Steps

1. **Copy schema** to your `prisma/schema.prisma`
2. **Run migration**: `npx prisma migrate dev --name add-tracing`
3. **Copy API routes** to your `app/api/traces/` directory
4. **Update auth** to use your existing middleware
5. **Test** with curl or your agent
6. **Add UI** to show traces in your app

---

## Complete Files

- [`prisma/schema.prisma`](./prisma/schema.prisma) - Database schema
- [`api/traces/route.ts`](./api/traces/route.ts) - Create/list traces
- [`api/traces/[traceId]/route.ts`](./api/traces/[traceId]/route.ts) - Get/update trace
- [`api/traces/[traceId]/steps/route.ts`](./api/traces/[traceId]/steps/route.ts) - Append steps

---

**Version**: 1.0.0  
**Last Updated**: 2026-05-12
