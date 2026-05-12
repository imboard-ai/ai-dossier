# Dossier Execution Tracing

**Version**: 1.0.0  
**Status**: Stable  
**Last Updated**: 2026-05-12

---

## Overview

**Dossier Tracing** solves a critical problem: **How do you verify that an agent actually followed the Dossier specification during execution?**

Without tracing, you only know the final outcome. With tracing, you have a complete audit trail showing every step the agent took, every decision it made, and how closely it followed the Dossier.

### The Problem

When an LLM agent executes a Dossier:
- ❌ No record of what steps were actually performed
- ❌ Can't verify spec compliance
- ❌ Difficult to debug failures
- ❌ No audit trail for compliance/security
- ❌ Can't analyze agent behavior over time

### The Solution

**Execution Traces** provide:
- ✅ Complete step-by-step record of execution
- ✅ Verification that agent followed the Dossier spec
- ✅ Debugging information (commands, outputs, errors)
- ✅ Compliance audit trail
- ✅ Analytics on agent performance and behavior

---

## Architecture

```
┌──────────────┐
│    Agent     │
│   (Claude)   │
└──────┬───────┘
       │ 1. Start execution
       │ 2. Log steps in real-time
       │ 3. Complete trace
       ▼
┌─────────────────────┐
│  Trace Client Lib   │
│  (in agent code)    │
└──────────┬──────────┘
           │ HTTPS/REST
           ▼
┌──────────────────────┐
│   Trace Server       │
│ (Customer-Deployed)  │
│                      │
│ - Stores traces      │
│ - Provides API       │
│ - Privacy/compliance │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│     Storage          │
│  (SQLite/PostgreSQL) │
└──────────────────────┘
```

---

## Quick Start

### 1. Deploy Trace Server

Each customer deploys their own trace server for privacy:

```bash
cd trace-server
export API_KEY=$(openssl rand -hex 32)
docker-compose up -d
```

**Why customer-deployed?**
- Privacy: Execution data stays in your infrastructure
- Compliance: Meet GDPR, SOC 2, industry requirements
- Control: Your data, your retention policies

### 2. Configure Agent

Set trace server URL in agent configuration:

```bash
export DOSSIER_TRACE_SERVER="https://traces.your-company.com/api/v1"
export DOSSIER_TRACE_API_KEY="your-api-key"
```

### 3. Execute Dossier with Tracing

When an agent executes a Dossier, it automatically logs to the trace server:

```javascript
import { DossierExecutor } from '@dossier/executor';

const executor = new DossierExecutor({
  traceServer: process.env.DOSSIER_TRACE_SERVER,
  traceApiKey: process.env.DOSSIER_TRACE_API_KEY
});

// Execute Dossier (tracing happens automatically)
await executor.execute('deploy-to-aws.md');
```

---

## What Gets Traced?

### Trace Components

A complete execution trace includes:

1. **Metadata**
   - Trace ID (UUID)
   - Dossier info (title, version, file path)
   - Agent info (name, version, session ID)
   - Environment (user, hostname, working directory)
   - Timestamps (start, end, duration)

2. **Execution Steps**
   - Each action the agent performed
   - Dossier section being executed
   - Commands run, files modified, API calls made
   - Results (success/failure, output, exit codes)
   - Duration of each step

3. **Deviations**
   - When agent deviated from Dossier spec
   - What was expected vs. what actually happened
   - Reason for deviation
   - Who approved it (user, agent, automatic)

4. **Validation**
   - Success criteria from Dossier
   - Whether each criterion passed/failed
   - Verification commands that were run
   - Overall validation result

5. **Outputs**
   - Files created or modified
   - Configuration values produced
   - Artifacts generated (scripts, logs, reports)
   - Checksums for verification

6. **Errors**
   - Any errors encountered
   - Stack traces
   - Recovery actions taken

---

## Trace Schema

### Minimal Trace Example

```json
{
  "trace_schema_version": "1.0.0",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "dossier": {
    "title": "Deploy to AWS",
    "version": "1.0.0",
    "file_path": "/path/to/deploy-to-aws.md"
  },
  "agent": {
    "name": "Claude Code",
    "version": "claude-sonnet-4-6"
  },
  "environment": {
    "user": "yuval",
    "hostname": "macbook-pro",
    "working_directory": "/Users/yuval/projects/myapp"
  },
  "started_at": "2026-05-12T10:30:00Z",
  "completed_at": "2026-05-12T10:45:30Z",
  "duration_ms": 930000,
  "status": "success",
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
    },
    {
      "step_id": "step_002",
      "timestamp": "2026-05-12T10:31:00Z",
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
  ],
  "validation": {
    "performed": true,
    "success_criteria": [
      {
        "criterion": "Infrastructure deployed successfully",
        "result": "pass",
        "verification_command": "terraform show"
      }
    ],
    "overall_result": "pass"
  },
  "metrics": {
    "total_steps": 12,
    "successful_steps": 12,
    "failed_steps": 0,
    "commands_executed": 25
  }
}
```

