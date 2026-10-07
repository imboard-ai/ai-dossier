# Spec-Shaped Dossiers and Signature v3

A dossier is a valid [Agent Skill](https://agentskills.io/specification) as written: the file
the CLI signs is the file `skills-ref validate` accepts and a skills runtime loads, with no
conversion step in between. This page specifies that layout (the **spec shape**), how Dossier
fields are encoded inside it, the **v3 signature** that covers it, and how the older
**legacy** layout keeps working.

Applies to `@ai-dossier/core` 1.17.0 and `@ai-dossier/cli` 0.92.0 or later. Core 1.16.0
(CLI 0.91.0) reads and verifies the spec shape and v3 but does not write them. Older versions do not know
the layout: they find no checksum or signature at the top level and cannot verify the file,
so upgrade before you install spec-shaped dossiers.

Design record: [#1088](https://github.com/imboard-ai/ai-dossier/issues/1088).

---

## Walkthrough: author, sign, verify, install, validate

**1. Author.** Write the dossier in whichever layout is easier to edit. The
[authoring template](../../templates/dossier-template.md) uses the readable legacy JSON
layout, and that is fine: the signing step converts it. Save this as `hello.ds.md`:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Hello World",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "objective": "Print a greeting to confirm an agent can run a dossier",
  "risk_level": "low",
  "requires_approval": false,
  "risk_factors": []
}
---

# Hello World

## Actions to Perform

1. Print "Hello from a signed dossier".
```

**2. Sign.** Generate a key once, then sign:

```bash
ai-dossier keys generate --name my-key
ai-dossier sign hello.ds.md --method ed25519 --key my-key --signed-by "Your Name"
```

`sign` drops any old signature, fills `name` from the file name (`hello`) and `description`
from `objective` because the file declared neither, computes the body checksum, builds the
spec-shaped object, signs it under v3 and writes it back. Before writing, it parses its own
output again and refuses to write if that does not give back the same object. The file
now reads:

```markdown
---
name: 'hello'
description: 'Print a greeting to confirm an agent can run a dossier'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Hello World'
  dossier.version: '1.0.0'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Draft'
  dossier.objective: 'Print a greeting to confirm an agent can run a dossier'
  dossier.risk_level: 'low'
  dossier.requires_approval: 'false'
  dossier.risk_factors: '[]'
  dossier.checksum: '{"algorithm":"sha256","hash":"…"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","public_key":"…","signature":"…","signed_at":"…","signed_by":"Your Name"}'
---

# Hello World
…
```

Three details carry the format. Every value under `metadata` is a string. `"1.0"` is stored
as `'"1.0"'` because the bare text `1.0` would read back as a number (see
[Value encoding](#value-encoding)). And `covers: spec-frontmatter+body` says the signature
covers this exact frontmatter plus the body.

**3. Verify.** Trust your own public key (printed by `keys generate`), then verify:

```bash
ai-dossier keys add <public-key-base64> my-key
ai-dossier verify hello.ds.md
ai-dossier lint hello.ds.md
```

`verify` sees a spec-shaped file with `covers: spec-frontmatter+body`, rebuilds the v3
payload from the frontmatter as it sits on disk and checks the signature against it. Change
any covered byte, such as `dossier.risk_level`, a value from another tool under `metadata`,
or the body, and verification fails. `lint` runs the `spec-shape` rule, which checks the
file against the Agent Skills layout.

**4. Publish and install.**

```bash
ai-dossier publish hello.ds.md --namespace your-org/demo
ai-dossier install-skill your-org/demo/hello
```

The registry verifies the signature before it stores anything and keeps the file byte for
byte. `install-skill` copies the spec-shaped file to `~/.claude/skills/hello/SKILL.md`
unchanged, so it still verifies, and records the registry path in a `.dossier-source` file
next to it.

**5. Validate against the Agent Skills reference validator.**

```bash
skills-ref validate ~/.claude/skills/hello
```

The directory name matches `name`, the top level holds only Agent Skills fields, and every
`metadata` value is a string, so the validator accepts the file. You can run the same check
before publishing: copy the signed file to `hello/SKILL.md` and validate `hello/`. The repo's
`skills-spec` CI workflow does this for every example in [`examples/`](../../examples/) as
the CLI writes it, and that step is required.

The rest of this page specifies each piece.

---

## The two layouts

| | Legacy layout | Spec layout |
|---|---|---|
| Fence | `---dossier` (JSON or YAML), `---json`, `---yaml` or `---` | `---` (YAML), as the CLI writes it |
| Top level | every Dossier field | only `name`, `description`, and the optional `license`, `compatibility`, `allowed-tools` |
| Other Dossier fields | top level | `metadata["dossier.<field>"]`, one string per field |
| Checksum and signature | top-level `checksum`, `signature` | `metadata["dossier.checksum"]`, `metadata["dossier.signature"]` |
| Signature schemes | v1 (body only) and v2 (`frontmatter+body`) | v3 (`spec-frontmatter+body`) only |
| Written by | nothing, for unsigned input with default options. `format` keeps a signed legacy file legacy; `format --keep-legacy` and `checksum --update` keep any legacy file legacy | `sign`, `from-file`, `format`, `skill-export` |

A file is spec-shaped when its frontmatter has a `metadata` map with at least one key
starting with `dossier.`. A legacy file never has one. `parseDossierContent` reads both into
the same flat **logical** frontmatter (`risk_level`, `requires_approval`, `inputs`, …), so the
runner, MCP server, registry index and VS Code extension work the same on either layout.
It also returns `shape` (`legacy` or `spec`) and `rawFrontmatter` (the object as written),
which the v3 signature needs.

### Spec-layout rules

The parser rejects anything that would let two different files read as the same logical
dossier, or let a field sit where the signature scheme does not expect it:

- **Top level.** Only the five Agent Skills fields and `metadata`. A Dossier field at the top
  level (`risk_level:` next to `metadata`) is an error, never a second copy.
- **No `dossier.<agent-skills-field>`.** `metadata["dossier.name"]`, `dossier.description`,
  `dossier.license`, `dossier.compatibility` and `dossier.allowed-tools` are errors. Those
  fields live at the top level only.
- **Strings only.** Top-level values and every `metadata` value must be strings, as the Agent
  Skills spec requires.
- **No duplicates.** A field that appears twice, in YAML or in JSON, is an error.
- **No YAML merge keys** (`<<:`). YAML parsers disagree on whether to apply them, so a signer
  and a runtime could read different objects.
- **Other tools' keys are kept.** `metadata` keys outside the `dossier.` namespace belong to
  other tools. They are not part of the logical dossier, but the v3 signature covers them,
  and the CLI writers carry them over when they rewrite a file.

The Agent Skills layout limits also apply, checked by the `spec-shape` lint rule and by
`definitions.specShape` in [`dossier-schema.json`](../../dossier-schema.json):

| Field | Rule |
|---|---|
| `name` | required; lowercase letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`), at most 64 characters. The Agent Skills spec also requires it to match the skill's directory name, which `skills-ref validate` checks (lint and the schema do not); `install-skill` names the directory after the last segment of the registry path |
| `description` | required; 1–1024 characters |
| `compatibility` | at most 500 characters |
| `metadata` | required; string → string; must hold `dossier.dossier_schema_version`, `dossier.title`, `dossier.version`, `dossier.protocol_version`, `dossier.status`, `dossier.objective`, `dossier.checksum`, `dossier.risk_level`, `dossier.requires_approval` |

