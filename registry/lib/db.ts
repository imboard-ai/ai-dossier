import { neon } from '@neondatabase/serverless';

// DATABASE_URL is set automatically by the Vercel-Neon integration.
// POSTGRES_URL is a legacy fallback some older integrations use.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString && process.env.NODE_ENV !== 'test') {
  throw new Error('DATABASE_URL (or POSTGRES_URL) must be set');
}

export const sql = connectionString ? neon(connectionString) : (null as never);
