import { describe, expect, it } from 'vitest';
import {
  createEvidenceRecord,
  EVIDENCE_MAX_BYTES,
  type EvidenceRecord,
  evidenceMatchesDossier,
  parseEvidence,
  validateEvidence,
} from '../evidence';

function validRecord(): EvidenceRecord {
  return {
    evidence_schema_version: '1.0.0',
    dossier: 'imboard-ai/git/full-cycle-issue',
    version: '3.8.0',
    checksum: {
      algorithm: 'sha256',
      hash: 'a'.repeat(64),
    },
    entries: [
      {
        anchor: 'Permitted-stop list is closed',
        rationale:
          'Runs invented new stop categories when the list was open-ended; closing it removed the failure mode.',
        created_at: '2026-09-15T08:00:00Z',
        evidence: [
          {
            provider: 'claude-code',
            session: '5a718af0-4e3c-4d6b-a7e1-e73bd3358ab4',
            event: 'toolu_01VrzBkULS3kxqPYzvbcke65',
            host: 'wls',
            extra: { ctx_session: 'abc', ctx_event: 'def' },
          },
        ],
      },
    ],
  };
}

describe('validateEvidence', () => {
  it('returns [] for a valid record', () => {
    expect(validateEvidence(validRecord())).toEqual([]);
  });

  it('flags a missing checksum', () => {
    const record = validRecord() as unknown as Record<string, unknown>;
    delete record.checksum;
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags a hash that is too short (63 chars)', () => {
    const record = validRecord();
    record.checksum.hash = 'a'.repeat(63);
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags an uppercase hash', () => {
    const record = validRecord();
    record.checksum.hash = 'A'.repeat(64);
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags an unknown top-level key', () => {
    const record = validRecord() as unknown as Record<string, unknown>;
    record.unknown_field = 'x';
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags an unknown entry key', () => {
    const record = validRecord() as unknown as {
      entries: Array<Record<string, unknown>>;
    };
    record.entries[0].unknown_field = 'x';
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags a rationale longer than 500 chars', () => {
    const record = validRecord();
    record.entries[0].rationale = 'x'.repeat(501);
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags a provider outside the enum', () => {
    const record = validRecord();
    record.entries[0].evidence[0].provider =
      'not-a-provider' as EvidenceRecord['entries'][0]['evidence'][0]['provider'];
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags an extra field with a non-string value', () => {
    const record = validRecord() as unknown as {
      entries: Array<{ evidence: Array<{ extra: Record<string, unknown> }> }>;
    };
    record.entries[0].evidence[0].extra = { bad: 123 };
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });

  it('flags more than 200 entries', () => {
    const record = validRecord();
    const entry = record.entries[0];
    record.entries = Array.from({ length: 201 }, () => ({ ...entry }));
    expect(validateEvidence(record).length).toBeGreaterThan(0);
  });
});

describe('parseEvidence', () => {
  it('returns the parsed object for a valid record', () => {
    const record = validRecord();
    expect(parseEvidence(JSON.stringify(record))).toEqual(record);
  });

  it('throws with joined messages for an invalid record', () => {
    const record = validRecord() as unknown as Record<string, unknown>;
    delete record.checksum;
    expect(() => parseEvidence(JSON.stringify(record))).toThrow();
  });

  it('throws on a string longer than EVIDENCE_MAX_BYTES', () => {
    const huge = JSON.stringify(validRecord()).padEnd(EVIDENCE_MAX_BYTES + 1, ' ');
    expect(() => parseEvidence(huge)).toThrow();
  });
});

describe('createEvidenceRecord', () => {
  it('produces a record that passes validateEvidence', () => {
    const record = createEvidenceRecord({
      dossier: 'imboard-ai/git/full-cycle-issue',
      version: '3.8.0',
      checksumHash: 'b'.repeat(64),
    });
    expect(validateEvidence(record)).toEqual([]);
    expect(record.entries).toEqual([]);
  });
});

describe('evidenceMatchesDossier', () => {
  const fullName = 'imboard-ai/git/full-cycle-issue';
  const frontmatter = {
    version: '3.8.0',
    checksum: { hash: 'a'.repeat(64) },
  };

  it('returns [] when everything matches', () => {
    const record = validRecord();
    record.dossier = fullName;
    record.version = frontmatter.version;
    record.checksum.hash = frontmatter.checksum.hash;
    expect(evidenceMatchesDossier(record, frontmatter, fullName)).toEqual([]);
  });

  it('returns one message for a wrong version', () => {
    const record = validRecord();
    record.dossier = fullName;
    record.checksum.hash = frontmatter.checksum.hash;
    record.version = '9.9.9';
    expect(evidenceMatchesDossier(record, frontmatter, fullName)).toHaveLength(1);
  });

  it('returns one message for a wrong hash', () => {
    const record = validRecord();
    record.dossier = fullName;
    record.version = frontmatter.version;
    record.checksum.hash = 'c'.repeat(64);
    expect(evidenceMatchesDossier(record, frontmatter, fullName)).toHaveLength(1);
  });

  it('returns one message for a wrong name', () => {
    const record = validRecord();
    record.dossier = 'imboard-ai/git/other-dossier';
    record.version = frontmatter.version;
    record.checksum.hash = frontmatter.checksum.hash;
    expect(evidenceMatchesDossier(record, frontmatter, fullName)).toHaveLength(1);
  });

  it('returns the specific message when frontmatter has no checksum', () => {
    const record = validRecord();
    expect(evidenceMatchesDossier(record, { version: '3.8.0' }, fullName)).toEqual([
      'dossier has no checksum; sign or run checksum --update before attaching evidence',
    ]);
  });
});
