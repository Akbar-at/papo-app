import { readFileSync } from 'node:fs';
import { Client } from '@neondatabase/serverless';

const url = process.env.NEON_DIRECT_DATABASE_URL;
const expectedName = process.env.APP_DATABASE_NAME;
if (!url || !expectedName || new URL(url).pathname !== `/${expectedName}`)
  throw new Error('NEON_DIRECT_DATABASE_URL and APP_DATABASE_NAME must match the intended application database');
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS app_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const file of ['001_session_core.sql', '002_superadmin.sql', '003_app_auth.sql']) {
    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('papo-app-migrations',0))");
      const existing = await client.query('SELECT 1 FROM app_migrations WHERE name=$1', [file]);
      if (!existing.rowCount) {
        await client.query(readFileSync(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
        await client.query('INSERT INTO app_migrations(name) VALUES($1)', [file]);
        console.log(`Applied ${file}`);
      } else console.log(`Already applied ${file}`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