See [`trace-schema.json`](./trace-schema.json) for complete schema definition.

---

## Use Cases

### 1. Compliance & Auditing

**Scenario**: Your organization requires audit trails for all infrastructure changes.

**Solution**: Execution traces provide:
- Complete record of what was done
- Who initiated it (user)
- When it happened (timestamps)
- What commands were executed
- What changed (files, configuration)

**Example Query**:
```bash
# Get all production deployments in the last 30 days
curl "https://traces.company.com/api/v1/traces?dossier=Deploy%20to%20AWS&from=2026-04-12T00:00:00Z&tags=production" \
  -H "X-API-Key: $API_KEY"
```

### 2. Debugging Failures

**Scenario**: A Dossier execution failed, and you need to understand why.

**Solution**: Trace shows:
- Exact step where failure occurred
- Command that failed
- Error message and exit code
- Previous successful steps (for context)

**Example**:
```bash
# Get failed trace
curl "https://traces.company.com/api/v1/traces/550e8400-e29b-41d4-a716-446655440000" \
  -H "X-API-Key: $API_KEY"
```

Response shows:
```json
{
  "status": "failed",
  "steps": [
    {
      "step_id": "step_005",
      "result": {
        "status": "failed",
        "exit_code": 1,
        "error": "Error: EACCES: permission denied, open '/etc/config'"
      }
    }
  ]
}
```

### 3. Spec Compliance Verification

**Scenario**: You want to verify the agent followed the Dossier specification.

**Solution**: Compare trace steps to Dossier sections:

```javascript
// Pseudo-code for compliance checking
const dossier = loadDossier('deploy-to-aws.md');
const trace = await traceClient.getTrace(traceId);

const coverage = analyzeCoverage(dossier, trace);
// coverage = {
//   "Prerequisites": "100% - all checks performed",
//   "Step 1": "100% - completed",
//   "Step 2": "100% - completed",
//   "Validation": "100% - all criteria checked"
// }
```

### 4. Performance Analysis

**Scenario**: Optimize Dossier execution time.

**Solution**: Analyze trace metrics:

```bash
# Get statistics
curl "https://traces.company.com/api/v1/traces/stats?dossier=Deploy%20to%20AWS" \
  -H "X-API-Key: $API_KEY"
```

Response:
```json
{
  "total_executions": 127,
  "average_duration_ms": 125000,
  "by_status": {
    "success": 115,
    "failed": 12
  },
  "success_rate": 0.905
}
```

Identify slow steps:
```json
{
  "steps": [
    {
      "dossier_section": "Step 3: Deploy Infrastructure",
      "duration_ms": 45000  // 45 seconds - slow!
    }
  ]
}
```

### 5. Deviation Analysis

**Scenario**: Agent adapted the Dossier to project context. Was it appropriate?

**Solution**: Review deviations:

```json
{
  "deviations": [
    {
      "dossier_section": "Step 2: Build Docker Image",
      "type": "alternative_approach",
      "expected": "Use Dockerfile",
      "actual": "Used existing Docker image from ECR",
      "reason": "Project already had image built by CI/CD",
      "approved_by": "agent"
    }
  ]
}
```

---

## Integration with MCP Server

The Dossier MCP Server will include trace tools:

### `dossier.trace.start`

Start a new execution trace:

```json
{
  "name": "dossier.trace.start",
  "arguments": {
    "dossier_path": "/path/to/deploy-to-aws.md"
  }
}
```

Returns:
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "trace_url": "https://traces.company.com/api/v1/traces/550e8400..."
}
```

### `dossier.trace.log_step`

Log an execution step:

```json
{
  "name": "dossier.trace.log_step",
  "arguments": {
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "action",
    "dossier_section": "Step 3: Deploy",
    "action": {
      "type": "command",
      "command": "terraform apply"
    },
    "result": {
      "status": "success",
      "exit_code": 0
    }
  }
}
```

### `dossier.trace.complete`

Mark trace as complete:

```json
{
  "name": "dossier.trace.complete",
  "arguments": {
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "success",
    "validation_results": { ... }
  }
}
```

---

## Client Libraries

### Node.js

```bash
npm install @dossier/trace-client
```

```javascript
import { TraceClient } from '@dossier/trace-client';

const client = new TraceClient({
  baseURL: 'https://traces.company.com/api/v1',
  apiKey: process.env.TRACE_API_KEY
});

// Start trace
const trace = await client.createTrace({
  dossier: { title: 'Deploy to AWS', version: '1.0.0' },
  agent: { name: 'Claude Code', version: 'claude-sonnet-4-6' }
});

// Log steps
await client.appendStep(trace.trace_id, {
  type: 'action',
  description: 'Deploying infrastructure',
  action: { type: 'command', command: 'terraform apply' },
  result: { status: 'success' }
});

// Complete
await client.updateTrace(trace.trace_id, {
  status: 'success',
  completed_at: new Date().toISOString()
});
```

### Python

```bash
pip install dossier-trace-client
```

```python
from dossier_trace import TraceClient