---

## Value encoding

`metadata` is a string-to-string map, and Dossier fields hold booleans, numbers, lists and
objects. The encoding round-trips without a schema lookup:

- **Encode.** A string is stored as is, unless the string itself would parse as JSON
  (`"true"`, `"123"`, `"1.0"`, `"[1]"`). Then it is stored JSON-quoted. Any other value
  (boolean, number, array, object, null) is stored as canonical JSON, with object keys sorted
  and no whitespace.
- **Decode.** `JSON.parse` the string if that succeeds, otherwise keep it as a string.

| Logical value | Stored as |
|---|---|
| `"Hello World"` | `Hello World` |
| `"1.0.0"` | `1.0.0` (not valid JSON, so it stays bare) |
| `"1.0"` | `"1.0"` (the bare text would decode to the number 1) |
| `"true"` (a string) | `"true"` |
| `true` | `true` |
| `["modifies_files"]` | `["modifies_files"]` |
| `[]` | `[]` |
| `{"required": [], "optional": [{"name": "count", "default": 3}]}` | `{"optional":[{"default":3,"name":"count"}],"required":[]}` |

Values JSON cannot represent exactly are refused rather than stored: `NaN`, `Infinity`, a YAML
date that was never quoted (quote it as a string), and `undefined` array entries.

