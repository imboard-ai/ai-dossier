# Dossier Trace Server API Specification

**Version**: 1.0.0  
**Status**: Stable  
**Last Updated**: 2026-05-12

---

## Overview

The **Dossier Trace Server** is a customer-deployed service for storing and retrieving execution traces. Each customer runs their own trace server for privacy, compliance, and data isolation.

### Key Principles

1. **Customer-Owned**: Each organization deploys their own trace server
2. **Privacy-First**: Sensitive execution data stays within customer infrastructure
3. **Simple REST API**: Easy to integrate with any agent
4. **Lightweight**: Minimal dependencies, easy to deploy
5. **Pluggable Storage**: Support for various backends (PostgreSQL, MongoDB, S3, etc.)

---

## Architecture

```
┌─────────────┐
│   Agent     │
│  (Claude)   │
└──────┬──────┘
       │ HTTPS
       │ POST /traces
       │ PATCH /traces/:id
       ▼
┌─────────────────────┐
│  Trace Server       │
│  (Customer-Deployed)│
│                     │
│  - REST API         │
│  - Authentication   │
│  - Storage Backend  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   Storage           │
│   (PostgreSQL/      │
│    MongoDB/S3/etc)  │
└─────────────────────┘
```

---

## API Endpoints

### Base URL

```
https://traces.your-company.com/api/v1
```

### Authentication

All requests require authentication via:
- **API Key** (Header: `X-API-Key: your-api-key`)
- **Bearer Token** (Header: `Authorization: Bearer token`)

---

## Endpoints

### 1. Create Trace

**POST** `/traces`

Create a new execution trace (called when agent starts executing a Dossier).

**Request Body**:
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "dossier": {
    "title": "Deploy to AWS",
    "version": "1.0.0",
    "file_path": "/path/to/deploy-to-aws.md",
    "objective": "Deploy application to AWS using Terraform"
  },
  "agent": {
    "name": "Claude Code",
    "version": "claude-sonnet-4-6",
    "session_id": "session_abc123"
  },
  "environment": {
    "user": "yuval",
    "hostname": "macbook-pro",
    "working_directory": "/Users/yuval/projects/myapp",
    "os": "darwin"
  },
  "started_at": "2026-05-12T10:30:00Z",
  "status": "running",
  "tags": ["production", "aws", "terraform"]
}
```

**Response** (201 Created):
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-05-12T10:30:00Z",
  "url": "/api/v1/traces/550e8400-e29b-41d4-a716-446655440000"
}
```

---

### 2. Update Trace

**PATCH** `/traces/:trace_id`

Update an existing trace (add steps, mark complete, add errors, etc.).

**Request Body** (partial update):
```json
{
  "status": "success",
  "completed_at": "2026-05-12T10:45:30Z",
  "duration_ms": 930000,
  "steps": [
    {
      "step_id": "step_001",
      "timestamp": "2026-05-12T10:30:15Z",
      "type": "prerequisite_check",
      "dossier_section": "Prerequisites / Check AWS CLI",
      "description": "Verified AWS CLI is installed and configured",
      "action": {
        "type": "command",
        "command": "aws sts get-caller-identity"
      },
      "result": {
        "status": "success",
        "output": "{\"UserId\": \"...\", \"Account\": \"123456789\"}",
        "exit_code": 0
      },
      "duration_ms": 1250
    }
  ],
  "validation": {
    "performed": true,
    "success_criteria": [
      {
        "criterion": "Infrastructure deployed successfully",
        "result": "pass",
        "verification_command": "terraform show",
        "timestamp": "2026-05-12T10:45:00Z"
      }
    ],
    "overall_result": "pass"
  },
  "metrics": {
    "total_steps": 12,
    "successful_steps": 12,
    "failed_steps": 0,
    "commands_executed": 25,
    "files_modified": 3
  }
}
```

**Response** (200 OK):
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "updated_at": "2026-05-12T10:45:30Z"
}
```

---

### 3. Append Step

**POST** `/traces/:trace_id/steps`

Append a single step to an existing trace (for real-time logging).

**Request Body**:
```json
{
  "step_id": "step_005",
  "timestamp": "2026-05-12T10:35:20Z",
  "type": "action",
  "dossier_section": "Step 3: Deploy Infrastructure",
  "description": "Executing terraform apply",
  "action": {
    "type": "command",
    "command": "terraform apply -auto-approve"
  },
  "result": {
    "status": "success",
    "output": "Apply complete! Resources: 15 added, 0 changed, 0 destroyed.",
    "exit_code": 0
  },
  "duration_ms": 45000
}
```

**Response** (201 Created):
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "step_id": "step_005",
  "step_number": 5
}
```

---

### 4. Get Trace

