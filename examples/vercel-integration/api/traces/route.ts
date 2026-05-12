// app/api/traces/route.ts
// Dossier Tracing API - Create and List Traces
//
// POST   /api/traces       - Create new trace
// GET    /api/traces       - List user's traces (with filters)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

/**
 * POST /api/traces
 * Create a new execution trace in user's space
 */
export async function POST(req: NextRequest) {
  try {
    // Authenticate user (reuse your existing auth)
    const { userId, spaceId, user } = await authenticate(req);

    // Parse trace data
    const trace = await req.json();

    // Validate required fields
    if (!trace.trace_id || !trace.dossier || !trace.started_at || !trace.status) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: 'Missing required fields: trace_id, dossier, started_at, status',
        },
        { status: 400 }
      );
    }

    // Check if trace already exists
    const existing = await prisma.trace.findUnique({
      where: { traceId: trace.trace_id },
    });

    if (existing) {
      return NextResponse.json(
        {
          error: 'conflict',
          message: 'Trace already exists',
          trace_id: trace.trace_id,
        },
        { status: 409 }
      );
    }

    // Create trace in user's space
    const result = await prisma.trace.create({
      data: {
        traceId: trace.trace_id,
        userId,
        spaceId,

        // Extract searchable fields
        dossierTitle: trace.dossier.title,
        dossierVersion: trace.dossier.version,
        agentName: trace.agent?.name,
        agentVersion: trace.agent?.version,

        startedAt: new Date(trace.started_at),
        completedAt: trace.completed_at ? new Date(trace.completed_at) : null,
        durationMs: trace.duration_ms || null,
        status: trace.status,

        // Store full trace as JSON (conforms to trace-schema.json)
        data: trace,
      },
    });

    return NextResponse.json(
      {
        trace_id: result.traceId,
        created_at: result.createdAt.toISOString(),
        url: `/api/traces/${result.traceId}`,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error('Error creating trace:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to create trace',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/traces
 * List execution traces for authenticated user
 *
 * Query parameters:
 *   - dossier: Filter by Dossier title
 *   - status: Filter by status (running, success, failed, cancelled)
 *   - from: Start date (ISO 8601)
 *   - to: End date (ISO 8601)
 *   - limit: Results per page (default: 50, max: 200)
 *   - offset: Pagination offset (default: 0)
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate user
    const { userId, spaceId } = await authenticate(req);

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const dossier = searchParams.get('dossier');
    const status = searchParams.get('status');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build where clause
    const where: any = {
      userId,
      spaceId, // Enforce user can only see their space's traces
    };

    if (dossier) {
      where.dossierTitle = dossier;
    }

    if (status) {
      where.status = status;
    }

    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    // Query traces
    const [traces, total] = await Promise.all([
      prisma.trace.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          traceId: true,
          dossierTitle: true,
          dossierVersion: true,
          agentName: true,
          agentVersion: true,
          startedAt: true,
          completedAt: true,
          status: true,
          durationMs: true,
        },
      }),
      prisma.trace.count({ where }),
    ]);

    // Format response
    const nextOffset = offset + limit;
    const hasMore = nextOffset < total;

    return NextResponse.json({
      traces: traces.map(t => ({
        trace_id: t.traceId,
        dossier: {
          title: t.dossierTitle,
          version: t.dossierVersion,
        },
        agent: t.agentName ? {
          name: t.agentName,
          version: t.agentVersion,
        } : undefined,
        started_at: t.startedAt.toISOString(),
        completed_at: t.completedAt?.toISOString(),
        status: t.status,
        duration_ms: t.durationMs,
      })),
      pagination: {
        total,
        limit,
        offset,
        next: hasMore ? `/api/traces?offset=${nextOffset}&limit=${limit}` : null,
      },
    });
  } catch (error: any) {
    console.error('Error listing traces:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to list traces',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
