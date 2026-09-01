# @ai-dossier/core

[![npm version](https://img.shields.io/npm/v/@ai-dossier/core)](https://www.npmjs.com/package/@ai-dossier/core)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/core)](https://www.npmjs.com/package/@ai-dossier/core)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

Core parsing, verification, signing, and linting logic for [Dossier](https://github.com/imboard-ai/ai-dossier) — portable, signed, versioned skills for any LLM tool.

## Installation

```bash
npm install @ai-dossier/core
```

Requires Node.js >= 20.0.0.

## Quick Start

```typescript
import {
  parseDossierContent,
  verifyIntegrity,
  lintDossier,
} from '@ai-dossier/core';

// 1. Parse a dossier
const dossier = parseDossierContent(rawContent);
console.log(dossier.frontmatter.title); // => "My Dossier"

// 2. Verify integrity
const integrity = verifyIntegrity(
  dossier.body,
  dossier.frontmatter.checksum?.hash
);
console.log(integrity.status); // => "valid" | "invalid" | "missing"

// 3. Lint for issues
const result = lintDossier(rawContent);
console.log(result.errorCount, result.warningCount);
```

## API

### Parsing

```typescript
import {
  parseDossierContent,
  parseDossierFile,
  validateFrontmatter,
} from '@ai-dossier/core';
```

#### `parseDossierContent(content: string): ParsedDossier`

Parse a dossier content string into frontmatter and body. Accepts both `---dossier` (JSON/YAML) and standard `---` (YAML) delimiters.

```typescript
const { frontmatter, body, raw } = parseDossierContent(content);
```

#### `parseDossierFile(filePath: string): ParsedDossier`

Read and parse a dossier file from disk.

```typescript
const parsed = parseDossierFile('./path/to/dossier.ds.md');
```

#### `validateFrontmatter(frontmatter: DossierFrontmatter): string[]`

Validate required fields and enum values. Returns an array of error messages (empty if valid).

```typescript
const errors = validateFrontmatter(parsed.frontmatter);
if (errors.length > 0) {
  console.error('Validation errors:', errors);
}
```

### Checksum Verification

```typescript
import { calculateChecksum, verifyIntegrity } from '@ai-dossier/core';
```

#### `calculateChecksum(body: string): string`

Calculate the SHA-256 hash of dossier body content (excluding frontmatter).

#### `verifyIntegrity(body: string, expectedHash: string | undefined): IntegrityResult`

Compare the computed hash against the expected hash from frontmatter.

```typescript
const result = verifyIntegrity(body, frontmatter.checksum?.hash);
// result.status: "valid" | "invalid" | "missing"
```

### Signature Verification

```typescript
import {
  verifySignature,
  verifyWithEd25519,
  verifyWithKms,
  loadTrustedKeys,
  findTrustedIdentifier,
  normalizePublicKey,
  isSupportedPublicKey,
} from '@ai-dossier/core';
```

#### `verifySignature(content: string, signature: SignatureResult): Promise<VerifyResult>`

Verify a signature using the verifier registry. Automatically selects the correct verifier based on `signature.algorithm`.

```typescript
const result = await verifySignature(body, frontmatter.signature);
console.log(result.valid); // true | false
```

#### `verifyWithEd25519(content: string, signature: string, publicKey: string): VerifyResult`

Verify an Ed25519 signature directly. `publicKey` may be SPKI PEM, raw 32-byte base64, or base64 SPKI DER.

#### `verifyWithKms(content: string, signature: string, keyId: string, region?: string): Promise<VerifyResult>`

Verify an ECDSA-SHA-256 signature using AWS KMS.

#### `loadTrustedKeys(filePath?: string): Map<string, string>`

Load trusted public keys from a file (default: `~/.dossier/trusted-keys.txt`), format `<public-key> <identifier>` one per line. Returns a map of public key to identifier, indexed under both the written and the normalized form. Unreadable lines are reported to stderr, not dropped silently.

#### `findTrustedIdentifier(trustedKeys, signature): string | undefined`

Resolve the identifier a signature is trusted under. Use this rather than probing the map by hand — it consults `key_id` only when there is no `public_key`, which is what stops a dossier from claiming a trusted signer's identity while verifying under a different key.

#### `normalizePublicKey(key) / isSupportedPublicKey(key)`

Reduce an Ed25519 key to its canonical raw 32-byte base64 form, and test whether a key is one this project can verify against. Validate with `isSupportedPublicKey` before *storing* a key: `normalizePublicKey` deliberately passes uninterpretable input through.

See [core API reference](../../docs/reference/core-api.md#key-format-and-trust-file-helpers) for the full trust-file helper set.

### Linting

```typescript
import { lintDossier, lintDossierFile } from '@ai-dossier/core';
```

#### `lintDossier(content: string, config?: LintConfig): LintResult`

Lint dossier content against built-in rules (checksum validity, schema validation, required sections, semver version, etc.).

```typescript
const result = lintDossier(content);
for (const d of result.diagnostics) {
  console.log(`[${d.severity}] ${d.ruleId}: ${d.message}`);
}
```

#### `lintDossierFile(filePath: string, config?: LintConfig): LintResult`

Lint a dossier file from disk.

### Formatting

```typescript
import { formatDossierContent, formatDossierFile } from '@ai-dossier/core';
```

#### `formatDossierContent(content: string, options?: Partial<FormatOptions>): FormatResult`

Format dossier content (sort keys, update checksum). Returns `{ formatted, changed }`.

```typescript
const { formatted, changed } = formatDossierContent(rawContent, {
  sortKeys: true,
  updateChecksum: true,
});
```

#### `formatDossierFile(filePath: string, options?: Partial<FormatOptions>): FormatResult`

Format a dossier file in place. Only writes if changes were made.

### Signer/Verifier Interfaces

The package exports extensible interfaces for signing and verification:

```typescript
import type { Signer, Verifier, SignatureResult, VerifyResult } from '@ai-dossier/core';
```

Built-in implementations:
- `Ed25519Signer` / `Ed25519Verifier` — Ed25519 key pair signing
- `KmsSigner` / `KmsVerifier` — AWS KMS ECDSA-SHA-256 signing

Registry for algorithm dispatch:
```typescript
import { getVerifierRegistry, VerifierRegistry } from '@ai-dossier/core';

const registry = getVerifierRegistry();
const verifier = registry.get('ed25519');
const result = await verifier.verify(content, signature);
```

### Agent Usage & Run Log

Shared with `packages/sched` so both the `ai-dossier run` headless path and the
scheduler's detached dispatch path agree on which block of an agent's result is the
source of record.

```typescript
import {
  parseAgentUsage,      // claude: one --output-format json object, OR a stream-json event stream
  parseOpenCodeUsage,   // opencode: a `run --format json` JSONL event stream
  usageParserFor,       // pick the parser from the spawned binary's basename
  runsLogPath,          // ~/.dossier/runs.jsonl
  SCHED_DISPATCH_EVENT, // the sched dispatch-log preamble `type`, skipped by both parsers
  type AgentRunUsage,
  type RunLogEntry,
} from '@ai-dossier/core';

const usage = parseAgentUsage(stdout);
// → { model, input_tokens, output_tokens, cache_creation_tokens,
//     cache_read_tokens, total_cost_usd, result_text } — every field null
//     when the agent did not report it; values are never fabricated.
```

`parseAgentUsage` treats the agent's per-model **`modelUsage` map as the source of
record** whenever it carries at least one object-shaped entry, summed across models. The
top-level `usage` block is used only when `modelUsage` has no such entry — the two are
never blended field-by-field, because they have been observed to disagree enough to
fabricate a ~43% "saving" when mixed (ai-dossier#524). Cost is read from `costUSD` (the
key claude writes), falling back to the top-level total when `modelUsage` reports no cost
at all. For a `stream-json` log the final `type:"result"` event wins; with no such event
(an agent killed mid-run) per-turn `assistant` usage is summed instead.

## Types

All TypeScript types are exported from the package root:

```typescript
import type {
  // Core types
  DossierFrontmatter,   // Frontmatter fields (title, version, checksum, signature, ...)
  ParsedDossier,        // { frontmatter, body, raw }
  DossierStatus,        // "Draft" | "Stable" | "Deprecated" | "Experimental"
  DossierListItem,      // Summary for listing dossiers

  // Verification
  IntegrityResult,      // Checksum verification result
  AuthenticityResult,   // Signature verification result
  RiskAssessment,       // Risk level, factors, destructive ops
  VerificationResult,   // Combined verification report
  TrustedKey,           // { publicKey, keyId }

  // Signing
  Signer,               // Sign interface
  Verifier,             // Verify interface
  SignatureResult,       // Signature metadata
  VerifyResult,          // { valid, error? }
  VerifierRegistry,     // Algorithm → verifier dispatch

  // Linting
  LintResult,           // { diagnostics, errorCount, warningCount, infoCount }
  LintDiagnostic,       // { ruleId, severity, message, field? }
  LintRule,             // Custom rule interface
  LintConfig,           // { rules: Record<string, severity> }
  LintSeverity,         // "error" | "warning" | "info"

  // Formatting
  FormatOptions,        // { indent, sortKeys, updateChecksum }
  FormatResult,         // { formatted, changed }
} from '@ai-dossier/core';
```

## Development

Part of the [ai-dossier](https://github.com/imboard-ai/ai-dossier) monorepo.

```bash
npm run build -w packages/core    # build
npm run test -w packages/core     # test
make build-core                   # build via Makefile
```

## License

[AGPL-3.0](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)
