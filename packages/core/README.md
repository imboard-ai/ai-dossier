# @ai-dossier/core

Core parsing, verification, and linting logic for the [Dossier](https://github.com/imboard-ai/ai-dossier) automation standard.

Use this package to integrate dossier parsing and verification into your own tooling.

## Installation

```bash
npm install @ai-dossier/core
```

## Quick Start

```typescript
import {
  parseDossierContent,
  verifyIntegrity,
  verifySignature,
} from '@ai-dossier/core';

const raw = `---
title: Deploy to Production
version: 1.0.0
checksum:
  algorithm: sha256
  hash: abc123...
---
# Steps
Run deployment script.
`;

// Parse the dossier
const { frontmatter, body } = parseDossierContent(raw);

// Verify body integrity
const integrity = verifyIntegrity(body, frontmatter.checksum?.hash ?? '');
console.log(integrity.status); // 'valid' | 'invalid' | 'missing'

// Verify cryptographic signature
const authenticity = await verifySignature(frontmatter, body);
console.log(authenticity.status); // 'verified' | 'unsigned' | 'invalid' | ...
```

## API

### Parsing

#### `parseDossierContent(content: string): ParsedDossier`

Parse a dossier string into structured data.

```typescript
import { parseDossierContent } from '@ai-dossier/core';

const { frontmatter, body, raw } = parseDossierContent(content);
```

#### `parseDossierFile(filePath: string): ParsedDossier`

Parse a dossier file from disk.

```typescript
import { parseDossierFile } from '@ai-dossier/core';

const parsed = parseDossierFile('./deploy.ds.md');
```

#### `validateFrontmatter(frontmatter: DossierFrontmatter): string[]`

Validate required fields. Returns an array of error messages (empty = valid).

```typescript
import { validateFrontmatter } from '@ai-dossier/core';

const errors = validateFrontmatter(parsed.frontmatter);
if (errors.length > 0) {
  console.error('Invalid dossier:', errors);
}
```

### Checksum Verification

#### `verifyIntegrity(body: string, expectedHash: string): IntegrityResult`

Verify that the dossier body matches its recorded SHA-256 checksum.

```typescript
import { verifyIntegrity } from '@ai-dossier/core';

const result = verifyIntegrity(body, frontmatter.checksum?.hash ?? '');
// result.status: 'valid' | 'invalid' | 'missing'
// result.message: human-readable explanation
// result.actualHash: computed hash
// result.expectedHash: hash from frontmatter
```

#### `calculateChecksum(body: string): string`

Compute the SHA-256 hash of a dossier body.

```typescript
import { calculateChecksum } from '@ai-dossier/core';

const hash = calculateChecksum(body);
```

### Signature Verification

#### `verifySignature(frontmatter, body): Promise<AuthenticityResult>`

Verify the dossier's cryptographic signature using the configured trusted keys.

```typescript
import { verifySignature } from '@ai-dossier/core';

const result = await verifySignature(frontmatter, body);
// result.status: 'verified' | 'signed_unknown' | 'unsigned' | 'invalid' | 'error'
// result.isTrusted: boolean
// result.signer: string | undefined
```

#### `verifyWithEd25519(data, signature, publicKeyPem): boolean`

Verify an Ed25519 signature directly.

```typescript
import { verifyWithEd25519 } from '@ai-dossier/core';

const valid = verifyWithEd25519(data, signatureBase64, publicKeyPem);
```

#### `loadTrustedKeys(): TrustedKey[]`

Load trusted public keys from the environment / config.

```typescript
import { loadTrustedKeys } from '@ai-dossier/core';

const keys = loadTrustedKeys();
// keys[0].publicKey, keys[0].keyId
```

### Signing

Use the `Signer` interface to sign dossier content programmatically.

```typescript
import { Ed25519Signer } from '@ai-dossier/core';

const signer = new Ed25519Signer(privateKeyPem);
const result = await signer.sign(body);
// result.algorithm, result.signature, result.public_key, result.signed_at
```

### Linting

#### `lintDossier(content, config?): LintResult`

Lint a dossier string.

```typescript
import { lintDossier } from '@ai-dossier/core';

const result = lintDossier(content);
console.log(result.errorCount, result.warningCount);
for (const d of result.diagnostics) {
  console.log(`[${d.severity}] ${d.ruleId}: ${d.message}`);
}
```

#### `lintDossierFile(filePath, config?): LintResult`

Lint a dossier file from disk.

#### Custom lint rules

```typescript
import { LintRuleRegistry, defaultRules } from '@ai-dossier/core';
import type { LintRule } from '@ai-dossier/core';

const myRule: LintRule = {
  id: 'my/rule',
  description: 'Require objective field',
  defaultSeverity: 'warning',
  run({ frontmatter }) {
    if (!frontmatter.objective) {
      return [{ ruleId: 'my/rule', severity: 'warning', message: 'Missing objective' }];
    }
    return [];
  },
};

const registry = new LintRuleRegistry([...defaultRules, myRule]);
```

### Formatting

#### `formatDossierContent(content, options?): FormatResult`

Normalize YAML frontmatter formatting and optionally recompute the checksum.

```typescript
import { formatDossierContent } from '@ai-dossier/core';

const { formatted, changed } = formatDossierContent(rawContent, {
  sortKeys: true,
  updateChecksum: true,
});
```

#### `formatDossierFile(filePath, options?): FormatResult`

Format a dossier file in place.

## TypeScript Types

### Core data types

```typescript
interface ParsedDossier {
  frontmatter: DossierFrontmatter;
  body: string; // content after the closing --- delimiter
  raw: string; // original full file content
}

interface DossierFrontmatter {
  title: string;
  version: string;
  dossier_schema_version?: string;
  name?: string;
  objective?: string;
  status?: 'Draft' | 'Stable' | 'Deprecated' | 'Experimental';
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  risk_factors?: string[];
  destructive_operations?: string[];
  requires_approval?: boolean;
  checksum?: { algorithm: string; hash: string; calculated_at?: string };
  signature?: {
    algorithm: string;
    signature: string;
    public_key?: string;
    key_id?: string;
    signed_by?: string;
    signed_at?: string;
  };
  [key: string]: unknown;
}
```

### Verification result types

```typescript
interface IntegrityResult {
  status: 'valid' | 'invalid' | 'missing';
  message: string;
  expectedHash?: string;
  actualHash?: string;
}

interface AuthenticityResult {
  status: 'verified' | 'signed_unknown' | 'unsigned' | 'invalid' | 'error';
  message: string;
  signer?: string;
  keyId?: string;
  publicKey?: string;
  isTrusted: boolean;
  trustedAs?: string;
}

interface RiskAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskFactors: string[];
  destructiveOperations: string[];
  requiresApproval: boolean;
}

interface VerificationResult {
  dossierFile: string;
  integrity: IntegrityResult;
  authenticity: AuthenticityResult;
  riskAssessment: RiskAssessment;
  recommendation: 'ALLOW' | 'WARN' | 'BLOCK';
  message: string;
  errors: string[];
}
```

### Signer / Verifier interfaces

```typescript
interface Signer {
  readonly algorithm: string;
  sign(content: string): Promise<SignatureResult>;
  getPublicKey(): Promise<string>;
}

interface Verifier {
  verify(content: string, signature: SignatureResult): Promise<VerifyResult>;
  supports(algorithm: string): boolean;
}

interface SignatureResult {
  algorithm: string;
  signature: string;
  public_key: string;
  key_id?: string;
  signed_by?: string;
  signed_at: string;
}

interface VerifyResult {
  valid: boolean;
  error?: string;
}
```

### Lint types

```typescript
type LintSeverity = 'error' | 'warning' | 'info';

interface LintDiagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  field?: string;
}

interface LintResult {
  file?: string;
  diagnostics: LintDiagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

interface LintConfig {
  rules: Record<string, LintSeverity | 'off'>;
}
```

## License

[AGPL-3.0](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)
