import { Client } from '@neondatabase/serverless';
import { passwordHash, databaseUrl, normalizedEmail } from './admin-password.mjs';
const url = databaseUrl();
const email = normalizedEmail();
const password = await passwordHash();
const { TENANT_NAME: tenantName, SITE_NAME: siteName } = process.env;
if (!tenantName?.trim() || !siteName?.trim()) throw new Error('TENANT_NAME and SITE_NAME are required');
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('papo-superadmin-bootstrap',0))");
  if ((await client.query('SELECT 1 FROM admin_users LIMIT 1')).rowCount)
    throw new Error('Superadmin bootstrap already completed; no changes made');
  const tenant = (await client.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [tenantName.trim()])).rows[0];
  const site = (await client.query('INSERT INTO sites(tenant_id,name) VALUES($1,$2) RETURNING id', [tenant.id, siteName.trim()])).rows[0];
  await client.query("INSERT INTO admin_users(email,role,password_hash) VALUES($1,'superadmin',$2)", [email, password]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ tenant_id: tenant.id, site_id: site.id }));
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
