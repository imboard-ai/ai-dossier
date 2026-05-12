#!/usr/bin/env node

/**
 * Dossier Trace Server - Reference Implementation
 *
 * A customer-deployed service for storing and retrieving execution traces.
 * Each organization runs their own trace server for privacy and compliance.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import Database from 'better-sqlite3';

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'dev-api-key-change-in-production';
const DB_PATH = process.env.DB_PATH || './traces.db';

// Initialize Express
const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
  message: { error: 'rate_limit_exceeded', message: 'Too many requests' }
});
app.use('/api/v1', limiter);

// Initialize Database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_traces_dossier ON traces(dossier_title);
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
  CREATE INDEX IF NOT EXISTS idx_traces_started_at ON traces(started_at);
  CREATE INDEX IF NOT EXISTS idx_traces_user ON traces(user);

  CREATE TABLE IF NOT EXISTS trace_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (trace_id) REFERENCES traces(trace_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_steps_trace_id ON trace_steps(trace_id);
`);

// Load and validate schema
const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '../../trace-schema.json');
const traceSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateTrace = ajv.compile(traceSchema);

// Authentication middleware
function authenticate(req, res, next) {
  const apiKey = req.header('X-API-Key') || req.header('Authorization')?.replace('Bearer ', '');

  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid or missing API key'
    });
  }

  next();
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime_seconds: process.uptime(),
      storage: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Create trace
app.post('/api/v1/traces', authenticate, (req, res) => {
  try {
    const trace = req.body;

    // Validate required fields
    if (!trace.trace_id || !trace.dossier || !trace.started_at || !trace.status) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Missing required fields: trace_id, dossier, started_at, status'
      });
    }

    // Check if trace already exists
    const existing = db.prepare('SELECT trace_id FROM traces WHERE trace_id = ?').get(trace.trace_id);
    if (existing) {
      return res.status(409).json({
        error: 'conflict',
        message: 'Trace already exists',
        trace_id: trace.trace_id
      });
    }

    // Insert trace
    const stmt = db.prepare(`
      INSERT INTO traces (
        trace_id, dossier_title, dossier_version, agent_name,
        started_at, completed_at, status, duration_ms, user, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      trace.trace_id,
      trace.dossier.title,
      trace.dossier.version,
      trace.agent?.name || null,
      trace.started_at,
      trace.completed_at || null,
      trace.status,
      trace.duration_ms || null,
      trace.environment?.user || null,
      JSON.stringify(trace)
    );

    res.status(201).json({
      trace_id: trace.trace_id,
      created_at: new Date().toISOString(),
      url: `/api/v1/traces/${trace.trace_id}`
    });
  } catch (error) {
    console.error('Error creating trace:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to create trace',
      details: error.message
    });
  }
});

// Update trace
app.patch('/api/v1/traces/:trace_id', authenticate, (req, res) => {
  try {
    const { trace_id } = req.params;
    const updates = req.body;

    // Get existing trace
    const row = db.prepare('SELECT data FROM traces WHERE trace_id = ?').get(trace_id);
    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Trace not found',
        trace_id
      });
    }

    // Merge updates
    const trace = { ...JSON.parse(row.data), ...updates };
    trace.trace_id = trace_id; // Ensure ID doesn't change

    // If steps are being added, store them separately
    if (updates.steps && Array.isArray(updates.steps)) {
      const stepStmt = db.prepare(`
        INSERT INTO trace_steps (trace_id, step_id, step_number, timestamp, type, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const existingSteps = db.prepare('SELECT COUNT(*) as count FROM trace_steps WHERE trace_id = ?')
        .get(trace_id).count;

      for (let i = 0; i < updates.steps.length; i++) {
        const step = updates.steps[i];
        stepStmt.run(
          trace_id,
          step.step_id,
          existingSteps + i + 1,
          step.timestamp,
          step.type,
          JSON.stringify(step)
        );
      }
    }

    // Update trace
    const stmt = db.prepare(`
      UPDATE traces
      SET dossier_title = ?, dossier_version = ?, agent_name = ?,
          started_at = ?, completed_at = ?, status = ?, duration_ms = ?,
          user = ?, data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE trace_id = ?
    `);

    stmt.run(
      trace.dossier.title,
      trace.dossier.version,
      trace.agent?.name || null,
      trace.started_at,
      trace.completed_at || null,
      trace.status,
      trace.duration_ms || null,
      trace.environment?.user || null,
      JSON.stringify(trace),
      trace_id
    );

    res.json({
      trace_id,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error updating trace:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to update trace',
      details: error.message
    });
  }
});

// Append step
app.post('/api/v1/traces/:trace_id/steps', authenticate, (req, res) => {
  try {
    const { trace_id } = req.params;
    const step = req.body;

    // Verify trace exists
    const trace = db.prepare('SELECT trace_id FROM traces WHERE trace_id = ?').get(trace_id);
    if (!trace) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Trace not found',
        trace_id
      });
    }

    // Get next step number
    const result = db.prepare('SELECT COALESCE(MAX(step_number), 0) + 1 as next_num FROM trace_steps WHERE trace_id = ?')
      .get(trace_id);
    const stepNumber = result.next_num;

    // Insert step
    const stmt = db.prepare(`
      INSERT INTO trace_steps (trace_id, step_id, step_number, timestamp, type, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      trace_id,
      step.step_id,
      stepNumber,
      step.timestamp || new Date().toISOString(),
      step.type,
      JSON.stringify(step)
    );

    res.status(201).json({
      trace_id,
      step_id: step.step_id,
      step_number: stepNumber
    });
  } catch (error) {
    console.error('Error appending step:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to append step',
      details: error.message
    });
  }
});

// Get trace
app.get('/api/v1/traces/:trace_id', authenticate, (req, res) => {
  try {
    const { trace_id } = req.params;

    // Get trace
    const row = db.prepare('SELECT data FROM traces WHERE trace_id = ?').get(trace_id);
    if (!row) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Trace not found',
        trace_id
      });
    }

    const trace = JSON.parse(row.data);

    // Get steps
    const steps = db.prepare('SELECT data FROM trace_steps WHERE trace_id = ? ORDER BY step_number')
      .all(trace_id)
      .map(row => JSON.parse(row.data));

    if (steps.length > 0) {
      trace.steps = steps;
    }

    res.json(trace);
  } catch (error) {
    console.error('Error getting trace:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to get trace',
      details: error.message
    });
  }
});

// List traces
app.get('/api/v1/traces', authenticate, (req, res) => {
  try {
    const {
      dossier,
      status,
      from,
      to,
      user,
      tags,
      limit = 50,
      offset = 0
    } = req.query;

    // Build query
    let sql = 'SELECT data FROM traces WHERE 1=1';
    const params = [];

    if (dossier) {
      sql += ' AND dossier_title = ?';
      params.push(dossier);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (from) {
      sql += ' AND started_at >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND started_at <= ?';
      params.push(to);
    }
    if (user) {
      sql += ' AND user = ?';
      params.push(user);
    }

    // Count total
    const countSql = sql.replace('SELECT data', 'SELECT COUNT(*) as total');
    const { total } = db.prepare(countSql).get(...params);

    // Get paginated results
    sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const rows = db.prepare(sql).all(...params);
    const traces = rows.map(row => {
      const trace = JSON.parse(row.data);
      // Return summary (not full trace with all steps)
      return {
        trace_id: trace.trace_id,
        dossier: trace.dossier,
        started_at: trace.started_at,
        completed_at: trace.completed_at,
        status: trace.status,
        duration_ms: trace.duration_ms,
        agent: trace.agent,
        environment: trace.environment
      };
    });

    const nextOffset = parseInt(offset, 10) + parseInt(limit, 10);
    const hasMore = nextOffset < total;

    res.json({
      traces,
      pagination: {
        total,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        next: hasMore ? `/api/v1/traces?offset=${nextOffset}&limit=${limit}` : null
      }
    });
  } catch (error) {
    console.error('Error listing traces:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to list traces',
      details: error.message
    });
  }
});

// Delete trace
app.delete('/api/v1/traces/:trace_id', authenticate, (req, res) => {
  try {
    const { trace_id } = req.params;

    const result = db.prepare('DELETE FROM traces WHERE trace_id = ?').run(trace_id);

    if (result.changes === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Trace not found',
        trace_id
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting trace:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to delete trace',
      details: error.message
    });
  }
});

// Get statistics
app.get('/api/v1/traces/stats', authenticate, (req, res) => {
  try {
    const { from, to, dossier, user } = req.query;

    let whereClause = '1=1';
    const params = [];

    if (from) {
      whereClause += ' AND started_at >= ?';
      params.push(from);
    }
    if (to) {
      whereClause += ' AND started_at <= ?';
      params.push(to);
    }
    if (dossier) {
      whereClause += ' AND dossier_title = ?';
      params.push(dossier);
    }
    if (user) {
      whereClause += ' AND user = ?';
      params.push(user);
    }

    // Total executions
    const { total } = db.prepare(`SELECT COUNT(*) as total FROM traces WHERE ${whereClause}`)
      .get(...params);

    // By status
    const statusRows = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM traces
      WHERE ${whereClause}
      GROUP BY status
    `).all(...params);

    const byStatus = {};
    statusRows.forEach(row => {
      byStatus[row.status] = row.count;
    });

    // By dossier
    const dossierRows = db.prepare(`
      SELECT dossier_title, COUNT(*) as count
      FROM traces
      WHERE ${whereClause}
      GROUP BY dossier_title
      ORDER BY count DESC
      LIMIT 10
    `).all(...params);

    const byDossier = {};
    dossierRows.forEach(row => {
      byDossier[row.dossier_title] = row.count;
    });

    // Average duration
    const { avg_duration } = db.prepare(`
      SELECT AVG(duration_ms) as avg_duration
      FROM traces
      WHERE ${whereClause} AND duration_ms IS NOT NULL
    `).get(...params);

    const successCount = byStatus.success || 0;
    const successRate = total > 0 ? successCount / total : 0;

    res.json({
      period: { from: from || null, to: to || null },
      total_executions: total,
      by_status: byStatus,
      by_dossier: byDossier,
      average_duration_ms: Math.round(avg_duration || 0),
      success_rate: Math.round(successRate * 1000) / 1000
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to get statistics',
      details: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'Endpoint not found',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'internal_error',
    message: 'An unexpected error occurred',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dossier Trace Server v1.0.0`);
  console.log(`📍 Listening on http://localhost:${PORT}`);
  console.log(`🔐 API Key: ${API_KEY.substring(0, 10)}...`);
  console.log(`💾 Database: ${DB_PATH}`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully');
  db.close();
  process.exit(0);
});
