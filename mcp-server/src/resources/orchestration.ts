/**
 * dossier://orchestration resource
 * Provides the orchestration tool reference to LLM context
 */

import { createResourceLoader } from '../utils/resourceLoader';

/** Get ORCHESTRATION.md content */
export const getOrchestrationResource = createResourceLoader('ORCHESTRATION.md', 'orchestration');
