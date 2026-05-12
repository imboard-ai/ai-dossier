# Dossier Trace Deployment Models

**Version**: 1.0.1  
**Status**: Stable  

---

## Overview

Dossier Tracing supports **three deployment models** to accommodate different use cases:

1. **Local Mode**: Solo developers (no server needed)
2. **Team Server**: Organizations with self-hosted server
3. **SaaS Mode**: Multi-tenant managed service

---

## Deployment Models

### 1. Local Mode (Solo Developer)

**Use Case**: Individual developer, personal projects, no team collaboration needed

**Architecture**:
```
Agent → Local SQLite file → Done
(No server, no network calls)
```

**Configuration**:
```bash
export TRACE_MODE=local
export TRACE_DB_PATH=~/.dossier/traces.db
```

**Pros**:
- ✅ Zero setup (no server to deploy)
- ✅ Fast (no network latency)
- ✅ Private (data never leaves your machine)
- ✅ Free (no hosting costs)

**Cons**:
- ❌ No team visibility
- ❌ No remote access
- ❌ Limited to single machine

**When to Use**:
- Solo developer
- Personal projects
- Learning/experimentation
- Offline work

---

### 2. Team Server (Organization)

**Use Case**: Development team or organization, shared visibility and compliance

**Architecture**:
```
Dev 1's Agent ─┐
Dev 2's Agent ─┼→ Team Trace Server → Organization Database
Dev 3's Agent ─┘
CI/CD Pipeline┘
```

**Configuration**:
```bash
export TRACE_MODE=server
export TRACE_SERVER_URL=https://traces.company.com/api/v1
export TRACE_API_KEY=team-shared-api-key
```

**Deployment**:
```bash
# Deploy once for entire team
cd trace-server
export API_KEY=$(openssl rand -hex 32)
docker-compose up -d
```

