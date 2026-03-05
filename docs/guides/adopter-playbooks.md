# Dossier Adopter Playbooks

## Solo Developer (5 minutes)

### Goal
Get started with dossiers in your personal projects with minimal setup.

### Steps

1. **Install MCP integration (Claude Code) or use the CLI**
   - **Option A (MCP)**: Add to `~/.claude/settings.local.json`:
     ```json
     {
       "mcpServers": {
         "dossier": {
           "command": "node",
           "args": ["/path/to/dossier/mcp-server/dist/index.js"]
         }
       }
     }
     ```
     (Replace `/path/to/dossier` with your actual cloned repo path)
   - **Option B (CLI)**: Install and use `npx @ai-dossier/cli verify <dossier-path>` or `ai-dossier verify <dossier-path>` directly

2. **Try the Hello Dossier example**
   - Copy the **Hello Dossier** block from the README into your LLM
   - Watch it execute and validate

3. **Create your first dossier**
   - Start with a task you do regularly (e.g., publish a small library, run tests)
   - Copy the template from `templates/dossier-template.md`
   - Fill in the objective and steps for your task
   - Add one `validate:` rule that proves success (e.g., "tag vX.Y.Z exists")

4. **Save and reuse**
   - Save your dossier as `my-task.ds.md` in your project
   - Reference it in future work: "Execute my-task.ds.md"

### Example Use Cases
- **Publishing workflow**: Build → test → version → publish → tag
- **Local development setup**: Install deps → configure env → start services
- **Code review checklist**: Run linter → check tests → verify docs updated

---

## OSS Maintainer (15 minutes)

### Goal
Add dossiers to your open-source project to help contributors and maintainers.

### Steps

1. **Create a dossiers directory**
   ```bash
   mkdir -p dossiers
   ```

2. **Create your first maintainer dossier**
   - Start with a reality check: `/dossiers/readme-reality-check.ds.md`
   - Reference your actual repo files and structure
   - Include validation rules that check README claims against code

3. **Add a "Run Reality Check" badge to README**
   ```markdown
   [![Run Reality Check](https://img.shields.io/badge/Dossier-Run%20Reality%20Check-blue)](https://raw.githubusercontent.com/YOUR-ORG/YOUR-REPO/main/dossiers/readme-reality-check.ds.md)
   ```

4. **Integrate with CI for validation**
   - Add to your GitHub Actions workflow:
     ```yaml
     - name: Checkout dossier repo
       uses: actions/checkout@v3
       with:
         repository: imboard-ai/ai-dossier
         path: dossier-tools

     - name: Verify README reality check
       if: contains(github.event.pull_request.changed_files, 'README.md') || contains(github.event.pull_request.changed_files, 'docs/')
       run: |
         npx @ai-dossier/cli verify dossiers/readme-reality-check.ds.md
     ```

5. **Document dossier usage in CONTRIBUTING.md**
   - Explain that contributors can use dossiers for complex maintainer tasks
   - Encourage contributors to propose new dossiers via PR

### Example Dossiers for OSS Projects
- **New contributor onboarding**: Setup dev environment, run first build
- **Release process**: Version bump → changelog → tag → publish
- **Security audit**: Check dependencies → scan for secrets → validate configs
- **Documentation sync**: Verify examples work → check API docs match code

---

## Platform Team (1–2 hours to MVP)

### Goal
Create a governed, validated workflow system for your platform operations.

### Phase 1: Author Core Dossiers (30 min)

1. **Identify your three critical workflows**
   - Example: `project-init.ds.md`, `deploy.ds.md`, `rollback.ds.md`

2. **Create dossiers with explicit validations**
   - Use the JSON schema frontmatter for structured metadata
   - Define clear prerequisites, inputs, and success criteria
   - Include risk assessment and approval requirements

3. **Example structure for `deploy.ds.md`**:
   ```markdown
   ---dossier
   {
     "dossier_schema_version": "1.0.0",
     "title": "Production Deploy",
     "risk_level": "high",
     "requires_approval": true,
     "prerequisites": ["CI passing", "Staging validated"],
     "validation": {
       "success_criteria": [
         "Health check returns 200",
         "New version tag exists",
         "Rollback plan generated"
       ]
     }
   }
   ---

   # Dossier: Production Deploy

   [Detailed steps...]
   ```

### Phase 2: Integrate with MCP (15 min)

1. **Roll out MCP server configuration** to team members:
   ```json
   {
     "mcpServers": {
       "dossier": {
         "command": "node",
         "args": ["/shared/path/to/dossier/mcp-server/dist/index.js"],
         "env": {
           "DOSSIER_REGISTRY": "https://your-registry.example.com/dossiers"
         }
       }
     }
   }
   ```
   (Set up a shared location or clone the repo for each team member)

2. **Test with the team** using a safe dossier first

### Phase 3: Add Safety Gates (30 min)

1. **Add validation checks to dossiers**:
   - Health checks after deployment
   - Artifact signature verification
   - Migration status confirmation
   - Rollback plan generation

2. **Configure approval workflows**:
   - High-risk dossiers require explicit `requires_approval: true`
   - Include clear risk factors in metadata
   - Document destructive operations

3. **Example validation block**:
   ```yaml
   validation:
     success_criteria:
       - "kubectl get deployment myapp shows 3/3 ready"
       - "curl https://myapp.com/health returns 200"
       - "DataDog shows no error spike"
       - "Rollback dossier generated at rollback/{{timestamp}}.ds.md"
   ```

