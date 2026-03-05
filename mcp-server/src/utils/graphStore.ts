/**
 * In-memory store for resolved execution plans.
 * Allows verify_graph to reference a previously resolved graph by ID.
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionPlan } from '../orchestration/types';

const store = new Map<string, ExecutionPlan>();

export function generateGraphId(): string {
  return randomUUID();
}

export function storeGraph(id: string, plan: ExecutionPlan): void {
  store.set(id, plan);
}

export function getGraph(id: string): ExecutionPlan | undefined {
  return store.get(id);
}