**Pros**:
- ✅ Centralized visibility (all team traces)
- ✅ Compliance/auditing (organization-wide)
- ✅ Team analytics (performance, success rates)
- ✅ Customer-deployed (privacy, control)
- ✅ Shared debugging (review each other's traces)

**Cons**:
- ⚠️ Requires server deployment
- ⚠️ Network dependency

**When to Use**:
- Development team (2+ developers)
- Organization with compliance requirements
- Shared infrastructure projects
- CI/CD integration needed

**Access Control**:
```bash
# Option 1: Shared API key (simple)
TRACE_API_KEY=team-key-for-everyone

# Option 2: Per-user API keys (better)
TRACE_API_KEY=yuval-api-key-abc123
TRACE_USER=yuval  # Logged with each trace

# Option 3: OAuth2 (enterprise)
TRACE_AUTH_TYPE=oauth2
TRACE_TOKEN=$(get-oauth-token)
```

---

### 3. SaaS Mode (Multi-Tenant Service)

**Use Case**: Multiple organizations on managed infrastructure (future)

**Architecture**:
```
Org A Agents ─┐
Org B Agents ─┼→ Multi-Tenant SaaS → Isolated Tenant DBs
Org C Agents ─┘
```

**Configuration**:
```bash
export TRACE_MODE=saas
export TRACE_SERVER_URL=https://traces.dossier.ai/api/v1
export TRACE_API_KEY=org-specific-api-key
export TRACE_TENANT_ID=company-xyz
```

**Pros**:
- ✅ Zero deployment (managed service)
- ✅ Automatic scaling
- ✅ High availability
- ✅ Managed backups
- ✅ Pay-as-you-go pricing

**Cons**:
- ⚠️ Data hosted by third party
- ⚠️ Subscription cost
- ⚠️ Internet dependency

**When to Use**:
- Don't want to manage infrastructure
- Need high availability/scaling
- Multi-region requirements
- Prefer SaaS pricing model

**Status**: Planned (not yet available)

---

## Configuration Examples

### Solo Developer (Local Mode)

```bash
# ~/.bashrc or ~/.zshrc
export TRACE_MODE=local
export TRACE_DB_PATH=~/.dossier/traces.db
```

**Usage**:
```javascript
// Agent automatically uses local mode
const trace = await startTrace({
  dossier: { title: 'My Dossier', version: '1.0.0' }
});
// Writes to ~/.dossier/traces.db
```

**View Traces**:
```bash
# CLI tool (future)
dossier trace list
dossier trace show 550e8400-...

# Or direct SQLite query
sqlite3 ~/.dossier/traces.db "SELECT * FROM traces"
```

---

### Small Team (Team Server)

**Setup** (one-time):
```bash
# Deploy on team server
ssh team-server.company.com
cd /opt/dossier-trace-server
export API_KEY=$(openssl rand -hex 32)
docker-compose up -d

# Share API key with team (e.g., in 1Password, Vault)
echo $API_KEY
```

**Each Developer**:
```bash
# ~/.bashrc or ~/.zshrc
export TRACE_MODE=server
export TRACE_SERVER_URL=https://traces.company.com/api/v1
export TRACE_API_KEY=shared-team-key  # From 1Password
```

**CI/CD**:
```yaml
# .github/workflows/deploy.yml
env:
  TRACE_MODE: server
  TRACE_SERVER_URL: ${{ secrets.TRACE_SERVER_URL }}
  TRACE_API_KEY: ${{ secrets.TRACE_API_KEY }}
```

---

### Large Organization (Team Server + Per-User Keys)

**Admin Setup**:
```bash
# Create API keys for each user
curl -X POST https://traces.company.com/admin/api-keys \
  -H "Admin-Token: $ADMIN_TOKEN" \
  -d '{"user": "yuval", "permissions": ["read", "write"]}'
# Returns: yuval-key-abc123

curl -X POST https://traces.company.com/admin/api-keys \
  -d '{"user": "luca", "permissions": ["read", "write"]}'
# Returns: luca-key-def456
```

**Each Developer**:
```bash
# ~/.bashrc
export TRACE_MODE=server
export TRACE_SERVER_URL=https://traces.company.com/api/v1
export TRACE_API_KEY=yuval-key-abc123  # Unique per user
export TRACE_USER=yuval  # Logged with each trace
```

**Benefits**:
- Track who executed each Dossier
- Per-user permissions
- Audit trail shows user
- Can revoke individual keys

---

## Migration Between Modes

### Local → Team Server

**Export local traces**:
```bash
# Export from local SQLite
sqlite3 ~/.dossier/traces.db ".dump" > traces-export.sql

# Import to team server
psql $TEAM_DB_URL < traces-export.sql
```

**Or programmatic sync**:
```bash
# Sync local traces to team server
dossier trace sync --from=local --to=server
```

### Team Server → SaaS (when available)

**Migration tool**:
```bash
# Migrate to SaaS
dossier trace migrate \
  --from-server=https://traces.company.com \
  --from-key=$OLD_KEY \
  --to-saas=https://traces.dossier.ai \
  --to-key=$SAAS_KEY
```

---

## Comparison Matrix

| Feature | Local Mode | Team Server | SaaS Mode |
|---------|------------|-------------|-----------|
| **Setup** | None | Deploy server | Sign up |
| **Cost** | Free | Infrastructure | Subscription |
| **Privacy** | 100% local | Customer-hosted | Third-party hosted |
| **Team Visibility** | ❌ No | ✅ Yes | ✅ Yes |
| **Compliance** | N/A | Customer-controlled | Provider-certified |
| **Scaling** | Single machine | Customer-managed | Auto-scaling |
| **Network** | ❌ Not needed | ⚠️ Required | ⚠️ Required |
| **Backup** | Manual | Customer-managed | Automatic |
| **Support** | Community | Self-support | Vendor support |

---

## Recommendation by Use Case

### Solo Developer
**Recommended**: **Local Mode**
- Start with local mode (zero setup)
- Upgrade to team server if you start collaborating

### Startup (2-10 devs)
**Recommended**: **Team Server**
- Deploy once on shared infrastructure
- Use shared API key initially
- Migrate to per-user keys as you grow

### SMB (10-50 devs)
**Recommended**: **Team Server** with per-user keys
- Deploy on managed infrastructure (AWS, GCP)
- Per-user API keys for audit trail
- Integrate with SSO/OAuth2 (future)

### Enterprise (50+ devs)
**Recommended**: **Team Server** or **SaaS**
- Team Server: More control, compliance requirements
- SaaS: Less operational burden, faster time-to-value
- High availability deployment (Kubernetes)
- Integration with enterprise auth (LDAP, SAML)

---

## Implementation: Auto-Detection

The trace client should **auto-detect** mode:

```javascript
// Pseudo-code for trace client
function detectTraceMode() {
  if (process.env.TRACE_MODE === 'local' || !process.env.TRACE_SERVER_URL) {
    return 'local';  // Default to local if no server configured
  } else if (process.env.TRACE_TENANT_ID) {
    return 'saas';   // Multi-tenant SaaS
  } else {
    return 'server'; // Team server
  }
}

class TraceClient {
  constructor() {
    this.mode = detectTraceMode();
    
    if (this.mode === 'local') {
      const dbPath = process.env.TRACE_DB_PATH || '~/.dossier/traces.db';
      this.storage = new LocalSQLiteStorage(dbPath);
    } else {
      const serverURL = process.env.TRACE_SERVER_URL;
      const apiKey = process.env.TRACE_API_KEY;
      this.storage = new RemoteServerStorage(serverURL, apiKey);
    }
  }
  
  async createTrace(data) {
    return this.storage.create(data);
  }
}
```

---

## Updated Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│              DOSSIER TRACING ARCHITECTURE               │
└─────────────────────────────────────────────────────────┘

MODE 1: LOCAL (Solo Developer)
┌─────────────┐
│   Agent     │──→ ~/.dossier/traces.db
│ (Solo Dev)  │    (SQLite, no server)
└─────────────┘

MODE 2: TEAM SERVER (Organization)
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   Agent     │    │                  │    │             │
│  (Dev 1)    │───→│  Team Trace      │───→│   Org DB    │
└─────────────┘    │  Server          │    │ (PostgreSQL)│
┌─────────────┐    │                  │    └─────────────┘
│   Agent     │───→│ (Customer-       │
│  (Dev 2)    │    │  Deployed)       │
└─────────────┘    │                  │
┌─────────────┐    │  Shared          │
│   CI/CD     │───→│  Visibility      │
│  Pipeline   │    └──────────────────┘
└─────────────┘

MODE 3: SAAS (Multi-Tenant) [FUTURE]
┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│ Org A Agent │───→│                  │───→│  Tenant A   │
└─────────────┘    │  Multi-Tenant    │    │     DB      │
┌─────────────┐    │  SaaS Service    │    ├─────────────┤
│ Org B Agent │───→│                  │───→│  Tenant B   │
└─────────────┘    │  (Managed,       │    │     DB      │
┌─────────────┐    │   Isolated)      │    ├─────────────┤
│ Org C Agent │───→│                  │───→│  Tenant C   │
└─────────────┘    └──────────────────┘    │     DB      │
                                            └─────────────┘
```

---

## Next Steps

1. **Update trace client** to support auto-detection
2. **Add local SQLite storage** adapter
3. **Document mode selection** in TRACING.md
4. **Create CLI tool** for viewing local traces
5. **Plan SaaS offering** (future)

---

**Document Version**: 1.0.1  
**Last Updated**: 2026-05-12
