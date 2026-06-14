# Skills Reframe Plan

**Status:** ✅ Executed (Tiers 0–3 + staleness sweep) · **Date:** 2026-06-14

> Deliberately left for manual follow-up: `docs/contributing/**` historical PR/session records (their `tools/*.js` refs are accurate to the state they document); hardcoded AWS account IDs / role ARNs in `signing-dossiers.md` (confirm these are intended public); the "Bug fixed in v1.0.2" historical notes in `signing-dossiers.md` (accurate history, low value but not removed).

Goal: reorient the documentation around the thesis **"Dossiers ARE skills"** — portable, signed, versioned, registry-distributed skills that run on any LLM tool. Bundle the cross-cutting staleness fixes (especially trust-pillar contradictions) into the same pass.

---

## 0. The positioning spine (canonical language to reuse everywhere)

These phrases are the source of truth; every reframed doc should draw from them so the message is consistent.

**One-liner:**
> A dossier is a skill — a reusable instruction set an AI executes — with **trust, versioning, and cross-tool portability** built in.

**What a dossier adds on top of a plain skill (the four pillars):**
- **Trust** — cryptographic signature + checksum, verified before execution
- **Versioning** — semantic versions you can pin
- **Distribution** — discoverable, installable from a registry
- **Portability** — the same file runs on Claude Code, Cursor, ChatGPT, any LLM

**Trigger skill (the concept to introduce):**
> A *trigger skill* is a thin Claude Code `SKILL.md` whose only job is to invoke a versioned, signed dossier (`ai-dossier run <registry-path>`). You get the skill's natural-language trigger *plus* the dossier's signing, versioning, and registry distribution. Install with `ai-dossier install-skill`, publish with `ai-dossier skill-export`.

**Analogy to use** (replaces "like Dockerfiles for AI automation"):
> Think npm or Docker Hub, but for AI skills — signed, versioned, shareable.

**Canonical facts (use these exact values):**
- Command: `ai-dossier` (never bare `dossier`)
- Registry URL: `https://dossier-registry.vercel.app` ⚠️ *see Open Question 1*
- Versions: cli `0.8.5`, core `1.3.5`, mcp-server `1.3.5`
- Verification: **single stage** — "Integrity Check (checksum + signature)" + risk assessment

---

## 1. Tier 0 — Positioning lines (exact before → after)

### `README.md`
- **L1 (H1):**
  - ❌ `# Dossier — Automation Instructions for AI Agents`
  - ✅ `# Dossier — Portable, Signed Skills for Any AI Agent`
- **L3 (tagline):**
  - ❌ `**Stop writing brittle scripts. Start writing instructions that AI executes intelligently.**`
  - ✅ `**Skills are easy to write. Dossiers make them trustworthy, versioned, and portable across every LLM tool.**`
- **L16-17 (Quick Concept):**
  - ❌ `Dossier turns plain-text instructions into executable workflows with built-in verification. Like Dockerfiles for AI automation — structured, portable, verifiable.`
  - ✅ `A dossier is a skill — a reusable instruction set an AI executes — with trust, versioning, and cross-tool portability built in. Think npm or Docker Hub, but for AI skills: signed, versioned, shareable.`
- **L57-58 (At a Glance What/Why):**
  - ❌ `**What**: Structured instruction files (.ds.md) that AI agents execute intelligently` / `**Why**: Replace brittle scripts with adaptive, verifiable automation…`
  - ✅ `**What**: Skills (.ds.md files) any AI agent can run — signed, versioned, portable across tools` / `**Why**: A plain skill lives in one tool and can be tampered with; a dossier is that same skill made verifiable, version-pinned, and shareable`
- **L62 (Status):** update `CLI v0.8.0` → `CLI v0.8.5`.
- **L165-178 ("Why Use Dossier?" / AGENTS.md table):** add a leading row/paragraph answering **"isn't this just a skill?"** (mirror the new FAQ entry — see §2.1). Keep the AGENTS.md table but demote it below the skill comparison.
- **L359-375 (Philosophy):** reframe `"Agents need structure. Dossiers provide it."` block to lead with skills-plus-trust; closing slogan `*Structure your agents. Not your scripts.*` → propose `*Skills you can trust.*` (see Open Question 2).

