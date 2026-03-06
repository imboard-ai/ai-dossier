import type { VercelRequest, VercelResponse } from '@vercel/node';

export type { VercelRequest, VercelResponse };

export interface JwtPayload {
  sub: string;
  email: string | null;
  orgs: string[];
  iat?: number;
  exp?: number;
}

export type NamespaceValidation = { valid: true; error: null } | { valid: false; error: string };

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

export interface GitHubCommitResponse {
  content: { name: string; path: string; sha: string } | null;
  commit: { sha: string; message: string };
}

export interface DeleteResult {
  found: boolean;
  version?: string | null;
  versionMismatch?: boolean;
  currentVersion?: string;
  requestedVersion?: string;
  file?: GitHubCommitResponse;
  manifest?: GitHubCommitResponse;
}