### Phase 4: Document Failure Playbooks (15 min)

Create a **failure response guide** for when validations fail:

```markdown
## When Validations Fail

### Health Check Failed
1. Check pod logs: `kubectl logs -l app=myapp`
2. Verify config map: `kubectl describe cm myapp-config`
3. Execute rollback dossier: `rollback-{{timestamp}}.ds.md`

### Database Migration Failed
1. DO NOT PROCEED with deployment
2. Check migration logs in `migrations/logs/`
3. Execute rollback dossier: `rollback-migration.ds.md`
4. Alert on-call DBA

[More scenarios...]
```

### Phase 5: CI/CD Integration (Optional, 15 min)

1. **Gate production deploys on dossier verification**:
   ```yaml
   - name: Checkout dossier tools
     uses: actions/checkout@v3
     with:
       repository: imboard-ai/ai-dossier
       path: dossier-tools

   - name: Verify deploy dossier
     run: |
       npx @ai-dossier/cli verify dossiers/deploy.ds.md

   - name: Execute deploy
     run: # ... deployment steps
   ```

2. **Generate evidence artifacts**:
   - Each dossier execution produces a timestamped log
   - Store in artifact registry for audit trail
   - Link back to PR/commit

---

## Patterns that Work Well

### Evidence-Based Outputs
Include file:line references in success messages so claims are verifiable:

```markdown
Success:
- ✓ Feature flag enabled (src/config/features.ts:42)
- ✓ Migration applied (migrations/003_add_users.sql executed)
- ✓ Tests passing (23 tests, 0 failures)
```

### Progressive Disclosure
Use different levels of dossiers:

- **Atomic dossiers** (`atomic/` directory): Quick, focused demos (< 2 min)
- **Composed dossiers**: Real production workflows combining multiple atomics
- **Registry**: Document relationships and execution order

Example:
```
dossiers/
├── atomic/
│   ├── validate-config.ds.md      # 30s
│   ├── backup-db.ds.md             # 1 min
│   └── deploy-service.ds.md        # 2 min
└── production-deploy.ds.md         # Composes the above
```

### Trust-but-Verify
Design dossiers with checkpoint confirmations:

```markdown
## Actions
1. Analyze current deployment state
2. Generate deployment plan
3. **[CHECKPOINT]** Show plan to operator, require approval
4. Execute deployment steps
5. **[CHECKPOINT]** Verify health checks, require confirmation
6. Finalize and clean up
```

### Rollback Dossiers
Every effectful dossier should generate a rollback dossier:

```markdown
## Actions
- Execute migration
- **Generate rollback dossier**: Save `rollback-migration-{{timestamp}}.ds.md` with:
  - Exact steps to reverse this migration
  - Current state snapshot
  - Contact info for escalation
```

### Secrets Management
Never hardcode secrets in dossiers:

```markdown
## Prerequisites
- AWS credentials configured (via `aws configure` or env vars)
- Database connection available at $DATABASE_URL
- API key set in environment: $API_KEY

## Validation
- Check: AWS credentials exist (don't print them)
- Check: Can connect to database (don't expose connection string)
```

---

## Common Mistakes to Avoid

### Don't: Create Giant Monolithic Dossiers
```markdown
# ❌ Bad: mega-deploy-everything.ds.md (300 lines)
# Does: DB migration + app deploy + DNS update + monitoring setup
```

**Instead**: Break into atomic dossiers that compose
```markdown
# ✓ Good:
# - atomic/migrate-db.ds.md
# - atomic/deploy-app.ds.md
# - atomic/update-dns.ds.md
# - production-deploy.ds.md (composes the above)
```

### Don't: Skip Validation Steps
```markdown
# ❌ Bad:
## Actions
1. Deploy to production
2. Done!
```

**Instead**: Always validate success
```markdown
# ✓ Good:
## Actions
1. Deploy to production
2. Wait 30s for containers to start
3. Run health checks
4. Verify metrics in DataDog
5. Check error rates

## Validation
- Health endpoint returns 200 OK
- All pods show READY state
- Error rate < 0.1% in last 5 min
```

### Don't: Assume Context
```markdown
# ❌ Bad: "Deploy the app to the server"
```

**Instead**: Be explicit about context gathering
```markdown
# ✓ Good:
## Context to Gather
- Check git branch (must be 'main')
- Read VERSION file
- Verify CI passed for current commit SHA
- Check staging environment status
```

---

## Success Metrics

Track these to measure dossier adoption success:

### For Solo Devs
- Time saved on repetitive tasks
- Number of dossiers created and reused
- Reduction in "how do I do X again?" moments

### For OSS Maintainers
- Contributor onboarding time reduced
- Fewer "how do I..." issues filed
- More consistent contributions (follow the dossier)

### For Platform Teams
- Reduced deployment errors (validation catches issues)
- Faster incident response (rollback dossiers ready)
- Better audit trail (dossier execution logs)
- Reduced tribal knowledge (workflows documented)

---

## Getting Help

- Read the [Quick Start Guide](../getting-started/installation.md) for step-by-step guidance
- Check [examples/](../../examples/) for more dossier patterns
- Review [FAQ.md](../explanation/faq.md) for common questions
- See [SPECIFICATION.md](../reference/specification.md) for formal dossier structure
- Visit the [security/](../security/) directory for security best practices
