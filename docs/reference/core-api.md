# Core API Reference

Complete API reference for `@ai-dossier/core` — the programmatic library for parsing, verifying, linting, and formatting dossier files.

```bash
npm install @ai-dossier/core
```

## Parsing

### `parseDossierContent(content: string): ParsedDossier`

Parse a dossier content string into structured data. Supports both `---dossier` (JSON/YAML) and standard `---` (YAML) frontmatter delimiters.

**Parameters:**
- `content` — Raw dossier file content as a string

**Returns:** `ParsedDossier` — `{ frontmatter, body, raw }`

**Throws:** `Error` if content is empty, not a string, or has no valid frontmatter delimiters.

```typescript
import { parseDossierContent } from '@ai-dossier/core';

const raw = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Deploy API",
  "version": "1.0.0",
  "status": "Stable",
  "risk_level": "medium"
}
---

## Steps
1. Run migrations
2. Deploy containers
`;

const { frontmatter, body } = parseDossierContent(raw);
console.log(frontmatter.title);      // "Deploy API"
console.log(frontmatter.risk_level); // "medium"
console.log(body);                   // "\n## Steps\n1. Run migrations\n..."
```

### `parseDossierFile(filePath: string): ParsedDossier`

Read a dossier file from disk and parse it.

**Parameters:**
- `filePath` — Path to the `.ds.md` file

**Throws:** `Error` if the file does not exist.

```typescript
import { parseDossierFile } from '@ai-dossier/core';

const dossier = parseDossierFile('./deploy.ds.md');
```

### `validateFrontmatter(frontmatter: DossierFrontmatter): string[]`

Validate required frontmatter fields and enum values.

**Required fields:** `dossier_schema_version`, `title`, `version`

**Validated enums:**
- `status` — `"Draft"`, `"Stable"`, `"Deprecated"`, `"Experimental"`
- `risk_level` — `"low"`, `"medium"`, `"high"`, `"critical"`

**Returns:** Array of error message strings. Empty array means valid.

```typescript
import { validateFrontmatter } from '@ai-dossier/core';

const errors = validateFrontmatter(dossier.frontmatter);
if (errors.length > 0) {
  errors.forEach(e => console.error(e));
  // "Missing required field: dossier_schema_version"
}
```

### Constants

| Constant | Value |
|---|---|
| `REQUIRED_FIELDS` | `['dossier_schema_version', 'title', 'version']` |
| `RECOMMENDED_FIELDS` | `['objective', 'risk_level', 'status']` |
| `VALID_STATUSES` | `['Draft', 'Stable', 'Deprecated', 'Experimental']` |
| `VALID_RISK_LEVELS` | `['low', 'medium', 'high', 'critical']` |

---

## Checksum Verification

### `calculateChecksum(body: string): string`

Calculate the SHA-256 hash of the dossier body (everything after the closing `---` delimiter).

**Returns:** Hex-encoded SHA-256 hash string.

```typescript
import { calculateChecksum } from '@ai-dossier/core';

const hash = calculateChecksum(dossier.body);
// "a1b2c3d4..."
```

### `verifyIntegrity(body: string, expectedHash: string | undefined): IntegrityResult`

Compare the computed body hash against the expected checksum.

**Returns:** `IntegrityResult`

| `status` | Meaning |
|---|---|
| `"valid"` | Hash matches — content is untampered |
| `"invalid"` | Hash mismatch — content was modified |
| `"missing"` | No checksum in frontmatter |

```typescript
import { verifyIntegrity } from '@ai-dossier/core';

const result = verifyIntegrity(body, frontmatter.checksum?.hash);
if (result.status === 'invalid') {
  console.error('Tampered!', result.expectedHash, '!=', result.actualHash);
}
```

---

## Signature Verification

### `verifySignature(content: string, signature: SignatureResult): Promise<VerifyResult>`

Verify a signature using the built-in verifier registry. Automatically selects the appropriate verifier based on `signature.algorithm`.

**Returns:** `Promise<VerifyResult>` — `{ valid: boolean, error?: string }`

```typescript
import { verifySignature } from '@ai-dossier/core';

const result = await verifySignature(body, frontmatter.signature);
if (result.valid) {
  console.log('Signature verified');
}
```

### `verifyWithEd25519(content: string, signature: string, publicKey: string): VerifyResult`

Verify an Ed25519 signature directly.

**Parameters:**
- `content` — The content that was signed
- `signature` — Base64-encoded signature
- `publicKey` — PEM-format Ed25519 public key

### `verifyWithKms(content: string, signature: string, keyId: string, region?: string): Promise<VerifyResult>`

Verify an ECDSA-SHA-256 signature using AWS KMS.

**Parameters:**
- `content` — The content that was signed
- `signature` — Base64-encoded signature
- `keyId` — AWS KMS key ARN or alias
- `region` — AWS region (default: `"us-east-1"`)

### `loadTrustedKeys(filePath?: string): Map<string, string>`

Load trusted public keys from a file.

**Default path:** `~/.dossier/trusted-keys.txt`

**File format:**
```
# Comments start with #
<public-key-pem> <key-id>
```

**Returns:** `Map<publicKey, keyId>`

---

## Linting

### `lintDossier(content: string, config?: LintConfig): LintResult`

Lint a dossier content string against built-in rules.

**Built-in rules:**
- `checksum-valid` — Checksum matches body content
- `schema-valid` — Frontmatter conforms to dossier schema
- `required-sections` — Mandatory sections are present
- `semver-version` — Version is valid semver
- `risk-level-consistency` — Risk factors align with risk level
- `objective-quality` — Objective meets quality standards
- `tools-check-command` — Tool commands reference valid executables

```typescript
import { lintDossier } from '@ai-dossier/core';