**GET** `/traces/:trace_id`

Retrieve a complete execution trace.

**Response** (200 OK):
```json
{
  "trace_schema_version": "1.0.0",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "dossier": { ... },
  "agent": { ... },
  "environment": { ... },
  "started_at": "2026-05-12T10:30:00Z",
  "completed_at": "2026-05-12T10:45:30Z",
  "duration_ms": 930000,
  "status": "success",
  "steps": [ ... ],
  "deviations": [ ... ],
  "validation": { ... },
  "outputs": { ... },
  "metrics": { ... }
}
```

---

### 5. List Traces

**GET** `/traces`

List execution traces with filtering and pagination.

**Query Parameters**:
- `dossier` - Filter by Dossier title (e.g., `?dossier=Deploy to AWS`)
- `status` - Filter by status (e.g., `?status=success`)
- `from` - Start date (ISO 8601, e.g., `?from=2026-05-01T00:00:00Z`)
- `to` - End date (ISO 8601)
- `user` - Filter by user (e.g., `?user=yuval`)
- `tags` - Filter by tags (e.g., `?tags=production,aws`)
- `limit` - Results per page (default: 50, max: 200)
- `offset` - Pagination offset

**Example**:
```
GET /traces?dossier=Deploy%20to%20AWS&status=success&limit=10
```

**Response** (200 OK):
```json
{
  "traces": [
    {
      "trace_id": "550e8400-e29b-41d4-a716-446655440000",
      "dossier": {
        "title": "Deploy to AWS",
        "version": "1.0.0"
      },
      "started_at": "2026-05-12T10:30:00Z",
      "completed_at": "2026-05-12T10:45:30Z",
      "status": "success",
      "duration_ms": 930000,
      "agent": {
        "name": "Claude Code",
        "version": "claude-sonnet-4-6"
      }
    },
    ...
  ],
  "pagination": {
    "total": 42,
    "limit": 10,
    "offset": 0,
    "next": "/traces?offset=10&limit=10"
  }
}
```

---

### 6. Delete Trace

**DELETE** `/traces/:trace_id`

Delete an execution trace (for data retention compliance).

**Response** (204 No Content)

---

### 7. Get Trace Statistics

**GET** `/traces/stats`

Get aggregate statistics across all traces.

**Query Parameters**:
- `from` - Start date
- `to` - End date
- `dossier` - Filter by Dossier
- `user` - Filter by user

**Response** (200 OK):
```json
{
  "period": {
    "from": "2026-05-01T00:00:00Z",
    "to": "2026-05-12T23:59:59Z"
  },
  "total_executions": 127,
  "by_status": {
    "success": 115,
    "failed": 10,
    "cancelled": 2
  },
  "by_dossier": {
    "Deploy to AWS": 45,
    "Database Migration": 30,
    "Setup React Library": 25,
    "Train ML Model": 27
  },
  "average_duration_ms": 125000,
  "total_commands_executed": 3825,
  "success_rate": 0.905
}
```

---

### 8. Health Check

**GET** `/health`

Health check endpoint (no authentication required).

