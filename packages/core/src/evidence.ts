import evidenceSchema from './schema/evidence-schema.json';
import type { DossierFrontmatter } from './types';
import { compileSchema } from './utils/ajv';
import { getErrorMessage } from './utils/errors';

/** Must stay in sync with evidence-schema.json's `evidence_schema_version` const. */
export const EVIDENCE_SCHEMA_VERSION = '1.0.0';
/** Parse-time size guard for a sidecar file, ahead of JSON.parse and schema validation. */
export const EVIDENCE_MAX_BYTES = 256 * 1024;
/** Must stay in sync with evidence-schema.json's `entries.items.properties.rationale.maxLength`. */
export const EVIDENCE_MAX_RATIONALE_CHARS = 500;

export interface EvidenceRef {
  provider: 'claude-code' | 'codex' | 'opencode' | 'gemini-cli' | 'other';
  session: string;
  event?: string;
  host?: string;
  extra?: Record<string, string>;
}

export interface EvidenceEntry {
  anchor: string;
  rationale: string;
  created_at: string;
  evidence: EvidenceRef[];
}

export interface EvidenceRecord {
  evidence_schema_version: string;
  dossier: string;
  version: string;
  checksum: {
    algorithm: 'sha256';
    hash: string;
  };
  entries: EvidenceEntry[];
}

const validate = compileSchema<EvidenceRecord>(evidenceSchema);

export function validateEvidence(value: unknown): string[] {
  const valid = validate(value);
  if (valid) {
    return [];
  }

  return (validate.errors || []).map((err) => `${err.instancePath} ${err.message}`.trim());
}

export function parseEvidence(json: string): EvidenceRecord {
  if (Buffer.byteLength(json, 'utf8') > EVIDENCE_MAX_BYTES) {
    throw new Error(`Evidence record exceeds maximum size of ${EVIDENCE_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse evidence record JSON: ${getErrorMessage(err)}`);
  }

  const errors = validateEvidence(parsed);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  return parsed as EvidenceRecord;
}

export function createEvidenceRecord(input: {
  dossier: string;
  version: string;
  checksumHash: string;
}): EvidenceRecord {
  return {
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    dossier: input.dossier,
    version: input.version,
    checksum: {
      algorithm: 'sha256',
      hash: input.checksumHash,
    },
    entries: [],
  };
}

export function evidenceMatchesDossier(
  record: EvidenceRecord,
  frontmatter: Pick<DossierFrontmatter, 'version' | 'checksum'>,
  fullName: string
): string[] {
  if (!frontmatter.checksum?.hash) {
    return ['dossier has no checksum; sign or run checksum --update before attaching evidence'];
  }

  if (!record.checksum?.hash) {
    return ['evidence record has no checksum; parse it with parseEvidence before comparing'];
  }

  const messages: string[] = [];

  if (record.dossier !== fullName) {
    messages.push(`evidence record dossier "${record.dossier}" does not match "${fullName}"`);
  }

  if (record.version !== frontmatter.version) {
    messages.push(
      `evidence record version "${record.version}" does not match dossier version "${frontmatter.version}"`
    );
  }

  if (record.checksum.hash !== frontmatter.checksum.hash) {
    messages.push(
      `evidence record checksum "${record.checksum.hash}" does not match dossier checksum "${frontmatter.checksum.hash}"`
    );
  }

  return messages;
}
