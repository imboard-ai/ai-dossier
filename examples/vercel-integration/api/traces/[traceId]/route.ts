// app/api/traces/[traceId]/route.ts
// Dossier Tracing API - Get and Update Trace
//
// GET    /api/traces/:traceId  - Get full trace with steps
// PATCH  /api/traces/:traceId  - Update trace (complete, add validation, etc.)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

/**
 * GET /api/traces/:traceId
 * Retrieve a complete execution trace with all steps
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    // Authenticate user
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
        {
          error: 'not_found',
          message: 'Trace not found',
          trace_id: params.traceId,
        },
        { status: 404 }
      );
    }

    // Reconstruct full trace (merge base data + steps)
    const fullTrace = {
      ...(trace.data as any), // Full trace data from JSON column
      steps: trace.steps.map(step => step.data), // Steps from separate table
    };

    return NextResponse.json(fullTrace);
  } catch (error: any) {
    console.error('Error getting trace:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to get trace',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/traces/:traceId
 * Update an existing trace (mark complete, add validation results, etc.)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    // Authenticate user
    const { userId } = await authenticate(req);

    // Parse updates
    const updates = await req.json();

    // Get existing trace (enforce user owns it)
    const existing = await prisma.trace.findFirst({
      where: {
        traceId: params.traceId,
        userId,
      },
    });

    if (!existing) {
      return NextResponse.json(
        {
          error: 'not_found',
          message: 'Trace not found',
          trace_id: params.traceId,
        },
        { status: 404 }
      );
    }

    // Merge updates with existing data
    const updatedData = {
      ...(existing.data as any),
      ...updates,
    };

    // If steps are being added in bulk, store them separately
    if (updates.steps && Array.isArray(updates.steps)) {
      // Get current step count
      const currentStepCount = await prisma.traceStep.count({
        where: { traceId: existing.id },
      });

      // Insert new steps
      await Promise.all(
        updates.steps.map(async (step: any, index: number) => {
          return prisma.traceStep.create({
            data: {
              traceId: existing.id,
              stepId: step.step_id,
              stepNumber: currentStepCount + index + 1,
              timestamp: new Date(step.timestamp || new Date()),
              type: step.type,
              data: step,
            },
          });
        })
      );

      // Remove steps from updatedData (stored separately)
      delete updatedData.steps;
    }

    // Update trace
    await prisma.trace.update({
      where: { id: existing.id },
      data: {
        // Update searchable fields if changed
        ...(updates.status && { status: updates.status }),
        ...(updates.completed_at && { completedAt: new Date(updates.completed_at) }),
        ...(updates.duration_ms && { durationMs: updates.duration_ms }),

        // Update full data JSON
        data: updatedData,

        // Timestamp
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      trace_id: params.traceId,
      updated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error updating trace:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to update trace',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/traces/:traceId
 * Delete a trace (for data retention compliance)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    // Authenticate user
    const { userId } = await authenticate(req);

    // Delete trace (enforce user owns it)
    const result = await prisma.trace.deleteMany({
      where: {
        traceId: params.traceId,
        userId, // Security: only allow deleting own traces
      },
    });

    if (result.count === 0) {
      return NextResponse.json(
        {
          error: 'not_found',
          message: 'Trace not found',
          trace_id: params.traceId,
        },
        { status: 404 }
      );
    }

    // Return 204 No Content
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    console.error('Error deleting trace:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to delete trace',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
