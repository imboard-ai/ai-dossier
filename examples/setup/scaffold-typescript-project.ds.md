---
name: 'scaffold-typescript-project'
description: 'Scaffold a complete TypeScript project with CI, testing, linting, documentation, and worktree support — eliminating repetitive boilerplate setup'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Scaffold TypeScript Project'
  dossier.version: '1.0.0'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Draft'
  dossier.last_updated: '2026-03-09'
  dossier.objective: 'Scaffold a complete TypeScript project with CI, testing, linting, documentation, and worktree support — eliminating repetitive boilerplate setup'
  dossier.category: '["development","setup"]'
  dossier.tags: '["scaffold","typescript","boilerplate","ci","project-creation","github-actions"]'
  dossier.tools_required: '[{"check_command":"node --version","name":"node","version":">=20.0.0"},{"check_command":"gh --version","name":"gh","version":">=2.0.0"},{"check_command":"git --version","name":"git","version":">=2.30.0"}]'
  dossier.estimated_duration: '{"max_minutes":15,"min_minutes":5}'
  dossier.risk_level: 'medium'
  dossier.risk_factors: '["modifies_files"]'
  dossier.requires_approval: 'false'
  dossier.destructive_operations: '["Creates multiple files in the target directory","Runs npm install (modifies node_modules and package-lock.json)"]'
  dossier.inputs: '{"optional":[{"default":"","description":"GitHub organization for the repo (skip if repo already exists)","example":"imboard-ai","name":"github_org","type":"string"},{"default":"MIT","description":"License type","example":"AGPL-3.0","name":"license","type":"string"},{"default":"biome","description":"Linter to use: biome or eslint","example":"eslint","name":"linter","type":"string"},{"default":"22","description":"Node.js version for CI matrix","example":"20","name":"node_version","type":"string"},{"default":false,"description":"Skip worktree support setup","name":"skip_worktrees","type":"boolean"},{"default":false,"description":"Skip GitHub repo creation (use if repo already exists)","name":"skip_github_repo","type":"boolean"},{"default":"","description":"Author name for package.json","example":"Yuval Dimnik","name":"author_name","type":"string"},{"default":"","description":"Author email for package.json","example":"yuval.dimnik@gmail.com","name":"author_email","type":"string"}],"required":[{"description":"Name of the project (kebab-case, used for package.json name and repo)","example":"my-awesome-tool","name":"project_name","type":"string"},{"description":"Absolute path to the project root directory","example":"/home/user/projects/my-awesome-tool/main","name":"project_dir","type":"string"},{"description":"One-line project description","example":"CLI tool for managing AI agent workflows","name":"description","type":"string"}]}'
  dossier.outputs: '{"files":[{"description":"Package manifest with ESM, scripts, devDependencies","path":"package.json"},{"description":"TypeScript config (strict, ES2022, ESNext modules)","path":"tsconfig.json"},{"description":"Comprehensive gitignore for Node/TypeScript","path":".gitignore"},{"description":"GitHub Actions CI (typecheck + lint + test)","path":".github/workflows/ci.yml"},{"description":"AI agent behavioral rules and project context","path":"AGENTS.md"},{"description":"Vitest test runner configuration","path":"vitest.config.ts"},{"description":"Example environment variables","path":".env.example"},{"description":"Entry point placeholder","path":"lib/index.ts"}]}'
  dossier.checksum: '{"algorithm":"sha256","hash":"a09b457d3865c2da13534a862f47230456ed75a34a9252e80efab31dab63cf7c"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"sLShjpjaTL1E3rkWhotfUPINLftGXBJzvMA1S5HRTFnpK3YGIuvGo/KT9lQjS7vT1GzbhifxoX1PA9j/cmOMAA==","signed_at":"2026-10-07T12:15:20.891Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
---
# Scaffold TypeScript Project

## Objective

Scaffold a complete TypeScript project with CI pipeline, testing, linting, documentation, environment management, and optionally worktree support. The resulting project should pass all checks (`typecheck + lint + test`) out of the box.

## Constraints

These are non-negotiable requirements the agent must follow:

- **ESM**: `"type": "module"` in package.json -- all imports use ESM
- **TypeScript strict mode**: `"strict": true` in tsconfig.json
- **Target**: ES2022 or later, with `"module": "ESNext"` and `"moduleResolution": "Bundler"`
- **Test runner**: Vitest (not Jest) -- tests co-located in `lib/__tests__/*.test.ts`
- **Source layout**: Source code in `lib/`, build output in `dist/`
- **CI**: GitHub Actions workflow on `main` branch, running typecheck + lint + test
- **AGENTS.md**: Every scaffolded project must include an AGENTS.md with build commands and code style conventions
- **Dev script**: Must use `node --env-file=.env --import tsx` for local development (not ts-node)

## Decision Points

### Linter choice (input: `linter`)
- **Biome** (default): All-in-one lint + format. Recommended for new projects.
- **ESLint**: When React/specific ecosystem plugins are needed.

### Worktree support (input: `skip_worktrees`)
- **Enable** (default): Sets up the project directory as `main/` worktree with a `WORKTREES.md` guide. Required for parallel agent development.
- **Skip**: For small scripts or throwaway projects.

### GitHub repo creation (input: `skip_github_repo`)
- **Create**: When `github_org` is provided and repo doesn't already exist.
- **Skip**: For local experiments or existing repos.

## Known Pitfalls

- **`import.meta.url` requires ESNext modules**: If tsconfig uses `"module": "CommonJS"`, TypeScript will error on `import.meta.url`. The module setting must be `"ESNext"`.
- **`--env-file` requires Node 20.6+**: The `node --env-file=.env` flag doesn't exist in older Node versions. The `engines` field in package.json must enforce `>= ${node_version}`.
- **CI/local parity**: `package-lock.json` must be committed for `npm ci` to work in CI. If the agent uses `npm install` locally, it must commit the lockfile.
- **Biome schema version**: Use `https://biomejs.dev/schemas/2.0.0/schema.json` -- older schema versions cause validation warnings.

## Validation

- [ ] `npm run check` passes (typecheck + lint + test -- all three)
- [ ] `npm run dev` starts without errors
- [ ] `package.json` has `"type": "module"`
- [ ] `tsconfig.json` has `"strict": true` and `"module": "ESNext"`
- [ ] GitHub Actions CI workflow exists at `.github/workflows/ci.yml`
- [ ] `.gitignore` covers `node_modules/`, `dist/`, `.env`, IDE files
- [ ] `AGENTS.md` exists with project structure and build commands
- [ ] `.env.example` exists
- [ ] Git repo initialized with initial commit
- [ ] If worktrees enabled: project directory is `main/` and `WORKTREES.md` exists
