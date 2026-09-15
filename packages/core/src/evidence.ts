import Ajv from 'ajv';
import evidenceSchema from './schema/evidence-schema.json';

export const EVIDENCE_SCHEMA_VERSION = '1.0.0';
export const EVIDENCE_MAX_BYTES = 256 * 1024;
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

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(evidenceSchema);

export function validateEvidence(value: unknown): string[] {
  const valid = validate(value);
  if (valid) {
    return [];
  }

  return (validate.errors || []).map((err) => `${err.instancePath} ${err.message}`.trim());
}

export function parseEvidence(json: string): EvidenceRecord {
  if (json.length > EVIDENCE_MAX_BYTES) {
    throw new Error(`Evidence record exceeds maximum size of ${EVIDENCE_MAX_BYTES} bytes`);
  }

  const parsed = JSON.parse(json);
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
  frontmatter: { version?: string; checksum?: { hash?: string } },
  fullName: string
): string[] {
  if (!frontmatter.checksum?.hash) {
    return ['dossier has no checksum; sign or run checksum --update before attaching evidence'];
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
