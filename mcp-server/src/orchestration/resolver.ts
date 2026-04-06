/**
 * Dossier reference resolver.
 * Resolves dossier names to their metadata by:
 *   1. Local file lookup (*.ds.md in project)
 *   2. Registry lookup via `ai-dossier get --json <name>`
 * Caches resolved dossiers for the lifetime of a resolution run.
 */

import { resolve } from 'node:path';
import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';
import type {
  DossierNode,
  DossierRelationships,
  FromDossierDeclaration,
  OutputConfigItem,
  ResolvedDossier,
} from './types';

interface ListItem {
  path: string;
  name?: string;
  title?: string;
  version?: string;
  risk_level?: string;
  riskLevel?: string;
  status?: string;
  relationships?: DossierRelationships;
  [key: string]: unknown;
}

interface InfoResult {
  name?: string;
  title?: string;
  version?: string;
  risk_level?: string;
  riskLevel?: string;
  status?: string;
  relationships?: DossierRelationships;
  [key: string]: unknown;
}

export class ResolveError extends Error {
  constructor(
    public readonly dossierName: string,
    message: string
  ) {
    super(`Failed to resolve "${dossierName}": ${message}`);
    this.name = 'ResolveError';
  }
}

export class DossierResolver {
  private cache = new Map<string, ResolvedDossier>();
  private localIndex: Map<string, ListItem> | null = null;

  constructor(private readonly basePath: string = process.cwd()) {}

  /**
   * Resolve a dossier reference by name.
   * Tries local files first, then falls back to the registry.
   */
  async resolve(name: string): Promise<ResolvedDossier> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    // Try local resolution first
    const local = await this.resolveLocal(name);
    if (local) {
      this.cache.set(name, local);
      return local;
    }

    // Fall back to registry
    const registry = await this.resolveFromRegistry(name);
    if (registry) {
      this.cache.set(name, registry);
      return registry;
    }

    throw new ResolveError(name, 'Not found locally or in registry');
  }

  /**
   * Resolve a dossier from a local file path (for the entry dossier).
   */
  async resolveFromPath(filePath: string): Promise<ResolvedDossier> {
    const resolvedPath = resolve(filePath);

    logger.info('Resolving dossier from path', { path: resolvedPath });

    try {
      const metadata = await execCli<InfoResult>('info', [resolvedPath, '--json']);
      const name =
        metadata.name || resolvedPath.split('/').pop()?.replace('.ds.md', '') || filePath;

      const resolved: ResolvedDossier = {
        name,
        source: 'local',
        path: resolvedPath,
        metadata: metadata as Record<string, unknown>,
        relationships: metadata.relationships,
      };

      this.cache.set(name, resolved);
      return resolved;
    } catch (error) {
      if (error instanceof CliNotFoundError) {
        throw new Error(error.message);
      }
      throw new ResolveError(filePath, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Recursively resolve all dossiers in the dependency graph
   * starting from an entry dossier.
   */
  async resolveGraph(entryDossier: ResolvedDossier): Promise<Map<string, DossierNode>> {
    const nodes = new Map<string, DossierNode>();
    const queue: ResolvedDossier[] = [entryDossier];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.name)) continue;
      visited.add(current.name);

      const inputsMeta = current.metadata.inputs as Record<string, unknown> | undefined;
      const outputsMeta = current.metadata.outputs as Record<string, unknown> | undefined;

      const rawFromDossiers = inputsMeta?.from_dossiers;
      const fromDossiers = Array.isArray(rawFromDossiers)
        ? (rawFromDossiers.filter(
            (d): d is FromDossierDeclaration =>
              d != null &&
              typeof d === 'object' &&
              typeof (d as Record<string, unknown>).source_dossier === 'string' &&
              typeof (d as Record<string, unknown>).output_name === 'string'
          ) as FromDossierDeclaration[])
        : undefined;

      const rawOutputConfig = outputsMeta?.configuration;
      const outputConfig = Array.isArray(rawOutputConfig)
        ? (rawOutputConfig.filter(
            (c): c is OutputConfigItem =>
              c != null &&
              typeof c === 'object' &&
              typeof (c as Record<string, unknown>).key === 'string' &&
              typeof (c as Record<string, unknown>).description === 'string'
          ) as OutputConfigItem[])
        : undefined;

      if (
        rawFromDossiers &&
        !fromDossiers?.length &&
        Array.isArray(rawFromDossiers) &&
        rawFromDossiers.length > 0
      ) {
        logger.warn('Dossier has malformed from_dossiers declarations — skipped', {
          dossier: current.name,
        });
      }

      nodes.set(current.name, {
        name: current.name,
        source: current.source,
        path: current.path,
        riskLevel:
          (current.metadata.risk_level as string) ?? (current.metadata.riskLevel as string),
        status: current.metadata.status as string,
        relationships: current.relationships,
        fromDossiers,
        outputConfig,
      });

      // Queue all referenced dossiers for resolution
      const refs = this.collectReferences(current.relationships);
      for (const ref of refs) {
        if (visited.has(ref)) continue;
        try {
          const resolved = await this.resolve(ref);
          queue.push(resolved);
        } catch (error) {
          logger.warn('Could not resolve referenced dossier', {
            dossier: ref,
            from: current.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return nodes;
  }

  private collectReferences(relationships?: DossierRelationships): string[] {
    if (!relationships) return [];

    const refs = new Set<string>();

    for (const dep of relationships.preceded_by ?? []) {
      refs.add(dep.dossier);
    }
    for (const dep of relationships.followed_by ?? []) {
      refs.add(dep.dossier);
    }
    for (const dep of relationships.conflicts_with ?? []) {
      refs.add(dep.dossier);
    }
    for (const name of relationships.can_run_parallel_with ?? []) {
      refs.add(name);
    }

    return [...refs];
  }

  /**
   * Build a local index of dossiers by scanning the base path.
   */
  private async buildLocalIndex(): Promise<Map<string, ListItem>> {
    if (this.localIndex) return this.localIndex;

    try {
      const result = await execCli<ListItem[]>('list', [
        this.basePath,
        '--format',
        'json',
        '--recursive',
      ]);

      this.localIndex = new Map<string, ListItem>();
      for (const item of result) {
        // Index by name field if available, otherwise by filename
        const name = item.name || item.path.split('/').pop()?.replace('.ds.md', '') || item.path;
        this.localIndex.set(name, item);
      }

      return this.localIndex;
    } catch {
      this.localIndex = new Map();
      return this.localIndex;
    }
  }

  private async resolveLocal(name: string): Promise<ResolvedDossier | null> {
    const index = await this.buildLocalIndex();
    const item = index.get(name);
    if (!item) return null;

    logger.info('Resolved dossier locally', { name, path: item.path });

    // Get full metadata including relationships
    try {
      const metadata = await execCli<InfoResult>('info', [item.path, '--json']);

      return {
        name,
        source: 'local',
        path: item.path,
        metadata: metadata as Record<string, unknown>,
        relationships: metadata.relationships,
      };
    } catch {
      // Fallback to list item data
      return {
        name,
        source: 'local',
        path: item.path,
        metadata: item as Record<string, unknown>,
        relationships: item.relationships,
      };
    }
  }

  private async resolveFromRegistry(name: string): Promise<ResolvedDossier | null> {
    logger.info('Attempting registry resolution', { name });

    try {
      const metadata = await execCli<InfoResult>('get', [name, '--json']);

      return {
        name,
        source: 'registry',
        metadata: metadata as Record<string, unknown>,
        relationships: metadata.relationships,
      };
    } catch {
      return null;
    }
  }
}
