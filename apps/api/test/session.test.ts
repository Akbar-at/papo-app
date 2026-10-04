import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Db } from '../src/db';
import { handle } from '../src/index';
import { purgeExpiredMedia } from '../src/retention';
import { sha256, signedToken, type Env } from '../src/platform';

const tenant = '11111111-1111-4111-8111-111111111111';
const site = '22222222-2222-4222-8222-222222222222';
const booth = '33333333-3333-4333-8333-333333333333';
const frame = '44444444-4444-4444-8444-444444444444';
const client = '55555555-5555-4555-8555-555555555555';
const deviceToken = 'local-test-device-token-with-enough-entropy';

async function setup() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../db/migrations/001_session_core.sql', import.meta.url), 'utf8'));
  await pg.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenant, 'Test']);
  await pg.query('INSERT INTO sites (id,tenant_id,name) VALUES ($1,$2,$3)', [site, tenant, 'Test']);
  await pg.query("INSERT INTO booths (id,tenant_id,site_id,name,session_mode,event_tokens_remaining,device_token_sha256) VALUES ($1,$2,$3,'Test','event',1,$4)", [booth, tenant, site, await sha256(deviceToken)]);
  await pg.query("INSERT INTO frame_versions (id,tenant_id,name,manifest,manifest_sha256) VALUES ($1,$2,'Basic',$3,$4)", [frame, tenant, JSON.stringify({ slots: 3 }), 'a'.repeat(64)]);
  await pg.query("SELECT * FROM publish_booth_configuration($1,ARRAY[$2]::uuid[],0,3,2,1,'{}'::jsonb)", [booth, frame]);
  const env = { DATABASE_URL: 'postgresql://test:test@localhost/test', TOKEN_SIGNING_KEY: 'a-test-signing-key-with-at-least-32-characters' } as Env;
  const objects = new Map<string, Uint8Array>();
  env.PHOTOS = {
    async put(key: string, value: ArrayBuffer) { objects.set(key, new Uint8Array(value)); return {}; },
    async get(key: string) { const value = objects.get(key); return value ? { body: value } : null; },
    async delete(keys: string[]) { for (const key of keys) objects.delete(key); }
  } as unknown as R2Bucket;
  const db = new Db(env);
  (db as unknown as { sql: (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> }).sql = async (parts, ...values) => {
    let sql = parts[0];
    values.forEach((_, i) => { sql += `$${i + 1}${parts[i + 1]}`; });
    return (await pg.query(sql, values)).rows;
  };
  const call = async (method: string, path: string, data?: unknown, token = deviceToken) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (data !== undefined) headers['content-type'] = 'application/json';
    const response = await handle(new Request(`https://api.test${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }), env, db);
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { pg, db, env, call, objects };
}

test('voucher session prints while upload is pending; QR waits for delivery', async () => {
  const { pg, db, env, call, objects } = await setup();
  try {
    const page = await handle(new Request('https://api.test/test/booth'), { ...env, APP_ENV: 'local' }, db);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Run end-to-end session/);
    await pg.query("UPDATE booths SET session_mode='voucher' WHERE id=$1", [booth]);
    const voucherCode = 'PHOTO-SESSION-ONCE';
    await pg.query("INSERT INTO vouchers (tenant_id,booth_id,code_digest,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [tenant, booth, await signedToken(env, 'voucher', voucherCode)]);
    assert.equal((await call('GET', '/v1/device/frames', undefined, 'invalid-device-token')).status, 401);
    assert.equal((await call('GET', '/v1/device/frames')).data.frames[0].id, frame);
    const config = await call('GET', '/v1/device/configuration');
    assert.equal(config.data.first_photo_timer_seconds, 3);
    assert.equal(config.data.remaining_photo_timer_seconds, 2);
    assert.equal(config.data.retake_limit, 1);
    const ackId = crypto.randomUUID();
    assert.equal((await call('POST', '/v1/device/config-applied', { event_id: ackId, version: 1, status: 'applied' })).status, 200);
    assert.equal((await call('POST', '/v1/device/config-applied', { event_id: ackId, version: 1, status: 'applied' })).status, 200);
    const input = { client_session_id: client, authorization: { kind: 'voucher', code: voucherCode } };
    const created = await call('POST', '/v1/device/sessions', input);
    assert.equal(created.status, 201);
    const id = created.data.session_id as string;
    await pg.query("SELECT * FROM publish_booth_configuration($1,ARRAY[$2]::uuid[],25000,5,4,2,'{\"iso\": 200}'::jsonb)", [booth, frame]);
    const nextConfig = await call('GET', '/v1/device/configuration');
    assert.equal(nextConfig.data.desired_version, 2);
    assert.equal(nextConfig.data.price_idr, 25000);
    assert.equal(nextConfig.data.camera_settings.iso, 200);
    assert.equal((await call('POST', '/v1/device/sessions', input)).data.session_id, id);
    assert.equal((await pg.query<{ event_tokens_remaining: number }>('SELECT event_tokens_remaining FROM booths WHERE id=$1', [booth])).rows[0].event_tokens_remaining, 1);
    assert.equal((await call('POST', '/v1/device/sessions', { ...input, client_session_id: '66666666-6666-4666-8666-666666666666' })).status, 403);
    const capture = { event_id: '77777777-7777-4777-8777-777777777777', photo_count: 3 };
    assert.equal((await call('POST', `/v1/device/sessions/${id}/capture`, capture)).status, 409);
    assert.equal((await call('PUT', `/v1/device/sessions/${id}/frame`, { frame_version_id: frame })).status, 200);
    assert.equal((await call('POST', `/v1/device/sessions/${id}/capture`, capture)).status, 200);
    const print = { event_id: '88888888-8888-4888-8888-888888888888', client_job_id: '99999999-9999-4999-8999-999999999999', status: 'confirmed', occurred_at: new Date().toISOString() };
    assert.equal((await call('POST', `/v1/device/sessions/${id}/prints`, print)).status, 201);
    assert.equal((await call('POST', `/v1/device/sessions/${id}/prints`, print)).status, 201);
    assert.equal((await call('POST', `/v1/device/sessions/${id}/finalize`)).status, 409);
    for (const [kind, mime, bytes] of [['composite', 'image/jpeg', new Uint8Array([255,216,255,217])], ['gif', 'image/gif', new TextEncoder().encode('GIF89a')]] as const) {
      const intent = await call('POST', `/v1/device/sessions/${id}/media-uploads`, { kind, content_type: mime, byte_size: bytes.length, sha256: await sha256(bytes.buffer) });
      assert.equal(intent.status, 200);
      assert.equal((await handle(new Request(intent.data.upload_url, { method: 'PUT', headers: { 'content-type': mime }, body: bytes }), env, db)).status, 204);
    }
    const finalized = await call('POST', `/v1/device/sessions/${id}/finalize`);
    assert.equal(finalized.status, 200);
    const overview = await call('GET', '/v1/device/overview');
    assert.equal(overview.data.booth.id, booth);
    assert.equal(overview.data.sessions[0].id, id);
    assert.equal(overview.data.sessions[0].share_url, finalized.data.share_url);
    assert.equal(overview.data.sessions[0].composite_uploaded, true);
    assert.equal(overview.data.sessions[0].gif_uploaded, true);
    assert.equal(overview.data.sessions[0].print_confirmed, true);
    assert.equal((await call('GET', '/v1/device/overview', undefined, 'invalid-device-token')).status, 401);
    assert.equal((await call('POST', `/v1/device/sessions/${id}/finalize`)).data.share_url, finalized.data.share_url);
    assert.equal((await call('GET', new URL(finalized.data.share_url).pathname)).data.media.length, 2);
    assert.ok(new Date(finalized.data.share_expires_at).getTime() > Date.now() + 29 * 86_400_000);
    await pg.query("UPDATE media_uploads SET retention_at=now()-interval '1 minute' WHERE session_id=$1", [id]);
    assert.equal(await purgeExpiredMedia(env, db), 2);
    assert.equal(objects.size, 0);
    assert.equal((await pg.query<{count:number}>('SELECT count(*)::int AS count FROM media_uploads WHERE deleted_at IS NOT NULL')).rows[0].count, 2);
    assert.equal((await call('POST', '/v1/device/sessions', { client_session_id: crypto.randomUUID(), authorization: { kind: 'payment' } })).status, 503);
  } finally { await pg.close(); }
});

test('single-use voucher is atomic, retry-safe, and cannot authorize another session', async () => {
  const { pg, env, call } = await setup();
  try {
    await pg.query("UPDATE booths SET session_mode='voucher' WHERE id=$1", [booth]);
    assert.equal((await call('POST', '/v1/device/sessions', { client_session_id: crypto.randomUUID(), authorization: { kind: 'event' } })).status, 403);
    const code = 'ONE-TIME-CODE', digest = await signedToken(env, 'voucher', code);
    await pg.query("INSERT INTO vouchers (tenant_id,booth_id,code_digest,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [tenant, booth, digest]);
    const input = { client_session_id: client, authorization: { kind: 'voucher', code } };
    const first = await call('POST', '/v1/device/sessions', input);
    assert.equal(first.status, 201);
    assert.equal(first.data.mode, 'voucher');
    assert.equal((await call('POST', '/v1/device/sessions', input)).data.session_id, first.data.session_id);
    assert.equal((await call('POST', '/v1/device/sessions', { ...input, client_session_id: crypto.randomUUID() })).status, 403);
    assert.equal((await pg.query<{ count: number }>('SELECT count(*)::int AS count FROM sessions')).rows[0].count, 1);
  } finally { await pg.close(); }
});