### `cli/README.md`
- **L7 (tagline):**
  - ❌ `Enforce cryptographic verification before executing dossiers.`
  - ✅ `Install, verify, and publish dossiers — portable, signed, versioned skills — for any LLM tool.`
- **L9-18 (Problem section):** add one sentence: a plain skill is unsigned, unversioned, and vendor-locked; the CLI is what makes a skill a trusted, portable dossier.

### `mcp-server/README.md`
- **L7:**
  - ❌ `MCP server for the dossier automation standard. Enables LLMs to discover, verify, and execute dossiers`
  - ✅ `MCP server that lets any MCP-capable LLM discover, verify, and run dossiers — portable, signed skills — through the Model Context Protocol.`

### `ARCHITECTURE.md`
- **L5-11 (Quick Overview):** lead with the spine one-liner + four pillars, then the existing three principles. Add `packages/worktree-pool` to the System Components diagram (L14-31) and Repository Structure (L128-142) — currently missing.

### `docs/index.md`
- **L3 + L33-46 ("What is Dossier?" / Key Components):**
  - ❌ `Dossier is an automation standard for AI agents that combines executable instructions with cryptographic verification.`
  - ✅ Lead with the spine one-liner; reframe the bullet list to the four pillars; add a "Dossiers and skills" key component.

### `docs/getting-started/README.md` & `docs/tutorials/mcp-quickstart.md`
- Add a one-line skill frame at the top of each. For mcp-quickstart (Claude Code users who already think in skills), explicitly: *"If you've used Claude Code skills, dossiers will feel familiar — they're skills you can verify, version, and pull from a registry."*

---

## 2. Tier 1 — Net-new skill content (outlines)

### 2.1 New FAQ entry — "Isn't a dossier just a skill?" (`docs/explanation/faq.md`)
- Insert as the **first** item in the "Dossiers vs. Alternatives" section (~L65) + TOC (L3-9).
- **Answer outline:** Yes — a dossier *is* a skill. The difference is what it adds: trust (sign/verify), versioning, registry distribution, cross-tool portability. Introduce the trigger-skill pattern.
- **Reuse** the existing comparison table (L153-166) — copy it, retarget the left column from `AGENTS.md` → `Plain skill (SKILL.md)`. Rows already fit: integrity verification, author verification, version compatibility, works across all LLMs.
- Also rewrite "What exactly is a dossier?" (L15-19) to lead with the spine one-liner; drop "Think of it as a recipe."

### 2.2 Trigger-skill section (`docs/guides/claude-code-integration.md`)
- New top section **"Dossiers as Claude Code skills"** before "Overview" (~L8).
- Content: the trigger-skill definition; `install-skill` / `skill-export` flow; a worked example (use the real `full-cycle` / `fleet-cycle` pattern); what it adds over a plain local SKILL.md.
- Reframe Overview (L1-11) into **two integration paths**: (a) trigger skills — recommended for shareable, versioned workflows; (b) MCP server — interactive authoring/execution.
- Update stale header "Last Updated: 2025-11-28" + fix bare `dossier keys add` (L206) → `ai-dossier`.

### 2.3 New `## Skills` section (`cli/README.md`)
- Add parallel to `## Registry Commands` (~L155).
- Document `install-skill` (dossier → Claude Code skill) and `skill-export` (skill → dossier) — **`skill-export` is currently undocumented entirely.**
- Explain the trigger-skill pattern + the four pillars a skill gains.

### 2.4 Adopter playbooks (`docs/guides/adopter-playbooks.md`)
- Solo Dev (L3-8) and OSS Maintainer (L46-92): end each in "export/install as a signed skill via the registry" (`skill-export` / `install-skill`), not "save a `.ds.md` and type its filename."
- Fix stale MCP config (L11-21, L137-149): local `node /path/to/.../dist/index.js` → `npx @ai-dossier/mcp-server`.

---

## 3. Tier 2 — De-explain (cut the labored "what is a dossier")

