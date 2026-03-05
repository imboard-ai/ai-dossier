# @ai-dossier/core

Core parsing, verification, and linting logic for the [Dossier](https://github.com/imboard-ai/ai-dossier) automation standard.

## Installation

```bash
npm install @ai-dossier/core
```

## API

### Parsing

```typescript
import { parseDossierContent, parseDossierFile, validateFrontmatter } from '@ai-dossier/core';

// Parse dossier content string
const { frontmatter, body } = parseDossierContent(content);

// Parse from file path
const parsed = parseDossierFile('./my-dossier.ds.md');

// Validate required fields
const errors = validateFrontmatter(parsed.frontmatter);
```

### Checksum Verification

```typescript
import { calculateChecksum, verifyIntegrity } from '@ai-dossier/core';

const hash = calculateChecksum(body);
const isValid = verifyIntegrity(body, expectedHash);
```

### Signature Verification

```typescript
import { verifySignature, verifyWithEd25519, loadTrustedKeys } from '@ai-dossier/core';

// Verify using trusted keys
const result = await verifySignature(frontmatter, body);

// Verify with a specific Ed25519 public key
const valid = verifyWithEd25519(data, signature, publicKeyPem);
```

### Linting

```typescript
import { lintDossier, lintDossierFile } from '@ai-dossier/core';

const results = lintDossier(content);
// or
const results = lintDossierFile('./my-dossier.ds.md');
```

### Formatting

```typescript
import { formatDossierContent } from '@ai-dossier/core';

const { content, changed } = formatDossierContent(rawContent, {
  sortKeys: true,
  updateChecksum: true,
});
```

## License

[AGPL-3.0](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)
