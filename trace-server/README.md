# Dossier Trace Server

**Version**: 1.0.0  
**License**: MIT

Reference implementation of the Dossier Trace Server for tracking agent execution.

## Overview

The Dossier Trace Server is a **customer-deployed service** for storing and retrieving execution traces. Each organization runs their own trace server for privacy, compliance, and data isolation.

### Why Customer-Deployed?

- **Privacy**: Sensitive execution data stays within your infrastructure
- **Compliance**: Meet GDPR, SOC 2, and industry-specific requirements
- **Control**: Full control over data retention and access
- **Customization**: Adapt storage backend and authentication to your needs

---

## Quick Start

### Docker Compose (Recommended)

```bash
# Set your API key
export API_KEY="your-secure-api-key-here"

# Start the server
docker-compose up -d

# Check health
curl http://localhost:3000/health
```

### Node.js

```bash
# Install dependencies
npm install

# Set configuration
export API_KEY="your-secure-api-key"
export DB_PATH="./traces.db"
export PORT="3000"

# Start server
npm start
```

---

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `API_KEY` | API key for authentication | `dev-api-key` | Yes (prod) |
| `PORT` | Server port | `3000` | No |
| `DB_PATH` | SQLite database path | `./traces.db` | No |
| `NODE_ENV` | Environment (`development`, `production`) | `development` | No |

### Example `.env` File

```env
API_KEY=your-secure-random-api-key-here
PORT=3000
DB_PATH=/data/traces.db
NODE_ENV=production
```

---

## API Usage

### Authentication

All API requests require an API key:

```bash
curl -H "X-API-Key: your-api-key" \
  https://traces.your-company.com/api/v1/traces
```

### Create a Trace

```bash
curl -X POST http://localhost:3000/api/v1/traces \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "dossier": {
      "title": "Deploy to AWS",
      "version": "1.0.0"
    },
    "agent": {
      "name": "Claude Code",
      "version": "claude-sonnet-4-6"
    },
    "environment": {
      "user": "yuval",
      "hostname": "macbook-pro"
    },
    "started_at": "2026-05-12T10:30:00Z",
    "status": "running"
  }'
```

### Append a Step

```bash
curl -X POST http://localhost:3000/api/v1/traces/550e8400-e29b-41d4-a716-446655440000/steps \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "step_id": "step_001",
    "timestamp": "2026-05-12T10:30:15Z",
    "type": "prerequisite_check",
    "dossier_section": "Prerequisites / Check AWS CLI",
    "description": "Verified AWS CLI is installed",
    "action": {
      "type": "command",
      "command": "aws sts get-caller-identity"
    },
    "result": {
      "status": "success",
      "exit_code": 0
    }
  }'
```

### Get a Trace

```bash
curl http://localhost:3000/api/v1/traces/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: your-api-key"
```

### List Traces

```bash
curl "http://localhost:3000/api/v1/traces?dossier=Deploy%20to%20AWS&status=success&limit=10" \
  -H "X-API-Key: your-api-key"
```

---

## Deployment

### Production Deployment (Docker)

1. **Create a secure API key**:
   ```bash
   openssl rand -hex 32
   ```

2. **Create `docker-compose.prod.yml`**:
   ```yaml
   version: '3.8'
   services:
     trace-server:
       image: dossier/trace-server:1.0.0
       ports:
         - "3000:3000"
       environment:
         - API_KEY=${API_KEY}
         - DB_PATH=/data/traces.db
         - NODE_ENV=production
       volumes:
         - /path/to/data:/data
       restart: always
   ```

3. **Deploy**:
   ```bash
   docker-compose -f docker-compose.prod.yml up -d
   ```

### Kubernetes Deployment

See [`k8s/deployment.yaml`](./k8s/deployment.yaml) for Kubernetes manifests.

### Behind a Reverse Proxy (HTTPS)

**Nginx**:
```nginx
server {
    listen 443 ssl;
    server_name traces.your-company.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Storage Backends

The reference implementation uses **SQLite** for simplicity. For production, consider:

### PostgreSQL (Recommended for Production)

```javascript
// Modify src/index.js to use PostgreSQL
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
```

### MongoDB

```javascript
// Modify src/index.js to use MongoDB
import { MongoClient } from 'mongodb';
const client = new MongoClient(process.env.MONGODB_URL);
```

### Amazon S3 (for archival)

```javascript
// Archive old traces to S3
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
```

---

## Monitoring

### Prometheus Metrics (Future)

```
# Coming soon: /metrics endpoint
trace_server_traces_created_total 127
trace_server_traces_by_status{status="success"} 115
trace_server_http_requests_total{method="POST"} 127
```

### Logs

Logs are written to stdout/stderr. Use a log aggregation service:

```bash
# With Docker Compose
docker-compose logs -f trace-server

# With Kubernetes
kubectl logs -f deployment/trace-server
```

---

## Security

### API Key Management

**Generate secure keys**:
```bash
# 256-bit random key
openssl rand -hex 32
```

**Rotate keys**:
1. Generate new key
2. Update `API_KEY` environment variable
3. Restart server
4. Update clients with new key

### HTTPS

**Required in production**. Use:
- Reverse proxy (Nginx, Apache, Caddy)
- Cloud load balancer (AWS ALB, GCP LB)
- Let's Encrypt certificates

### Data Retention

Configure automatic deletion:

```javascript
// Example: Delete traces older than 90 days
setInterval(() => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  db.prepare('DELETE FROM traces WHERE started_at < ?')
    .run(cutoff.toISOString());
}, 24 * 60 * 60 * 1000); // Run daily
```

---

## Development

### Run Locally

```bash
npm install
npm run dev
```

### Run Tests

```bash
npm test
```

### Database Schema

The SQLite schema is created automatically on startup:

```sql
CREATE TABLE traces (
  trace_id TEXT PRIMARY KEY,
  dossier_title TEXT NOT NULL,
  dossier_version TEXT NOT NULL,
  agent_name TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  user TEXT,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trace_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY (trace_id) REFERENCES traces(trace_id) ON DELETE CASCADE
);
```

---

## Troubleshooting

### Server Won't Start

**Error**: `Error: SQLITE_CANTOPEN: unable to open database file`

**Solution**: Ensure DB_PATH directory exists and is writable:
```bash
mkdir -p $(dirname $DB_PATH)
chmod 755 $(dirname $DB_PATH)
```

### Authentication Fails

**Error**: `401 Unauthorized`

**Solution**: Check API key matches:
```bash
echo $API_KEY
# Should match the key in your curl command
```

### Out of Disk Space

**Solution**: Clean old traces:
```bash
sqlite3 traces.db "DELETE FROM traces WHERE started_at < date('now', '-90 days')"
sqlite3 traces.db "VACUUM"
```

---

## API Reference

See [TRACE_SERVER_API.md](../TRACE_SERVER_API.md) for complete API documentation.

---

## License

MIT License - see [LICENSE](../LICENSE) file.

---

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## Support

- **Documentation**: [TRACE_SERVER_API.md](../TRACE_SERVER_API.md)
- **Issues**: https://github.com/imboard-ai/dossier/issues
- **Discussions**: https://github.com/imboard-ai/dossier/discussions

---

**Last Updated**: 2026-05-12  
**Version**: 1.0.0
