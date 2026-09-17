---dossier
{
  "dossier_schema_version": "1.0.0",
  "protocol_version": "1.0",
  "name": "publish-dossier",
  "title": "Publish an imboard-ai Dossier or Skill",
  "version": "1.1.3",
  "status": "Stable",
  "last_updated": "2026-09-17",
  "objective": "Edit, sign with the team key, lint, verify and publish a dossier or skill to the imboard-ai registry namespace, then refresh every machine — the exact recipe, so no agent rediscovers the signing and login walls",
  "category": [
    "development",
    "documentation"
  ],
  "tags": [
    "dossier",
    "registry",
    "publish",
    "sign",
    "ed25519",
    "skills",
    "imboard-ai",
    "meta"
  ],
  "risk_level": "low",
  "requires_approval": false,
  "risk_factors": [
    "network_access",
    "requires_credentials"
  ],
  "tools_required": [
    {
      "name": "ai-dossier",
      "description": "Dossier CLI 0.9.1+",
      "check_command": "ai-dossier --version"
    },
    {
      "name": "ssh",
      "description": "To refresh sibling machines (wls, hcc, hcc2)",
      "check_command": "ssh -V"
    }
  ],
  "inputs": {
    "required": [
      {
        "name": "target",
        "description": "Registry name to update (e.g. imboard-ai/git/ship-issue) or a new local .ds.md path",
        "type": "string",
        "example": "imboard-ai/git/ship-issue"
      }
    ],
    "optional": [
      {
        "name": "bump",
        "description": "patch | minor | major",
        "type": "string",
        "default": "patch"
      },
      {
        "name": "changelog",
        "description": "One-line changelog for the registry",
        "type": "string"
      }
    ]
  },
  "outputs": {
    "files": [
      {
        "path": "<work-dir>/<name>.ds.md",
        "description": "The signed file that was published",
        "format": "markdown"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "88448b38d34f58c38df5b6a8d8890463b58923d29a1292b461e415f0768e3ff5"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "Uc0BIVX52CC0vppxMctWNZrEM0hLU9CHWAFl8hrs8StGirTiRopJGBy6qf8Rs0CAhFiNov7xWbIPkuWD0F5aDw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-17T06:50:10.956Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Publish an imboard-ai Dossier or Skill

## Objective

One deterministic path from "I need to change dossier X" to "X@new-version is in the registry and every machine uses it". This dossier exists because the same walls were hit repeatedly: stale CLI copies giving wrong lint results, an expired registry login, the wrong signing key, and skills not refreshed on sibling machines.

## Prerequisites

- [ ] `ai-dossier --version` prints **0.9.1 or newer**. Beware of shadow copies: a repo-local `node_modules/.bin/ai-dossier` or a stray `~/node_modules` shadows the global install and lints with an older schema. When in doubt, call the global binary by absolute path (`$(npm root -g)/@ai-dossier/cli/bin/ai-dossier`).
- [ ] `ai-dossier whoami` shows `Organizations: imboard-ai`. If it says **Credentials expired**, a human must run `ai-dossier login --registry public` in a real terminal (the OAuth device flow refuses non-TTY sessions). Do not try to script around it.
- [ ] The team signing key exists: `~/.dossier/imboard-ai.pem` (ed25519, key id `imboard-ai`). Its public key is in `~/.dossier/trusted-keys.txt`. Do **not** sign with any other key that may be lying around (`yuval.pem`, `imboard-ai-2026.pem`) — the registry history should show one signer.

## Actions to Perform

### Step 1: Get the current published file

Never edit a clone of dossier-content and never commit dossiers to an infra repo; the registry is the source of truth.

```bash
ai-dossier pull <target> --force
cp ~/.dossier/cache/<target>/<latest-version>.ds.md ./<name>.ds.md
```

For a **new** dossier start from `ai-dossier create` or the `imboard-ai/meta/create-dossier-and-skill` dossier.

### Step 2: Edit

- Body: make the change. Keep instructions terse and imperative.
- Frontmatter (JSON between `---dossier` and `---`): bump `version` (semver), set `last_updated`, and **delete the `checksum` and `signature` objects** — signing regenerates them.
- Lint rules that bite:
  - `protocol_version` is required (`"1.0"`).
  - Any external URL in the body must be declared in `external_references` (url, description, type, trust_level, required) AND `content_scope` must be `"references-external"` AND `risk_factors` must include `network_access`. Easiest: do not add URLs.
  - `risk_factors` is a strict enum (`modifies_files`, `deletes_files`, `modifies_cloud_resources`, `requires_credentials`, `network_access`, `executes_external_code`, `database_operations`, `system_configuration`). Describe anything else in `destructive_operations` prose.
  - Skills (`imboard-ai/skills/*`) are stored as JSON-frontmatter dossiers; the YAML `SKILL.md` under `~/.claude/skills` is a rendered install. Lint the `.ds.md`, not the rendered file.
- Shell snippets that must expand (`$(date …)`) need an **unquoted** heredoc; quoted `<<'EOF'` pastes them literally.

### Step 2b: Record evidence for every rule you changed

`evidence add` computes a checksum from the current body when Step 2 has already deleted the frontmatter's one (`sign` overwrites it properly in Step 3 regardless), so there's no need to restore it first. For each rule/section you added or changed, record why:

```bash
ai-dossier evidence add <name>.ds.md \
  --anchor "<heading or rule as written in the body>" \
  --rationale "<one or two sentences: what failed / what this prevents>"
```

`--session` no longer needs a manual incantation: `evidence add` (cli >= 0.49.0) defaults it on its own — `AI_DOSSIER_SESSION_ID`, else the newest transcript under `~/.claude/projects/` for provider `claude-code` — and prints which source it used. A placeholder-looking value (e.g. a copied example) is rejected, not silently recorded (ai-dossier#750); pass `--session` explicitly only when the default picks the wrong one.

Skip only when the change is cosmetic. The sidecar `<name>.evidence.json` is published next to the dossier by `ai-dossier publish`; it is never loaded on `run`. See `docs/guides/authoring-evidence.md` for the full record format and workflow.

### Step 3: Sign, lint, verify — in this order, signing last

```bash
ai-dossier sign <name>.ds.md --method ed25519 --key ~/.dossier/imboard-ai.pem --key-id imboard-ai --signed-by "Yuval Dimnik <yuval.dimnik@gmail.com>"
ai-dossier evidence sync <name>.ds.md
ai-dossier lint <name>.ds.md      # must print: no issues found
ai-dossier verify <name>.ds.md    # must print: Verification passed
```

If lint reports anything, fix it and **sign again** — any edit after signing invalidates the signature.

### Step 4: Publish to the right namespace

The default namespace is bare `imboard-ai/`; always pass the family explicitly:

```bash
ai-dossier publish <name>.ds.md --namespace imboard-ai/git --changelog "<what changed>" -y      # workflow dossiers
ai-dossier publish <name>.ds.md --namespace imboard-ai/skills --changelog "<what changed>" -y   # skills
ai-dossier publish <name>.ds.md --namespace imboard-ai/meta --changelog "<what changed>" -y     # meta/authoring
```

Confirm: `ai-dossier info <target> --json` shows the new version (CDN may lag up to 30 s).

### Step 5: Refresh every machine

Dossiers run with `--pull` resolve the latest version automatically, but caches and installed skills do not:

```bash
# from wls (the only host with ssh reach to the others):
bash scripts/refresh-fleet.sh                 # all of wls, hcc, hcc2
bash scripts/refresh-fleet.sh --hosts hcc2    # a subset
```

The script pulls the dossier caches, reinstalls skills and regenerates opencode wrappers on each host, and sources nvm on the remote shells so `ai-dossier` resolves. For a single host, the manual fallback is `ssh <host> 'source ~/.nvm/nvm.sh; ai-dossier pull <target> --force'`.

### Step 6: Coordinated bumps

When a change spans a protocol shared by several dossiers (e.g. the runstate milestones used by the whole `imboard-ai/git/*` issue-workflow family), publish **all** affected dossiers in one pass so the protocol is never half-present.

## Validation

- [ ] Global CLI 0.9.1+ used (no shadow copy)
- [ ] `whoami` shows imboard-ai (login is a human step)
- [ ] Signed with `~/.dossier/imboard-ai.pem`, key id `imboard-ai`
- [ ] `lint` clean and `verify` passed on the exact file published
- [ ] Published to an explicit `imboard-ai/<family>` namespace
- [ ] `info` shows the new version
- [ ] Caches, skills and opencode wrappers refreshed on wls, hcc, hcc2 (scripts/refresh-fleet.sh)

## Troubleshooting

**Lint passes in one directory and fails in another**: a different `ai-dossier` binary resolved. Use the absolute global path.
**`signer not in trusted list`**: add the public key with `ai-dossier keys add <base64-pubkey> imboard-ai` on that machine.
**`Non-interactive session detected. Cannot run OAuth flow`**: login needs a real TTY; ask the human.
**Publish blocked by an agent permission classifier**: prepare the signed file and hand the exact `publish` command to the human, or have them add an allow rule for `ai-dossier publish`.
**`--issue 0` rejected by worktree-pool**: fixed in 0.5.1; use a real issue number.
