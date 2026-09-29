# AI Dossier for VS Code

Editor support for [AI Dossier](https://github.com/imboard-ai/ai-dossier) files (`*.ds.md`).
Everything runs inside the extension: `@ai-dossier/core` is bundled, so the `ai-dossier` CLI does
not need to be installed.

## Features

- **Diagnostics** - the frontmatter is parsed, checked against `dossier-schema.json`, and run through
  the core lint rules. Problems appear inline on the offending key, on open, on save, and (debounced)
  while typing. Both real frontmatter shapes work: `---dossier` + JSON, and standard `---` + YAML.
- **Completion and hover** - top-level keys and enum values (`status`, `risk_level`, `content_scope`,
  booleans) with descriptions, generated from `dossier-schema.json`.
- **Snippets** - `dossier` (frontmatter) and `ds-objective`, `ds-prerequisites`, `ds-context`,
  `ds-decisions`, `ds-constraints`, `ds-pitfalls`, `ds-validation`, `ds-troubleshooting`.
- **Dossier: Verify** - checksum and Ed25519 signature check, with the `~/.dossier/trusted-keys.txt`
  trust list. AWS KMS signatures are reported as "not verifiable here"; use `ai-dossier verify`.
- **Dossier: Dry-run preview** - the commands, files, network calls, and env vars a dossier appears to
  use, with a risk score, in the "AI Dossier" output channel. This is a *static* preview from
  pattern analysis of the code fences; it is not a record of what would run and is not a sandbox.
- **Dossier: New from template** - scaffolds a lint-clean dossier with a valid checksum.

## Settings

| Setting | Default | |
|---|---|---|
| `aiDossier.validate.enable` | `true` | Turn diagnostics on or off |
| `aiDossier.validate.debounceMs` | `300` | Delay after typing before re-validating |
| `aiDossier.lint.rules` | `{}` | Severity overrides, e.g. `{"objective-quality": "off"}` |

## Install

The Marketplace listing is pending. Until then, install the `.vsix`:

1. Download `ai-dossier-vscode-<version>.vsix` from the
   [`vscode-v*` releases](https://github.com/imboard-ai/ai-dossier/releases).
2. `code --install-extension ai-dossier-vscode-<version>.vsix`, or in VS Code run
   **Extensions: Install from VSIX...**.

## Develop

```bash
make build-core                       # the extension bundles ../core/dist
npm test --workspace=ai-dossier-vscode
npm run package --workspace=ai-dossier-vscode   # writes dist/ai-dossier-vscode.vsix
```

Pure logic (`src/frontmatter.ts`, `diagnostics.ts`, `completion.ts`, `verify.ts`, `dryrun.ts`,
`template.ts`) has no `vscode` import and is covered by unit tests; `src/extension.ts` is the thin glue.
Releases: bumping `version` in `package.json` on `main` makes `.github/workflows/vscode-release.yml`
attach the `.vsix` to a `vscode-v<version>` GitHub release.
