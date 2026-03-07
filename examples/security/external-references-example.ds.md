---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "External References Example",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Demonstrate how to properly declare external references in a dossier",
  "category": ["security"],
  "tags": ["external-references", "trust", "example"],
  "risk_level": "low",
  "content_scope": "references-external",
  "external_references": [
    {
      "url": "https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/README.md",
      "description": "Project README fetched for validation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": true
    },
    {
      "url": "https://registry.npmjs.org/@ai-dossier/cli",
      "description": "NPM registry metadata for version check",
      "type": "api",
      "trust_level": "trusted",
      "required": false
    }
  ]
}
---

# External References Example

This example dossier demonstrates how to properly declare external references when your dossier body links to or fetches external URLs.

## Why Declare External References?

When a dossier body contains external URLs, those URLs represent a **transitive trust risk** — the dossier's checksum and signature verify the *instructions*, but not the content at those URLs. Declaring external references makes this explicit:

1. **Transparency**: Readers can see all external dependencies at a glance
2. **Trust chain**: Each URL has an explicit trust level
3. **Linting**: The `external-references-declared` linter rule catches undeclared URLs
4. **Agent behavior**: LLM agents can make informed decisions about fetching external content

## Schema Fields

Set `content_scope` to `"references-external"` and declare each URL in `external_references` with its type, trust level, and whether it's required. See the [schema reference](../../docs/reference/schema.md#external-references) for full field documentation.

## Actions to Perform

### Step 1: Verify External References

Fetch the README from the project repository:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/README.md

Confirm it contains the expected project description.

### Step 2: Check NPM Registry (Optional)

Query the NPM registry for the latest CLI version:
https://registry.npmjs.org/@ai-dossier/cli

## Validation

- [ ] All external URLs in the body are declared in `external_references`
- [ ] `content_scope` is set to `"references-external"`

## Notes

- URL prefix matching is supported: declaring `https://registry.npmjs.org` covers `https://registry.npmjs.org/@ai-dossier/cli`
- See [PROTOCOL.md](../../PROTOCOL.md) for linter rule details and auto-exempt URL patterns