The "Stored as" column is the string value. In the YAML file the writer quotes every one of
them (`'true'`, `'[]'`), as the walkthrough shows.

---

## Strict-YAML portability

A spec-shaped file is installed as is, so it has to read the same in every YAML parser that
loads skills, including the reference validator (strictyaml) and Python runtimes
(PyYAML, ruamel), not only in the JavaScript parser the CLI uses. The CLI writer
(`serializeSpecDossier` in core) follows these rules, and hand-edited files should too:

1. **Block style only.** No flow collections (`{…}`, `[…]`) anywhere in the frontmatter, and
   so no empty `{}` or `[]` either. The `spec-shape` lint rule reports flow style as an error.
   `ai-dossier format` rewrites flow or JSON frontmatter as block YAML without changing what
   the signature covers, provided the body has no trailing whitespace for it to trim.
2. **Quote every value.** Unquoted `true`, `1.0` or `2026-10-07` reads as a boolean, number or
   date, which the parser rejects as a non-string `metadata` value. The writer single-quotes
   every value and switches to double quotes with an explicit `\n` when a value contains a
   line break.
3. **No empty collections.** The writer omits `metadata` entirely when it would be empty, and
   an empty list field is the quoted string `'[]'`, not a YAML sequence.
4. **No DEL, C1 control or NEL characters** (`U+007F`–`U+009F`). The JavaScript parser accepts
   them, but strict readers reject them or fold NEL into a space, so a signed value would read
   back differently. The writer refuses them.
5. **Keys are plain only when safe.** A key is written unquoted only if it matches
   `^[A-Za-z0-9_.\-/]+$` and is not a word a YAML 1.1 reader turns into a boolean or null
   (`yes`, `no`, `on`, `off`, `y`, `n`, `true`, `false`, `null`, `~`, in lowercase,
   Capitalized or UPPERCASE form). Any other key is quoted.
6. **No merge keys**, as above.

A writer's own round-trip check proves nothing about strict readers, because it reparses with
the parser that wrote the file. To check portability, run the real `skills-ref validate` or a
Python YAML reader against the file.

---

## Signature v3

`signature.covers` names the scheme a signature was made under:

| `covers` | Scheme | Signed payload |
|---|---|---|
| absent (or `body`) | v1 | the body |
| `frontmatter+body` | v2 | `dossier-signature-v2`, newline, canonical JSON of the logical frontmatter without `signature`, newline, the body |
| `spec-frontmatter+body` | v3 | `dossier-signature-v3`, newline, canonical JSON of the **on-disk** spec-shaped frontmatter without `metadata["dossier.signature"]`, newline, the body |

Canonical JSON is the same deterministic serialization (sorted keys, no whitespace) for v2 and
v3. v3 covers the frontmatter as written, not the logical view, because a signature should
cover what is actually shipped. In practice that means:

