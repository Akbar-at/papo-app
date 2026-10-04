// Local integration server. It runs the production request handlers with
// persistent PGlite and filesystem-backed photo objects on loopback only.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Db } from '../src/db';
import { handle } from '../src/index';
import { ApiError, bearer, sha256, signedToken, type Env } from '../src/platform';
import { hashPassword } from '../src/auth';

type Seed = { tenant_id: string; site_id: string; booth_id: string; frame_version_id: string; device_credential: string; voucher_code: string; signing_key: string };
const randomHex = (bytes: number) => Array.from(randomBytes(bytes), value => value.toString(16).padStart(2, '0')).join('');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const stateDir = resolve(process.env.PHOTOBOOTH_DEV_DATA_DIR ?? join(root, '.local', 'api'));
const photosDir = join(stateDir, 'photos');
const seedPath = join(stateDir, 'credentials.json');
const adminPath = join(stateDir, 'admin.json');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const seed: Seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, 'utf8')) as Seed : {
  tenant_id: randomUUID(), site_id: randomUUID(), booth_id: randomUUID(), frame_version_id: randomUUID(),
  device_credential: randomHex(32), voucher_code: randomHex(16).toUpperCase(),
  signing_key: randomHex(32)
};
if (!existsSync(seedPath)) writeFileSync(seedPath, JSON.stringify(seed, null, 2), { mode: 0o600 });

const pg = new PGlite(join(stateDir, 'db'));
const env = {
  DATABASE_URL: 'postgresql://local:local@127.0.0.1/local', TOKEN_SIGNING_KEY: seed.signing_key,
  MAX_MEDIA_BYTES: '20000000', APP_ENV: 'local'
} as Env;
const objectPath = (key: string) => {
  const candidate = resolve(photosDir, key);
  if (!candidate.startsWith(`${photosDir}${sep}`)) throw new Error('Invalid photo key');
  return candidate;
};
env.PHOTOS = {
  async put(key: string, value: ArrayBuffer) {
    const path = objectPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, new Uint8Array(value));
    return {};
  },
  async get(key: string) {
    try { return { body: await readFile(objectPath(key)) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  },
  async delete(keys: string[]) { for (const key of keys) await rm(objectPath(key), { force: true }); }
} as unknown as R2Bucket;

env.ASSETS = { async fetch(request: Request) {
  const path = new URL(request.url).pathname;
  const names: Record<string,string> = { '/':'index.html', '/app.js':'app.js', '/styles.css':'styles.css' };
  const name = names[path];
  if (!name) return new Response('Not found', {status:404});
  const content = await readFile(join(root, 'apps/web', name));
  const mime = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
  return new Response(content, {headers:{'content-type':`${mime}; charset=utf-8`,'cache-control':'no-store'}});
}} as Fetcher;

async function initialize() {
  const installed = (await pg.query<{ name: string | null }>("SELECT to_regclass('public.tenants')::text AS name")).rows[0].name;
  if (!installed) {
    for (const file of ['001_session_core.sql', '002_superadmin.sql', '003_app_auth.sql'])
      await pg.exec(readFileSync(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    await pg.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [seed.tenant_id, 'Local development']);
    await pg.query('INSERT INTO sites(id,tenant_id,name) VALUES($1,$2,$3)', [seed.site_id, seed.tenant_id, 'Local development']);
    await pg.query("INSERT INTO booths(id,tenant_id,site_id,name,session_mode,device_token_sha256) VALUES($1,$2,$3,'Local booth','voucher',$4)",
      [seed.booth_id, seed.tenant_id, seed.site_id, await sha256(seed.device_credential)]);
    await pg.query('INSERT INTO frame_versions(id,tenant_id,name,manifest,manifest_sha256) VALUES($1,$2,$3,$4,$5)',
      [seed.frame_version_id, seed.tenant_id, 'Local frame', JSON.stringify({ slots: 3 }), await sha256(JSON.stringify({ slots: 3 }))]);
    await pg.query("SELECT * FROM publish_booth_configuration($1,ARRAY[$2]::uuid[],0,3,2,1,'{}'::jsonb)", [seed.booth_id, seed.frame_version_id]);
    await pg.query("INSERT INTO vouchers(tenant_id,booth_id,code_digest,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
      [seed.tenant_id, seed.booth_id, await signedToken(env, 'voucher', seed.voucher_code)]);
  }
  // Upgrade retained local state created before application authentication.
  if (!(await pg.query<{ name:string|null }>("SELECT to_regclass('public.admin_sessions')::text AS name")).rows[0].name)
    await pg.exec(readFileSync(new URL('../db/migrations/003_app_auth.sql', import.meta.url), 'utf8'));
  const adminSeed = existsSync(adminPath) ? JSON.parse(readFileSync(adminPath, 'utf8')) : {
    email: process.env.PAPO_ADMIN_EMAIL ?? 'admin@papo.local',
    password: process.env.PAPO_ADMIN_PASSWORD ?? randomHex(24)
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminSeed.email)) throw new Error('Invalid local admin email');
  const hasAdmin = (await pg.query('SELECT 1 FROM admin_users WHERE lower(email)=$1',[adminSeed.email.toLowerCase()])).rows.length;
  if (!hasAdmin) {
    await pg.query("INSERT INTO admin_users(email,role,password_hash) VALUES($1,'superadmin',$2)", [adminSeed.email.toLowerCase(), await hashPassword(adminSeed.password)]);
  }
  if (!existsSync(adminPath)) writeFileSync(adminPath, JSON.stringify(adminSeed,null,2), {mode:0o600});
}

const db = new Db(env, async (parts, ...values) => {
  let sql = parts[0]; values.forEach((_, i) => { sql += `$${i + 1}${parts[i + 1]}`; });
  return (await pg.query(sql, values)).rows as Record<string,unknown>[];
});

await initialize();
const port = Number(process.env.PORT ?? 8787);
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 25_000_000) { outgoing.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const host = incoming.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '')) { outgoing.writeHead(421).end(); return; }
    const request = new Request(`http://${host}${incoming.url ?? '/'}`, {
      method: incoming.method, headers: incoming.headers as HeadersInit,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    });
    let response: Response;
    if (incoming.method === 'POST' && incoming.url === '/v1/device/local-test-voucher') {
      const booth = await db.boothForToken(bearer(request));
      const code = randomHex(16).toUpperCase();
      await db.issueLocalTestVoucher(booth, await signedToken(env, 'voucher', code));
      response = Response.json({ code }, { status: 201, headers: { 'cache-control': 'no-store' } });
    } else response = await handle(request, env, db, incoming.socket.remoteAddress);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const part of response.body) outgoing.write(part);
    outgoing.end();
  } catch (error) {
    console.error('Local request failed:', error instanceof Error ? error.name : 'unknown');
    if (error instanceof ApiError) {
      outgoing.writeHead(error.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return;
    }
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: { code: 'local_server_error', message: 'Local request failed' } }));
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local API: http://127.0.0.1:${port}/healthz`);
  console.log(`Admin app: http://127.0.0.1:${port}/`);
  console.log(`Admin credentials: ${adminPath}`);
  console.log(`Local credentials: ${seedPath}`);
});

for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { server.close(async () => { await pg.close(); process.exit(0); }); });
