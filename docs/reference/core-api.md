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
- `publicKey` — Ed25519 public key as SPKI PEM, raw 32-byte base64, or base64 SPKI DER. Whatever form is passed, the key is rebuilt from a single parse before verification, so the key material verified against is the same material a trust check matches on.

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
<public-key> <identifier>
```

One entry per line. `<public-key>` is canonically the raw 32-byte base64 Ed25519 key that
`ai-dossier keys add` writes; a multi-line SPKI PEM block written by an older CLI is
rejoined and still honoured, as are legacy minisign `RWT...` keys.

**Returns:** `Map<publicKey, identifier>` — each key is indexed under both the form it was
written in and its normalized raw base64 form, so an entry recorded in one encoding still
matches a signature carrying another.

Lines that cannot be read as entries are reported to stderr rather than dropped silently: a
skipped entry is a key the user believes is trusted and is not, and the only other symptom
would be `verify` reporting "not trusted" with nothing pointing back at the file.

### `findTrustedIdentifier(trustedKeys: Map<string, string>, signature: { algorithm?: string; key_id?: string; public_key?: string }): string | undefined`

Resolve the identifier a signature is trusted under, or `undefined` when none of its key
forms appear in the trust list. Every trust decision should go through this, so "is it
trusted" and "who is it" cannot disagree.

Only key material the verifier actually used is eligible, chosen by `algorithm` rather than
by which fields happen to be set. `ECDSA-SHA-256` (KMS) verification asks KMS to check the
signature against `key_id` and never reads `public_key`, so only the ARN can confer trust;
every other scheme verifies against `public_key`, so only that may. Letting an ignored field
confer trust would hand it out for free — the trust list is keyed by public key and public
keys are public, so an Ed25519 dossier could name a trusted signer's key in `key_id` while
verifying under an attacker's `public_key`.

### Key-format and trust-file helpers

| Export | Purpose |
|---|---|
| `normalizePublicKey(key: string): string` | Reduce a key to its canonical raw 32-byte base64 form. Returns the input trimmed when it denotes no Ed25519 key, so exact-match comparison still works on the read path. |
| `isSupportedPublicKey(key: string): boolean` | Whether a key is one this project can verify against — raw base64, SPKI PEM, base64 SPKI DER, or a legacy minisign `RWT...` key. Use this on **write** paths (`keys add`), where `normalizePublicKey`'s pass-through would otherwise store a typo or a file path as a trusted key. |
| `publicKeysMatch(a: string, b: string): boolean` | Compare two keys after normalization. |
| `parseTrustedKeys(content: string): { entries: TrustedKeyEntry[]; problems: TrustedKeyProblem[] }` | Split trusted-keys file content into `{ publicKey, keyId }` entries, plus the lines it had to skip (each with a 1-based `line` and a `message`). The single definition of the file format — anything that lists, counts, or matches trusted keys goes through it, so `keys list` cannot disagree with what verification trusts. |
| `isKmsKeyIdentifier(value: string): boolean` | Whether a string is an AWS KMS key ARN, and so a usable trust-list entry for a KMS-signed dossier. Paired with `isSupportedPublicKey` on write paths, since a KMS ARN is not a public key. |
| `reportTrustedKeyProblems(problems, source?)` | Print unusable entries to stderr, capped at 3, with a re-add hint. Silent when there are none. |
| `trustedKeysFromContent(content, source?)` | Build the trust map from file content without touching the filesystem. `loadTrustedKeys` is this plus a file read. Pass `source` to name the file in warnings; omit it to stay silent. |

**Types:** `TrustedKeyEntry { publicKey, keyId }`, `TrustedKeyProblem { line, message }`.

Only Ed25519 keys normalize. An AWS KMS signature carries an ECDSA SPKI DER in `public_key`,
which `isSupportedPublicKey` reports as unsupported — KMS trust is matched on that exact
base64 string as written in the trust file.

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
| `parseAgentUsage(stdout)` | Token/cost/model from a claude headless result — one `--output-format json` object or a `stream-json` event stream. `modelUsage` is the source of record, never blended with the top-level `usage` block (#524); returns `AgentRunUsage \| null` |
| `parseOpenCodeUsage(stdout)` | The same, for an `opencode run --format json` JSONL event stream |
| `usageParserFor(cmd0)` | Pick the parser for a spawned binary (`opencode` basename → `parseOpenCodeUsage`, else `parseAgentUsage`) |
| `runsLogPath(home?)` | `~/.dossier/runs.jsonl` — the run log both `cli` and `sched` append to |
| `SCHED_DISPATCH_EVENT` | The `type` of the scheduler's dispatch-log preamble line; every parser above skips it |

Types: `AgentRunUsage` (all fields nullable — never fabricated) and `RunLogEntry` (one `runs.jsonl` line).