- every top-level field and every `metadata` entry is covered, including `dossier.checksum`
  and other tools' keys; only the signature entry itself is left out;
- each value is covered as its exact string, so re-encoding `'["b", "a"]'` as `'["b","a"]'`
  invalidates the signature even though both decode to the same list;
- YAML formatting outside the values (quote style, indentation, key order, block or flow
  style) is not covered, because the payload is built from the parsed object, not the bytes.
  `format` can therefore turn flow frontmatter into block YAML and the signature still
  verifies (unless it also trims trailing whitespace from the body, which changes the body).

The scheme tag is inside the signed bytes, so a v3 signature cannot be replayed as v2 or v1,
or the other way round.

### Verification matrix

A verifier picks the scheme from `covers` and requires it to match the file's layout:

| File layout | `covers` | Result |
|---|---|---|
| legacy | absent or `body` | verified under v1 (body only) |
| legacy | `frontmatter+body` | verified under v2 |
| legacy | `spec-frontmatter+body` | **refused**: v3 covers only the spec layout |
| spec | `spec-frontmatter+body` | verified under v3 |
| spec | absent, `body` or `frontmatter+body` | **refused**: only v3 covers this layout |
| either | any other value | **refused**: unknown scheme |

Binding scheme to layout closes a downgrade: a spec-shaped rewrite of a legacy file decodes to
the same logical object, so its old v2 signature would still match the v2 payload while
vouching for on-disk bytes it never covered. An unknown `covers` value is refused rather than
treated as body-only, which would let anyone relabel a signature into the weakest scheme.

v1 and v2 stay verifiable indefinitely: earlier signed versions remain in the registry and
keep installing. In the CLI and the VS Code extension, a refusal is reported as a failed
signature check.

### At publish time

The registry checks a submitted signature with the same matrix before it stores anything:

- A signature that does not verify, an unknown `covers`, or a scheme that does not match the
  layout is rejected with **400 `INVALID_SIGNATURE`**. That includes a legacy minisign
  (`RWT…`) key, which gets a hint to re-sign, and an unsupported algorithm.
- An AWS KMS signature gets a structural check only (scheme and layout, a KMS key ARN in
  `key_id`, a base64 value), because the registry holds no cloud credentials. Clients verify
  it cryptographically on install.
- Unsigned dossiers can still be published.
- A successful publish (201) reports `signature: null` for an unsigned dossier, or
  `{ "status": "verified" | "not-checked", "covers": "…" }`.

The registry indexes the logical frontmatter and stores the submitted content byte for byte.
It never re-serializes, which would break a v3 signature.

---

## CLI behaviour

| Command | Legacy input | Spec-shaped input |
|---|---|---|
| `sign` | converts to the spec layout and signs under v3 | re-signs under v3, keeping other tools' `metadata` keys |
| `from-file` | builds a new dossier from a Markdown file in the spec layout, signed under v3 with `--sign` | — |
| `format` | **unsigned:** converts to the spec layout. **Signed:** stays legacy, since converting would orphan the signature. `--keep-legacy` always stays legacy | re-serializes the on-disk object, keeping key order and each value's exact string. It also trims trailing whitespace and extra trailing blank lines from the body; if that changes the body, `dossier.checksum` is updated and a v3 signature must be redone. Otherwise the signature still verifies |
| `checksum --update` | keeps the legacy layout | replaces only `dossier.checksum`; warns when a signed body changed |
| `verify` | v1 or v2 | v3 |
| `lint` | `legacy-layout` (info) | `spec-shape` (error) |
| `publish` | uploads as written, with a note that `sign` writes the spec layout | uploads as written |
| `install-skill` | a `---dossier` file is rendered as YAML with `x_source` (and `description` from `objective` when absent) added, so a v2 signature does not verify on the installed copy; other legacy fences are copied as is. Writes `.dossier-source` | copies the file byte for byte (a `---dossier`, `---json` or `---yaml` fence becomes `---`, which parses the same) and writes `.dossier-source` beside `SKILL.md` |
| `skill-export` | converts to the spec layout when it bumps the version or the skill is unsigned | publishes byte for byte with `--no-bump`; converts when it bumps the version |