**Response** (200 OK):
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_seconds": 86400,
  "storage": "connected"
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "validation_error",
  "message": "Invalid trace data",
  "details": {
    "field": "dossier.version",
    "issue": "Must be valid semver"
  }
}
```

### 401 Unauthorized
```json
{
  "error": "unauthorized",
  "message": "Invalid or missing API key"
}
```

### 404 Not Found
```json
{
  "error": "not_found",
  "message": "Trace not found",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 429 Too Many Requests
```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests",
  "retry_after": 60
}
```

### 500 Internal Server Error
```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred",
  "request_id": "req_abc123"
}
```

---

## Storage Backend Options

The reference implementation supports multiple storage backends:

### 1. PostgreSQL
- **Pros**: ACID transactions, rich querying, mature
- **Use case**: Production deployments

### 2. MongoDB
- **Pros**: Flexible schema, horizontal scaling
- **Use case**: High-volume environments

### 3. SQLite
- **Pros**: Zero configuration, embedded
- **Use case**: Development, small deployments

### 4. Amazon S3
- **Pros**: Unlimited storage, cheap
- **Use case**: Long-term archive, compliance

### 5. Filesystem
- **Pros**: Simple, no dependencies
- **Use case**: Development only

---

## Deployment

### Docker Compose (Recommended)

```yaml
version: '3.8'
services:
  trace-server:
    image: dossier/trace-server:1.0.0
    ports:
      - "3000:3000"
    environment:
      - API_KEY=your-secure-api-key
      - STORAGE_TYPE=postgresql
      - DATABASE_URL=postgresql://user:pass@db:5432/traces
    depends_on:
      - db
  
  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=traces
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - traces-data:/var/lib/postgresql/data

volumes:
  traces-data:
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trace-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: trace-server
  template:
    metadata:
      labels:
        app: trace-server
    spec:
      containers:
      - name: trace-server
        image: dossier/trace-server:1.0.0
        env:
        - name: API_KEY
          valueFrom:
            secretKeyRef:
              name: trace-server-secrets
              key: api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: trace-server-secrets
              key: database-url
        ports:
        - containerPort: 3000
```

---

## Security

### Authentication

**API Key** (simplest):
```bash
curl -H "X-API-Key: your-api-key" https://traces.your-company.com/api/v1/traces
```

**Bearer Token** (recommended for user-specific):
```bash
curl -H "Authorization: Bearer eyJhbGc..." https://traces.your-company.com/api/v1/traces
```

### TLS/HTTPS

- **Required** in production
- Use Let's Encrypt or your organization's certificates
- Minimum TLS 1.2

### Data Retention

Configure automatic deletion policies:

```env
# Delete traces older than 90 days
RETENTION_DAYS=90

# Archive to S3 before deletion
ARCHIVE_TO_S3=true
ARCHIVE_BUCKET=s3://company-traces-archive
```

---

## Client Libraries

### Node.js

```javascript
import { TraceClient } from '@dossier/trace-client';

const client = new TraceClient({
  baseURL: 'https://traces.your-company.com/api/v1',
  apiKey: process.env.TRACE_API_KEY
});

// Start trace
const trace = await client.createTrace({
  trace_id: uuid(),
  dossier: { title: 'Deploy to AWS', version: '1.0.0' },
  agent: { name: 'Claude Code', version: 'claude-sonnet-4-6' },
  status: 'running'
});

// Log step
await client.appendStep(trace.trace_id, {
  step_id: uuid(),
  type: 'action',
  description: 'Deploying infrastructure',
  action: { type: 'command', command: 'terraform apply' },
  result: { status: 'success' }
});

// Complete trace
await client.updateTrace(trace.trace_id, {
  status: 'success',
  completed_at: new Date().toISOString()
});
```

### Python

```python
from dossier_trace import TraceClient
import uuid
from datetime import datetime

client = TraceClient(
    base_url='https://traces.your-company.com/api/v1',
    api_key=os.environ['TRACE_API_KEY']
)

# Start trace
trace = client.create_trace({
    'trace_id': str(uuid.uuid4()),
    'dossier': {'title': 'Deploy to AWS', 'version': '1.0.0'},
    'agent': {'name': 'Claude Code', 'version': 'claude-sonnet-4-6'},
    'status': 'running'
})

# Log step
client.append_step(trace['trace_id'], {
    'step_id': str(uuid.uuid4()),
    'type': 'action',
    'description': 'Deploying infrastructure',
    'action': {'type': 'command', 'command': 'terraform apply'},
    'result': {'status': 'success'}
})

# Complete trace
client.update_trace(trace['trace_id'], {
    'status': 'success',
    'completed_at': datetime.utcnow().isoformat() + 'Z'
})
```

---

## Rate Limiting

Default rate limits (configurable):

- **Per API Key**: 1000 requests/minute
- **Per IP**: 10,000 requests/hour
- **Trace creation**: 100/minute
- **Step append**: 10,000/minute (high-volume logging)

---

## Monitoring

### Prometheus Metrics

Exposed at `/metrics`:

```
# Traces created
trace_server_traces_created_total 127

# Traces by status
trace_server_traces_by_status{status="success"} 115
trace_server_traces_by_status{status="failed"} 10

# Average trace duration
trace_server_trace_duration_seconds{quantile="0.5"} 125.0
trace_server_trace_duration_seconds{quantile="0.95"} 450.0

# API requests
trace_server_http_requests_total{method="POST",endpoint="/traces"} 127
trace_server_http_requests_total{method="GET",endpoint="/traces"} 542
```

---

## Compliance

### GDPR

- **Data Minimization**: Only store necessary execution data
- **Right to Erasure**: `DELETE /traces/:id` endpoint
- **Data Portability**: Export traces as JSON
- **Retention**: Automatic deletion after configurable period

### SOC 2

- **Audit Trail**: All API access logged
- **Encryption**: TLS in transit, encryption at rest
- **Access Control**: API key or OAuth2 authentication
- **Monitoring**: Prometheus metrics + logging

---

## Next Steps

1. Deploy reference implementation (see `/trace-server/` directory)
2. Configure storage backend
3. Set up authentication (API keys)
4. Integrate with MCP server
5. Test with example Dossier execution

---

**Document Version**: 1.0.0  
**Trace Schema Version**: 1.0.0  
**License**: Same as Dossier project
