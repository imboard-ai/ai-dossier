import type { VercelRequest, VercelResponse } from '@vercel/node';

export type { VercelRequest, VercelResponse };

export interface JwtPayload {
  sub: string;
  email: string | null;
  orgs: string[];
  iat?: number;
  exp?: number;
}

export interface NamespaceValidation {
  valid: boolean;
  error: string | null;
}

export interface DossierValidation {
  valid: boolean;
  errors: string[];
}

export interface PublishPermission {
  allowed: boolean;
  reason: string;
}

export interface FileContent {
  content: string;
  sha: string;
}

export interface ManifestDossier {
  name: string;
  title: string;
  version: string;
  path: string;
  description?: string | null;
  category?: string[] | null;
  tags?: string[];
  authors?: unknown[];
  tools_required?: unknown[];
  [key: string]: unknown;
}

export interface Manifest {
  dossiers: ManifestDossier[];
  sha: string | null;
}

export interface DeleteResult {
  found: boolean;
  version?: string | null;
  versionMismatch?: boolean;
  currentVersion?: string;
  requestedVersion?: string;
  file?: unknown;
  manifest?: unknown;
}
