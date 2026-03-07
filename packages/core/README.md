# @ai-dossier/core

[![npm version](https://img.shields.io/npm/v/@ai-dossier/core)](https://www.npmjs.com/package/@ai-dossier/core)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/core)](https://www.npmjs.com/package/@ai-dossier/core)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

Core parsing, verification, and linting logic for the [Dossier](https://github.com/imboard-ai/ai-dossier) automation standard.

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
} from '@ai-dossier/core';
```

#### `verifySignature(content: string, signature: SignatureResult): Promise<VerifyResult>`

Verify a signature using the verifier registry. Automatically selects the correct verifier based on `signature.algorithm`.

```typescript
const result = await verifySignature(body, frontmatter.signature);
console.log(result.valid); // true | false
```

#### `verifyWithEd25519(content: string, signature: string, publicKey: string): VerifyResult`

Verify an Ed25519 signature directly.

#### `verifyWithKms(content: string, signature: string, keyId: string, region?: string): Promise<VerifyResult>`

Verify an ECDSA-SHA-256 signature using AWS KMS.

#### `loadTrustedKeys(filePath?: string): Map<string, string>`

Load trusted public keys from a file (default: `~/.dossier/trusted-keys.txt`). Returns a map of public key to key ID.

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
