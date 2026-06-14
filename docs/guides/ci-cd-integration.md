# CI/CD Integration Guide

Integrate dossier verification and execution into your CI/CD pipeline with GitHub Actions. This guide covers the provided workflow templates, customization options, and troubleshooting.

## Overview

The Dossier project provides two reusable GitHub Actions workflow templates:

| Template | Purpose |
|----------|---------|
| [`verify-dossiers-on-pr.yml`](#verify-dossiers-on-pull-requests) | Verify changed `.ds.md` files on every pull request |
| [`run-dossier-on-schedule.yml`](#run-dossiers-on-a-schedule) | Execute dossiers on a cron schedule with failure alerts |

Both templates live in [`.github/workflows/templates/`](../../.github/workflows/templates/) and are designed to be copied into your own repository.

---

## Quick Setup

### 1. Copy the template

```bash
# From the ai-dossier repo (or download directly from GitHub)
mkdir -p .github/workflows

# For PR verification:
curl -o .github/workflows/verify-dossiers-on-pr.yml \
  https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/.github/workflows/templates/verify-dossiers-on-pr.yml

# For scheduled runs:
curl -o .github/workflows/run-dossier-on-schedule.yml \
  https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/.github/workflows/templates/run-dossier-on-schedule.yml
```

### 2. Customize for your project

Edit the workflow file to match your repository structure and requirements. See the sections below for configuration details.

### 3. Commit and push

```bash
git add .github/workflows/
git commit -m "ci: add dossier verification workflow"
git push
```

---

## Verify Dossiers on Pull Requests

**Template**: `.github/workflows/templates/verify-dossiers-on-pr.yml`

This workflow runs automatically when a PR modifies any `.ds.md` file. It performs two checks on each changed dossier:

1. **Verification** (`ai-dossier verify`) -- validates checksums, frontmatter structure, and integrity
2. **Linting** (`ai-dossier lint`) -- checks for common authoring issues and warnings

### How It Works

1. Detects `.ds.md` files changed between the PR branch and the base branch
2. Runs `ai-dossier verify --verbose` on each changed file
3. Runs `ai-dossier lint` on each changed file
4. Reports results as GitHub Actions annotations and a job summary
5. Fails the workflow (blocking merge) if any file fails verification or has lint errors

### Customization

**Change the target branch:**

```yaml
on:
  pull_request:
    branches:
      - main
      - develop  # Add additional branches
```

**Restrict to specific directories:**

```yaml
on:
  pull_request:
    paths:
      - 'dossiers/**/*.ds.md'       # Only check files in dossiers/
      - 'docs/dossiers/**/*.ds.md'   # Or another directory
```

**Use strict linting (treat warnings as errors):**

Replace the lint step command with:

```bash
ai-dossier lint "$file" --strict
```

**Pin the CLI version:**

```yaml
- name: Install @ai-dossier/cli
  run: npm install -g @ai-dossier/cli@0.8.5
```

---

## Run Dossiers on a Schedule

**Template**: `.github/workflows/templates/run-dossier-on-schedule.yml`

This workflow executes a dossier on a configurable cron schedule using Claude Code in headless mode. If execution fails, it automatically creates a GitHub issue with diagnostic details.

### How It Works

1. Checks out your repository
2. Installs `@ai-dossier/cli`
3. Verifies the target dossier
4. Executes the dossier with `ai-dossier run --headless --no-prompt`
5. On failure: creates a GitHub issue with a link to the workflow logs

### Customization

**Set the dossier to run:**

Edit the `env` section at the top of the workflow:

```yaml
env:
  DOSSIER: 'path/to/your-dossier.ds.md'
```

Or use a registry name:

```yaml
env:
  DOSSIER: 'my-org/weekly-check'
```

**Change the schedule:**

```yaml
on:
  schedule:
    # Every day at midnight UTC
    - cron: '0 0 * * *'

    # Every Friday at 17:00 UTC
    - cron: '0 17 * * 5'

    # First of every month at 09:00 UTC
    - cron: '0 9 1 * *'
```

See [crontab.guru](https://crontab.guru) for help with cron syntax.

**Run multiple dossiers:**

Duplicate the verify/run steps, or use a matrix strategy:

```yaml
jobs:
  run:
    strategy:
      matrix:
        dossier:
          - 'dossiers/readme-check.ds.md'
          - 'dossiers/dependency-audit.ds.md'
    steps:
      # ... setup steps ...
      - name: Run dossier
        run: ai-dossier run "${{ matrix.dossier }}" --headless --no-prompt
```

**Customize the failure issue:**

Edit the `actions/github-script` step to change labels, assignees, or the issue body:

```yaml
- name: Create issue on failure
  if: failure()
  uses: actions/github-script@v7
  with:
    script: |
      await github.rest.issues.create({
        owner: context.repo.owner,
        repo: context.repo.repo,
        title: `Dossier failed: my-dossier`,
        labels: ['bug', 'dossier'],
        assignees: ['your-username'],
        body: 'The scheduled dossier run failed. Check the logs.'
      });
```

---

## Environment Variables & Secrets

### Required for scheduled execution

| Variable | Where to set | Purpose |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Repository secret | API key for Claude Code (used by `ai-dossier run --headless`) |

### Optional

| Variable | Where to set | Purpose |
|----------|-------------|---------|
| `DOSSIER_REGISTRY_URL` | Repository variable or `env` | Custom registry URL for `ai-dossier` commands |
| `DOSSIER_REGISTRY_TOKEN` | Repository secret | Authentication token for private registries |
| `NODE_VERSION` | Workflow `env` | Node.js version (default: `22`) |

### Setting secrets in GitHub

1. Go to your repository **Settings** > **Secrets and variables** > **Actions**
2. Click **New repository secret**
3. Add `ANTHROPIC_API_KEY` with your API key value
4. (Optional) Add `DOSSIER_REGISTRY_TOKEN` if using a private registry

---

## Example: Weekly README Verification

A practical example that verifies your project README stays accurate by running a dossier weekly:

### 1. Create the dossier

```bash
ai-dossier create dossiers/weekly-readme-check
```

Edit `dossiers/weekly-readme-check.ds.md`:

```markdown
---dossier
{
  "title": "Weekly README Check",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "active",
  "objective": "Verify the project README accurately reflects the current state of the codebase",
  "risk_level": "low"
}
---

# Weekly README Check

## Actions
1. Read the project README.md
2. Compare documented features against the actual codebase
3. Check that installation instructions are still valid
4. Verify all code examples compile/run correctly
5. Confirm linked files and URLs are not broken

## Validation
- All documented features exist in the codebase
- Installation steps produce a working setup
- Code examples are syntactically valid
- No broken internal links
```

### 2. Add the checksum

```bash
ai-dossier checksum dossiers/weekly-readme-check.ds.md --update
```

### 3. Set up the workflow

Copy the scheduled template and update the `DOSSIER` env var:

```yaml
env:
  DOSSIER: 'dossiers/weekly-readme-check.ds.md'
```

### 4. Add the API key

Add `ANTHROPIC_API_KEY` as a repository secret (see [Environment Variables & Secrets](#environment-variables--secrets)).

---

## Troubleshooting

### Verification fails with "No checksum found"

The dossier is missing a checksum in its frontmatter. Generate one:

```bash
ai-dossier checksum path/to/dossier.ds.md --update
```

### Verification fails with "Checksum mismatch"

The dossier content was modified after the checksum was set. Regenerate:

```bash
ai-dossier checksum path/to/dossier.ds.md --update
```

### "No .ds.md files changed" — workflow skips

This is expected behavior. The PR verification workflow only runs when `.ds.md` files are modified. If no dossier files changed, the workflow completes immediately with no checks.

### Scheduled run fails with "command not found: claude"

The `ai-dossier run --headless` command requires Claude Code to be available. Ensure:
- `ANTHROPIC_API_KEY` is set as a repository secret
- The workflow installs `@ai-dossier/cli` before running

### Lint warnings vs. errors

The PR verification workflow distinguishes between lint severity levels:
- **Errors** (exit code 2): Block the PR -- must be fixed
- **Warnings** (exit code 1): Reported as annotations but do not block the PR

To treat warnings as errors, use `--strict` mode.

### Rate limiting on scheduled runs

If your scheduled runs hit API rate limits:
- Reduce the cron frequency
- Use `--dry-run` for non-critical checks
- Split dossiers across different schedules

---

## CLI Commands Reference

Commands used in the workflow templates:

| Command | Description |
|---------|-------------|
| `ai-dossier verify <file>` | Verify dossier integrity (checksums, structure) |
| `ai-dossier verify <file> --verbose` | Detailed verification output |
| `ai-dossier lint <file>` | Lint for authoring issues |
| `ai-dossier lint <file> --strict` | Treat warnings as errors |
| `ai-dossier run <file> --headless` | Execute in non-interactive mode |
| `ai-dossier run <file> --dry-run` | Verify without executing |
| `ai-dossier checksum <file> --update` | Add/update checksum in frontmatter |

See the full [CLI documentation](../../cli/README.md) for all available commands and options.
