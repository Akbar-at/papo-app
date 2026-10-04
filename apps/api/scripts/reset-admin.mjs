// Controlled account recovery; no password or token is printed.
import { Client } from '@neondatabase/serverless';
import { passwordHash, databaseUrl, normalizedEmail } from './admin-password.mjs';
const client = new Client({ connectionString: databaseUrl() });
const email = normalizedEmail();
const hash = await passwordHash();
await client.connect();
try {
  await client.query('BEGIN');
  const result = await client.query('UPDATE admin_users SET password_hash=$1 WHERE lower(email)=$2 AND active=true RETURNING id', [hash, email]);
  if (result.rowCount !== 1) throw new Error('An active admin with that email was not found');
  await client.query('DELETE FROM admin_sessions WHERE admin_id=$1', [result.rows[0].id]);
  await client.query('COMMIT');
  console.log('Password updated and all sessions revoked.');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