**Lint rules.**

- `spec-shape` (error) runs on spec-shaped files. It checks the Agent Skills layout: name
  pattern and length, description length, string-only `metadata`, the required `dossier.*`
  keys, no Dossier fields at the top level, block-style YAML only. On a spec-shaped file every
  lint message names the on-disk key, for example `(in metadata["dossier.risk_level"])`.
- `legacy-layout` (info) runs on legacy files. It notes that the writers now emit the spec
  layout, and flags a `name` or `description` (or `objective`, when there is no
  `description`) that would fail the spec rules once the file is converted.

**`.dossier-source`.** A legacy install records its registry path as `x_source` in the
rendered frontmatter. A spec-shaped install cannot, because v3 covers every frontmatter field,
so `install-skill` writes the registry path to a `.dossier-source` file next to `SKILL.md`
(it writes one for legacy installs too). The collision check and `install-skill --list`,
`--all` and `--outdated` read it, and it is ignored unless it holds exactly one
registry path (`namespace/…/name`).

**`signatureDropped`.** When `skill-export` rewrites a signed skill (a version bump changes
covered bytes), the old signature no longer matches, so it is dropped with a warning and the
skill is published unsigned. With `--json` the result carries `"signatureDropped": true`.
Re-sign with `ai-dossier sign` and publish again to ship a signed version.

---

## Migrating from the legacy layout

Nothing forces a migration. Legacy files keep parsing, and their v1 and v2 signatures keep
verifying. Convert a dossier when you next publish it:

1. **Check the name first.** Run `ai-dossier lint`. A `legacy-layout` note about `name` or
   `description` means the converted file would fail `spec-shape`. A writer never renames a
   dossier, so an invalid `name` you declared is kept and you have to fix it yourself. The
   registry path is `namespace/name`, so renaming publishes under a new path.
2. **Convert by signing.** `ai-dossier sign <file>` converts any legacy file and signs it under
   v3. This is the only way to convert a **signed** legacy file: `format` keeps it legacy,
   since the new layout's bytes are not what the old signature covered, and
   `checksum --update` never changes the layout. Re-signing needs your signing key, so a
   dossier signed by someone else stays legacy until its author re-signs it.
3. **Unsigned files** can be converted with `ai-dossier format <file>` instead. Pass
   `--keep-legacy` to opt out.
4. **Publish a new version.** Earlier versions stay published in the legacy layout and keep
   verifying.
5. **Reinstall** skills you installed from the old version (`ai-dossier install-skill <name>`)
   to pick up the spec-shaped copy and its `.dossier-source` file.

After converting, edit the YAML by hand only if you follow the
[portability rules](#strict-yaml-portability), and re-sign afterwards. `sign` re-encodes every
`dossier.*` value canonically, so a hand-formatted JSON value comes out normalized.

**Authoring template.** [`templates/dossier-template.md`](../../templates/dossier-template.md)
stays in the legacy JSON layout on purpose. In the spec layout every structured field is a
one-line JSON string, which is much harder to fill in by hand. Author in the template and let
`sign` or `format` convert it.

---

## Related

- [Dossier Specification](specification.md) (§3.4 frontmatter)
- [Schema reference](schema.md): field definitions, which apply to the logical frontmatter in
  either layout
- [Signing guide](../guides/signing-dossiers.md)
- [Core API](core-api.md): `parseDossierContent`, `toSpecFrontmatter`/`fromSpecFrontmatter`,
  `buildVerificationPayload`, `renderSpecDossier`
- [Agent Skills specification](https://agentskills.io/specification)