client = TraceClient(
    base_url='https://traces.company.com/api/v1',
    api_key=os.environ['TRACE_API_KEY']
)

# Start trace
trace = client.create_trace({
    'dossier': {'title': 'Deploy to AWS', 'version': '1.0.0'},
    'agent': {'name': 'Claude Code', 'version': 'claude-sonnet-4-6'}
})

# Log steps
client.append_step(trace['trace_id'], {
    'type': 'action',
    'description': 'Deploying infrastructure',
    'action': {'type': 'command', 'command': 'terraform apply'},
    'result': {'status': 'success'}
})

# Complete
client.update_trace(trace['trace_id'], {
    'status': 'success',
    'completed_at': datetime.utcnow().isoformat() + 'Z'
})
```

---

## Best Practices

### 1. Log Real-Time

**Do**: Log steps as they happen
```javascript
await trace.logStep({ type: 'action', ... });
await executeCommand('terraform apply');
await trace.logStep({ type: 'action', result: { status: 'success' } });
```

**Don't**: Wait until end to log everything
```javascript
// ❌ Bad: lose data if agent crashes
steps.push({ ... });
steps.push({ ... });
await trace.updateTrace({ steps }); // only at end
```

### 2. Include Context

**Do**: Link steps to Dossier sections
```javascript
{
  "dossier_section": "Step 3: Deploy Infrastructure",
  "description": "Executing terraform apply"
}
```

**Don't**: Generic descriptions
```javascript
{
  "description": "Running command"  // ❌ Not helpful
}
```

### 3. Log Deviations

**Do**: Explain when you deviate from spec
```javascript
{
  "deviations": [{
    "expected": "Use Dockerfile to build image",
    "actual": "Used existing ECR image",
    "reason": "Image already built by CI/CD pipeline",
    "approved_by": "agent"
  }]
}
```

### 4. Validate Against Success Criteria

**Do**: Run verification commands from Dossier
```javascript
for (const criterion of dossier.validation.success_criteria) {
  const result = await runVerification(criterion);
  await trace.logValidation(criterion, result);
}
```

### 5. Set Retention Policies

**Do**: Automatically delete old traces
```bash
# Delete traces older than 90 days (compliance)
DELETE FROM traces WHERE started_at < date('now', '-90 days')
```

---

## Security & Privacy

### Customer-Deployed = Privacy

Traces stay in **your infrastructure**:
- No data sent to third parties
- You control access and retention
- Meets GDPR, SOC 2, HIPAA requirements

### Encryption

- **In Transit**: HTTPS/TLS (required in production)
- **At Rest**: Database encryption (optional, recommended)

### Access Control

- **API Keys**: Per-environment keys (dev, staging, prod)
- **OAuth2**: For user-specific tracing (future)
- **IP Allowlist**: Restrict access by IP (optional)

### Data Minimization

**Don't log sensitive data**:
- ❌ Passwords, API keys, secrets
- ❌ Personal data (unless necessary for audit)
- ❌ Full file contents (only paths/checksums)

**Do truncate large outputs**:
```javascript
{
  "result": {
    "output": output.substring(0, 1000) + '... (truncated)',
    "output_size_bytes": output.length
  }
}
```

---

## Future Enhancements

### Planned for v1.1+

1. **Real-Time Streaming**: WebSocket for live trace viewing
2. **Trace Analysis UI**: Web dashboard for viewing traces
3. **Anomaly Detection**: Flag unusual agent behavior
4. **Compliance Reports**: Auto-generate audit reports
5. **Trace Replay**: Re-execute a Dossier with same inputs
6. **Multi-Server Federation**: Aggregate traces across servers
7. **Prometheus Metrics**: Export trace metrics

---

## References

- **Trace Schema**: [`trace-schema.json`](./trace-schema.json)
- **Trace Server API**: [`TRACE_SERVER_API.md`](./TRACE_SERVER_API.md)
- **Trace Server Implementation**: [`trace-server/`](./trace-server/)
- **Dossier Schema**: [`SCHEMA.md`](./SCHEMA.md)
- **Dossier Specification**: [`SPECIFICATION.md`](./SPECIFICATION.md)

---

## Answering Luca's Question

> "I'm curious how are you keeping agent work tied back to the original spec once implementation starts?"

**Answer**: **Execution Traces**.

When an agent executes a Dossier:
1. It starts a trace linked to the Dossier (title, version, file path)
2. Each step logs which Dossier section it's implementing
3. Deviations are explicitly logged with reasoning
4. Validation runs Dossier's success criteria and logs results
5. Post-execution, you can:
   - Verify agent followed the spec
   - Review deviations and their justifications
   - Confirm all success criteria passed
   - Debug failures with complete context

**Privacy**: Each customer deploys their own trace server, so sensitive execution data stays within their infrastructure.

**Result**: Complete audit trail showing agent followed (or deviated from) the Dossier spec, with full reasoning and validation.

---

**Document Version**: 1.0.0  
**Trace Schema Version**: 1.0.0  
**License**: Same as Dossier project
