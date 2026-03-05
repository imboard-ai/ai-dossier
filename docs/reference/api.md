# `@ai-dossier/core` API Reference

The `@ai-dossier/core` package exposes the full dossier parsing, verification, linting, and formatting pipeline as a programmatic TypeScript API.

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

const { frontmatter, body } = parseDossierContent(raw);

const integrity = verifyIntegrity(body, frontmatter.checksum?.hash ?? '');
// integrity.status === 'valid' | 'invalid' | 'missing'

const authenticity = await verifySignature(frontmatter, body);
// authenticity.status === 'verified' | 'unsigned' | 'invalid' | ...
```

---

## Parsing

### `parseDossierContent(content)`

```typescript
function parseDossierContent(content: string): ParsedDossier
```

Parse a raw dossier string (YAML frontmatter + markdown body) into a structured object.

| Parameter | Type     | Description            |
|-----------|----------|------------------------|
| `content` | `string` | Raw dossier file text  |

Returns [`ParsedDossier`](#parseddossier).

---

### `parseDossierFile(filePath)`

```typescript
function parseDossierFile(filePath: string): ParsedDossier
```

Read a `.ds.md` file from disk and parse it.

---

### `validateFrontmatter(frontmatter)`

```typescript
function validateFrontmatter(frontmatter: DossierFrontmatter): string[]
```

Check required fields (`title`, `version`). Returns an array of error message strings — empty means valid.

```typescript
const errors = validateFrontmatter(parsed.frontmatter);
if (errors.length) throw new Error(errors.join(', '));
```

---

## Checksum Verification

### `verifyIntegrity(body, expectedHash)`

```typescript
function verifyIntegrity(body: string, expectedHash: string): IntegrityResult
```

Compute the SHA-256 hash of `body` and compare it to `expectedHash`.

| Parameter      | Type     | Description                          |
|----------------|----------|--------------------------------------|
| `body`         | `string` | Dossier body (after frontmatter)     |
| `expectedHash` | `string` | Hash stored in `checksum.hash`       |

Returns [`IntegrityResult`](#integrityresult).

---

### `calculateChecksum(body)`

```typescript
function calculateChecksum(body: string): string
```

Return the hex-encoded SHA-256 hash of `body`.

---

## Signature Verification

### `verifySignature(frontmatter, body)`

```typescript
function verifySignature(
  frontmatter: DossierFrontmatter,
  body: string
): Promise<AuthenticityResult>
```

Verify the dossier's cryptographic signature against the loaded trusted keys. Supports Ed25519 (Minisign) and AWS KMS.

Returns [`AuthenticityResult`](#authenticityresult).

---

### `verifyWithEd25519(data, signature, publicKeyPem)`

```typescript
function verifyWithEd25519(
  data: string,
  signature: string,
  publicKeyPem: string
): boolean
```

Low-level Ed25519 signature check. `signature` is base64-encoded.

---

### `loadTrustedKeys()`

```typescript
function loadTrustedKeys(): TrustedKey[]
```

Load trusted public keys from environment variables / config. Returns an array of [`TrustedKey`](#trustedkey).

---

## Signing

### `Ed25519Signer`

```typescript
class Ed25519Signer implements Signer {
  constructor(privateKeyPem: string)
  sign(content: string): Promise<SignatureResult>
  getPublicKey(): Promise<string>
  readonly algorithm: string
}
```

Sign dossier content with an Ed25519 private key.

```typescript
import { Ed25519Signer } from '@ai-dossier/core';

const signer = new Ed25519Signer(privateKeyPem);
const sigResult = await signer.sign(body);
// sigResult.algorithm, sigResult.signature, sigResult.public_key, sigResult.signed_at
```

### `KmsSigner`

```typescript
class KmsSigner implements Signer
```

Sign using an AWS KMS asymmetric key. Requires `@aws-sdk/client-kms` to be installed and AWS credentials to be configured.

### `VerifierRegistry`

```typescript
class VerifierRegistry {
  register(verifier: Verifier): void
  verify(content: string, signature: SignatureResult): Promise<VerifyResult>
}

function getVerifierRegistry(): VerifierRegistry
```

The global registry of verifier implementations. The default registry includes `Ed25519Verifier` and `KmsVerifier`.

```typescript
import { getVerifierRegistry } from '@ai-dossier/core';

const registry = getVerifierRegistry();
const result = await registry.verify(body, signatureMetadata);
```

---

## Linting

### `lintDossier(content, config?)`

```typescript
function lintDossier(content: string, config?: LintConfig): LintResult
```

Lint a dossier string against the default rule set (or a custom config).

```typescript
import { lintDossier } from '@ai-dossier/core';

const { diagnostics, errorCount, warningCount } = lintDossier(content);
for (const d of diagnostics) {
  console.log(`[${d.severity}] ${d.ruleId}: ${d.message}`);
}
```

### `lintDossierFile(filePath, config?)`

```typescript
function lintDossierFile(filePath: string, config?: LintConfig): LintResult
```

Read a file from disk and lint it.

### `LintRuleRegistry`

```typescript
class LintRuleRegistry {
  constructor(rules?: LintRule[])
  register(rule: LintRule): void
  run(context: LintRuleContext, config?: LintConfig): LintDiagnostic[]
}
```

Register custom lint rules:

```typescript
import { LintRuleRegistry, defaultRules } from '@ai-dossier/core';
import type { LintRule } from '@ai-dossier/core';