const result = lintDossier(content);
console.log(`${result.errorCount} errors, ${result.warningCount} warnings`);

for (const d of result.diagnostics) {
  console.log(`[${d.severity}] ${d.ruleId}: ${d.message}`);
}
```

### `lintDossierFile(filePath: string, config?: LintConfig): LintResult`

Lint a dossier file from disk.

### Lint Configuration

Override rule severities:

```typescript
import { lintDossier } from '@ai-dossier/core';
import type { LintConfig } from '@ai-dossier/core';

const config: LintConfig = {
  rules: {
    'checksum-valid': 'error',
    'objective-quality': 'off',    // disable this rule
    'semver-version': 'warning',
  },
};

const result = lintDossier(content, config);
```

### Custom Rules

Implement the `LintRule` interface and register it:

```typescript
import { LintRuleRegistry } from '@ai-dossier/core';
import type { LintRule, LintRuleContext, LintDiagnostic } from '@ai-dossier/core';

const myRule: LintRule = {
  id: 'my-custom-rule',
  description: 'Ensure title is lowercase',
  defaultSeverity: 'warning',
  run(context: LintRuleContext): LintDiagnostic[] {
    if (context.frontmatter.title !== context.frontmatter.title.toLowerCase()) {
      return [{
        ruleId: 'my-custom-rule',
        severity: 'warning',
        message: 'Title should be lowercase',
        field: 'title',
      }];
    }
    return [];
  },
};

const registry = new LintRuleRegistry();
registry.register(myRule);
```

---

## Formatting

### `formatDossierContent(content: string, options?: Partial<FormatOptions>): FormatResult`

Format dossier content — sort frontmatter keys and update checksum.

**Options (`FormatOptions`):**

| Option | Type | Default | Description |
|---|---|---|---|
| `indent` | `number` | `2` | JSON indentation spaces |
| `sortKeys` | `boolean` | `true` | Sort frontmatter keys alphabetically |
| `updateChecksum` | `boolean` | `true` | Recalculate and update checksum |

**Returns:** `FormatResult` — `{ formatted: string, changed: boolean }`

```typescript
import { formatDossierContent } from '@ai-dossier/core';

const { formatted, changed } = formatDossierContent(rawContent);
if (changed) {
  console.log('Content was reformatted');
}
```

### `formatDossierFile(filePath: string, options?: Partial<FormatOptions>): FormatResult`

Format a dossier file in place. Only writes to disk if content changed.

---

## Signer & Verifier Interfaces

Extensible interfaces for signing and verification.

### `Signer` Interface

```typescript
interface Signer {
  readonly algorithm: string;
  sign(content: string): Promise<SignatureResult>;
  getPublicKey(): Promise<string>;
}
```

### `Verifier` Interface

```typescript
interface Verifier {
  verify(content: string, signature: SignatureResult): Promise<VerifyResult>;
  supports(algorithm: string): boolean;
}
```

### Built-in Implementations

| Class | Algorithm | Description |
|---|---|---|
| `Ed25519Signer` | `ed25519` | Sign with Ed25519 private key |
| `Ed25519Verifier` | `ed25519` | Verify Ed25519 signatures |
| `KmsSigner` | `kms-ecdsa-sha256` | Sign with AWS KMS |
| `KmsVerifier` | `kms-ecdsa-sha256` | Verify with AWS KMS |

### `VerifierRegistry`

Algorithm-based dispatch for verification:

```typescript
import { getVerifierRegistry } from '@ai-dossier/core';

const registry = getVerifierRegistry();
const verifier = registry.get('ed25519');
const result = await verifier.verify(content, signatureResult);
```

---

## Types

### Core Types

```typescript
interface DossierFrontmatter {
  dossier_schema_version?: string;
  name?: string;
  title: string;
  version: string;
  status?: 'Draft' | 'Stable' | 'Deprecated' | 'Experimental';
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  objective?: string;
  risk_factors?: string[];
  destructive_operations?: string[];
  requires_approval?: boolean;
  checksum?: { algorithm: string; hash: string };
  signature?: { algorithm: string; signature: string; public_key?: string; key_id?: string };
  [key: string]: unknown;
}

interface ParsedDossier {
  frontmatter: DossierFrontmatter;
  body: string;
  raw: string;
}

type DossierStatus = 'Draft' | 'Stable' | 'Deprecated' | 'Experimental';
```

### Verification Types

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
  isTrusted: boolean;
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

interface TrustedKey {
  publicKey: string;
  keyId: string;
}

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

### Signing Types

```typescript
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

### Lint Types

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

interface LintRule {
  id: string;
  description: string;
  defaultSeverity: LintSeverity;
  run(context: LintRuleContext): LintDiagnostic[];
}

interface LintConfig {
  rules: Record<string, LintSeverity | 'off'>;
}
```

### Format Types

```typescript
interface FormatOptions {
  indent: number;      // default: 2
  sortKeys: boolean;   // default: true
  updateChecksum: boolean; // default: true
}

interface FormatResult {
  formatted: string;
  changed: boolean;
}
```

---

## Utility Exports

| Function | Description |
|---|---|
| `sha256Hash(content)` | SHA-256 as `Buffer` |
| `sha256Hex(content)` | SHA-256 as hex string |
| `getErrorMessage(err)` | Extract error message safely |
| `getErrorStack(err)` | Extract error stack safely |
| `readFileIfExists(path)` | Read file or return `undefined` |
| `createDefaultVerificationResult(file)` | Create a default `VerificationResult` |
