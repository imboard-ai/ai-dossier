/**
 * TypeScript type definitions for Dossier format
 */

export type DossierStatus = 'Draft' | 'Stable' | 'Deprecated' | 'Experimental';

export type ContentScope = 'self-contained' | 'references-external';

export type ExternalReferenceType =
  | 'download'
  | 'api'
  | 'documentation'
  | 'script'
  | 'config'
  | 'image'
  | 'dossier'
  | 'other';

export type ExternalTrustLevel = 'trusted' | 'user-verified' | 'unknown';

export interface ExternalReference {
  url: string;
  description: string;
  type: ExternalReferenceType;
  trust_level: ExternalTrustLevel;
  required: boolean;
}

export interface ToolRequired {
  name: string;
  version?: string;
  check_command?: string;
  install_url?: string;
}

export interface DossierAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface DossierFrontmatter {
  dossier_schema_version?: string;
  name?: string;
  title: string;
  version: string;
  protocol_version?: string;
  created?: string;
  updated?: string;
  last_updated?: string;
  objective?: string;
  status?: DossierStatus;
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  risk_factors?: string[];
  destructive_operations?: string[];
  content_scope?: ContentScope;
  external_references?: ExternalReference[];
  tools_required?: ToolRequired[];
  authors?: DossierAuthor[];
  requires_approval?: boolean;
  checksum?: {
    algorithm: string;
    hash: string;
    calculated_at?: string;
  };
  signature?: {
    algorithm: string;
    signature: string;
    public_key?: string;
    key_id?: string;
    signed_by?: string;
    signed_at?: string;
  };
  [key: string]: unknown; // Allow additional fields
}

export interface ParsedDossier {
  frontmatter: DossierFrontmatter;
  body: string;
  raw: string;
}

export interface IntegrityResult {
  status: 'valid' | 'invalid' | 'missing';
  message: string;
  expectedHash?: string;
  actualHash?: string;
}

export interface AuthenticityResult {
  status: 'verified' | 'signed_unknown' | 'unsigned' | 'invalid' | 'error';
  message: string;
  signer?: string;
  keyId?: string;
  publicKey?: string;
  isTrusted: boolean;
  trustedAs?: string;
}

export interface RiskAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskFactors: string[];
  destructiveOperations: string[];
  requiresApproval: boolean;
}

export interface VerificationResult {
  dossierFile: string;
  integrity: IntegrityResult;
  authenticity: AuthenticityResult;
  riskAssessment: RiskAssessment;
  recommendation: 'ALLOW' | 'WARN' | 'BLOCK';
  message: string;
  errors: string[];
}

export interface TrustedKey {
  publicKey: string;
  keyId: string;
}

export interface DossierListItem {
  name: string;
  path: string;
  version: string;
  protocol: string;
  status: string;
  objective: string;
  riskLevel: string;
}