const myRule: LintRule = {
  id: 'custom/require-objective',
  description: 'Dossier must have an objective',
  defaultSeverity: 'warning',
  run({ frontmatter }) {
    if (!frontmatter.objective) {
      return [{
        ruleId: 'custom/require-objective',
        severity: 'warning',
        message: 'Missing objective field',
        field: 'objective',
      }];
    }
    return [];
  },
};

const registry = new LintRuleRegistry([...defaultRules, myRule]);
```

### `loadLintConfig(dir?)`

```typescript
function loadLintConfig(dir?: string): LintConfig
```

Load lint configuration from a `.dossierrc` or `dossier.config.json` file.

---

## Formatting

### `formatDossierContent(content, options?)`

```typescript
function formatDossierContent(
  content: string,
  options?: Partial<FormatOptions>
): FormatResult
```

Normalize YAML frontmatter key order and optionally recompute the checksum.

| Option           | Type      | Default | Description                            |
|------------------|-----------|---------|----------------------------------------|
| `sortKeys`       | `boolean` | `true`  | Alphabetically sort frontmatter keys   |
| `updateChecksum` | `boolean` | `true`  | Recompute `checksum.hash` after format |
| `indent`         | `number`  | `2`     | YAML indentation width                 |

```typescript
import { formatDossierContent } from '@ai-dossier/core';

const { formatted, changed } = formatDossierContent(rawContent, {
  sortKeys: true,
  updateChecksum: true,
});
if (changed) fs.writeFileSync(path, formatted);
```

### `formatDossierFile(filePath, options?)`

```typescript
function formatDossierFile(
  filePath: string,
  options?: Partial<FormatOptions>
): FormatResult
```

Format a dossier file in place (writes back if changed).

---

## Type Reference

### `ParsedDossier`

```typescript
interface ParsedDossier {
  frontmatter: DossierFrontmatter;
  body: string;   // Markdown content after the closing --- delimiter
  raw: string;    // Original unmodified file text
}
```

### `DossierFrontmatter`

```typescript
interface DossierFrontmatter {
  title: string;
  version: string;
  dossier_schema_version?: string;
  name?: string;
  protocol_version?: string;
  created?: string;
  updated?: string;
  objective?: string;
  status?: 'Draft' | 'Stable' | 'Deprecated' | 'Experimental';
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  risk_factors?: string[];
  destructive_operations?: string[];
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
  [key: string]: unknown;
}
```

### `IntegrityResult`

```typescript
interface IntegrityResult {
  status: 'valid' | 'invalid' | 'missing';
  message: string;
  expectedHash?: string;
  actualHash?: string;
}
```

### `AuthenticityResult`

```typescript
interface AuthenticityResult {
  status: 'verified' | 'signed_unknown' | 'unsigned' | 'invalid' | 'error';
  message: string;
  signer?: string;
  keyId?: string;
  publicKey?: string;
  isTrusted: boolean;
  trustedAs?: string;
}
```

### `RiskAssessment`

```typescript
interface RiskAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskFactors: string[];
  destructiveOperations: string[];
  requiresApproval: boolean;
}
```

### `VerificationResult`

```typescript
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

### `TrustedKey`

```typescript
interface TrustedKey {
  publicKey: string;
  keyId: string;
}
```

### `DossierListItem`

```typescript
interface DossierListItem {
  name: string;
  path: string;
  version: string;
  protocol: string;
  status: string;
  objective: string;
  riskLevel: string;
}
```

### `Signer`

```typescript
interface Signer {
  readonly algorithm: string;
  sign(content: string): Promise<SignatureResult>;
  getPublicKey(): Promise<string>;
}
```

### `Verifier`

```typescript
interface Verifier {
  verify(content: string, signature: SignatureResult): Promise<VerifyResult>;
  supports(algorithm: string): boolean;
}
```

### `SignatureResult`

```typescript
interface SignatureResult {
  algorithm: string;
  signature: string;
  public_key: string;
  key_id?: string;
  signed_by?: string;
  signed_at: string;
}
```

### `VerifyResult`

```typescript
interface VerifyResult {
  valid: boolean;
  error?: string;
}
```

### `LintDiagnostic`

```typescript
type LintSeverity = 'error' | 'warning' | 'info';

interface LintDiagnostic {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  field?: string;
}
```

### `LintResult`

```typescript
interface LintResult {
  file?: string;
  diagnostics: LintDiagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}
```

### `LintRule`

```typescript
interface LintRule {
  id: string;
  description: string;
  defaultSeverity: LintSeverity;
  run(context: LintRuleContext): LintDiagnostic[];
}
```

### `LintConfig`

```typescript
type RuleSeverityOverride = LintSeverity | 'off';

interface LintConfig {
  rules: Record<string, RuleSeverityOverride>;
}
```

### `FormatOptions` / `FormatResult`

```typescript
interface FormatOptions {
  indent: number;
  sortKeys: boolean;
  updateChecksum: boolean;
}

interface FormatResult {
  formatted: string;
  changed: boolean;
}
```
