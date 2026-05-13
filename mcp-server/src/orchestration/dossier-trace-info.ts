// Extracts the audit-metadata block we record on every trace step from a
// parsed dossier frontmatter. The checksum we record is the **same value**
// that lives in the dossier's own `checksum.hash` field, so an archived
// trace can be cross-referenced against the dossier file directly.
//
// Signature: we capture the algorithm + signer metadata (who, when, key id)
// — NOT the signature bytes / public key. Those are reproducible by
// re-fetching the dossier at the recorded version + checksum.

import type { DossierFrontmatter, DossierTraceInfo } from '@ai-dossier/core';

export function extractDossierTraceInfo(
  fallbackName: string,
  frontmatter: DossierFrontmatter | null
): DossierTraceInfo {
  if (!frontmatter) {
    return { title: fallbackName, version: 'unknown' };
  }
  const info: DossierTraceInfo = {
    title: frontmatter.title || fallbackName,
    version: frontmatter.version || 'unknown',
  };
  if (frontmatter.checksum?.hash) {
    info.checksum = {
      algorithm: frontmatter.checksum.algorithm,
      hash: frontmatter.checksum.hash,
    };
  }
  if (frontmatter.signature) {
    info.signature = {
      algorithm: frontmatter.signature.algorithm,
    };
    if (frontmatter.signature.signed_by) info.signature.signed_by = frontmatter.signature.signed_by;
    if (frontmatter.signature.key_id) info.signature.key_id = frontmatter.signature.key_id;
    if (frontmatter.signature.signed_at) info.signature.signed_at = frontmatter.signature.signed_at;
  }
  return info;
}
