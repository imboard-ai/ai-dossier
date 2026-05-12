// app/api/traces/[traceId]/steps/route.ts
// Dossier Tracing API - Append Step
//
// POST /api/traces/:traceId/steps  - Append a single execution step (real-time logging)

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';

/**
 * POST /api/traces/:traceId/steps
 * Append a single execution step to a trace (for real-time logging)
 *
 * This is called frequently during Dossier execution to log each step as it happens.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    // Authenticate user
    const { userId } = await authenticate(req);

    // Parse step data
    const step = await req.json();

    // Validate required fields
    if (!step.step_id || !step.type) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: 'Missing required fields: step_id, type',
        },
        { status: 400 }
      );
    }

    // Verify trace exists and user owns it
    const trace = await prisma.trace.findFirst({
      where: {
        traceId: params.traceId,
        userId, // Security: only allow appending to own traces
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

    // Get next step number
    const lastStep = await prisma.traceStep.findFirst({
      where: { traceId: trace.id },
      orderBy: { stepNumber: 'desc' },
      select: { stepNumber: true },
    });

    const stepNumber = (lastStep?.stepNumber || 0) + 1;

    // Create step
    const createdStep = await prisma.traceStep.create({
      data: {
        traceId: trace.id,
        stepId: step.step_id,
        stepNumber,
        timestamp: new Date(step.timestamp || new Date()),
        type: step.type,
        data: step, // Store full step as JSON
      },
    });

    return NextResponse.json(
      {
        trace_id: params.traceId,
        step_id: step.step_id,
        step_number: stepNumber,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error('Error appending step:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to append step',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/traces/:traceId/steps
 * Get all steps for a trace (optional - steps are included in GET /traces/:traceId)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    // Authenticate user
    const { userId } = await authenticate(req);

    // Verify trace exists and user owns it
    const trace = await prisma.trace.findFirst({
      where: {
        traceId: params.traceId,
        userId,
      },
      select: { id: true },
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

    // Get all steps
    const steps = await prisma.traceStep.findMany({
      where: { traceId: trace.id },
      orderBy: { stepNumber: 'asc' },
    });

    return NextResponse.json({
      trace_id: params.traceId,
      steps: steps.map(step => step.data),
    });
  } catch (error: any) {
    console.error('Error getting steps:', error);

    if (error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'Failed to get steps',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