- **`docs/getting-started/installation.md`** (worst offender): rewrite "What Are Dossiers?" (L7-13) to the spine; **kill the "have the AI read README + PROTOCOL to learn what dossiers are" ceremony** (L52-64, L158-164, L347-349) — obsolete now that AIs know skills; compress the copy-paste preambles (L99-117, L213-223); add the "dossier vs SKILL.md" Q near the existing AGENTS.md FAQ (L466). Consider renaming/splitting (it's a 530-line quick-start titled "installation").
- **`docs/guides/dossier-guide.md`** "What Are Dossiers?" (L9-19): lead with spine; weave "skill" into the AGENTS.md/scripts comparisons.
- **`docs/explanation/README.md`** (L1-3, L33-38): reframe philosophy list to lead with the four pillars; add a "Dossiers and skills" concept link.

---

## 4. Tier 3 — Spec / reference (prose only; protect normative text)

**Safe to reframe (prose/positioning):**
- `specification.md` Abstract (L9-11) and §2 "What is a Dossier?" (L43-73) + appendix rationale (L824-839)
- `schema.md` Overview/Motivation (L20-56)
- `protocol.md` Overview (L9-18) and slogan (L1853)

**DO NOT change (normative):** field names, enums, MUST/SHOULD rules, `---dossier` delimiter spec, document-structure requirements. **Do not rename "dossier" → "skill" in normative text** — "dossier" is the defined format term. No schema change needed; `relationships` already expresses the trigger-skill link.

**Deprecated — do not reframe:** `docs/explanation/agents.md` (just verify its redirect targets carry the new framing; also leaks personal path `/home/yuvaldim/...` and has stale "MCP planned" content).

---

## 5. Staleness fixes (bundled — "Fix together")

| Severity | File:line | Issue | Fix |
|---|---|---|---|
| 🔴 trust | `cli/README.md:709-736` | "Limitations" claims sig-verify "basic", trusted keys "not implemented", `--run` "not implemented" — all ship | Rewrite to reflect shipped state |
| 🔴 trust | `cli/README.md:783-794` | Roadmap "v0.8.0 (Current)"; v1.0 lists shipped items as pending | Update to 0.8.5; move done items out of roadmap |
| 🔴 trust | `signing-dossiers.md:301-324` | Claims "5-stage verification" w/ "demo mode" stages — false | Correct to single Stage 1 (checksum + signature) + risk assessment |
| 🟡 | `signing-dossiers.md` | "v1.0.2" framing; `cli-work` branch URLs (L371); bare `dossier` | Update to current; `main` branch; `ai-dossier` |
| 🟡 | README L62, ci-cd L100, others | Stale versions (0.8.0, Node 18) | 0.8.5 / Node 20 |
| 🟡 | multiple | Registry URL drift (`registry.dossier.dev` vs `dossier-registry.vercel.app` vs `dossier.imboard.ai`) | Canonicalize — *Open Question 1* |
| 🟡 | multiple | Command drift `dossier` vs `ai-dossier` | Standardize on `ai-dossier` |
| 🟡 | `docs/explanation/faq.md`, `security-model.md` | Broken relative cross-refs (`./security/`, `./KEYS.txt`, repo-root paths from `docs/explanation/`) | Fix paths |
| 🟡 | `faq.md` | Frontmatter examples in YAML, contradict JSON `---dossier` spec | Convert to JSON |
| 🟡 | `faq.md:1094,1049,1793` | Stale models / pricing / `your-org/dossier` placeholder | Update |

---

## 6. Decisions (resolved 2026-06-14)

1. **Registry URL → `https://dossier-registry.vercel.app`.** Verified live (HTTP 200 at `/api/v1/dossiers`); `https://registry.dossier.dev` returns 404 (not serving). Align all *user-facing* docs to the working vercel URL. **Leave `registry/` CORS/OAuth config alone** — `registry.dossier.dev`/`dossier.imboard.ai` there are server-side intended origins, not user instructions.
2. **Slogan → `*Skills you can trust.*`** Replace `*Structure your agents. Not your scripts.*` in README/protocol.
3. **`installation.md` → split** into a true install doc + a separate quick-start, then reframe both.

---

## 7. Proposed execution sequence

1. **Spine + Tier 0 positioning lines** (README, cli/mcp READMEs, ARCHITECTURE, index, getting-started, mcp-quickstart) — the highest-reach, smallest-surface changes.
2. **Tier 1 net-new content** (FAQ entry, trigger-skill section, CLI Skills section, adopter playbooks).
3. **Tier 2 de-explain** (installation, dossier-guide, explanation/README).
4. **Tier 3 spec prose** (careful, prose-only).
5. **Staleness sweep** (interleaved per-file as each doc is touched; trust-critical items in step 1/2).

Each step: edits + `ai-dossier lint` on any touched `.ds.md` + a diff summary for review before moving on.
